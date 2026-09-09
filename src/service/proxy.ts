// src/service/proxy.ts — 本地代办代理：iframe 经它访问 DSH，由它代示浏览器会话 cookie
// 纯模块：不依赖 vscode；仅用 node:http/node:net，便于 node:test 单测。
//
// 为什么需要它（方案 A 核心，背景见 service/session.ts 头注释）：
// DSH ≥0.1.2 的会话 cookie 是 SameSite=Strict，VS Code 面板 iframe（顶层
// vscode-webview://，跨站）永远不会回送它（真实 Chromium 三种顶层形态实测），
// 因此 DSH 网页无法在 iframe 里直连。代办把 iframe 的请求转发给真实 DSH，
// 并在转发时注入扩展持有的 cookie——页面无感、DSH 无感，会话由扩展全权代理。
//
// 职责与边界：
// - 只监听 127.0.0.1 随机端口（仅本机可达；与 dsh 自身 loopback 威胁面相同）；
// - HTTP 全透传：方法/路径/查询/请求体/响应体流式转发（上传大文件与 SSE 流不整包缓冲）；
// - 每次转发注入 Cookie 头（覆盖浏览器可能携带的无关 cookie）并重写 Host 头为
//   真实 DSH authority（服务端按 Host 校验 cookie 绑定关系）；
// - 剥离上游 set-cookie 响应头（iframe 里存 Strict cookie 无意义，且避免污染代理源 cookie）；
// - WebSocket 升级透传（DSH 事件下行若走 WS 也能工作）；
// - 目标未就绪（manager 未 ready）时返回 503 而不是挂起。
//
// 安全模型（重要，供维护者评估）：本代理把一个「已带 30 天会话 cookie 的 DSH API」暴露在
// 本机随机端口上，任意能连 127.0.0.1 的进程（含同机其他用户）都可驱动该会话——威胁面与
// DSH ≤0.1.1（127.0.0.1:3080 裸服务、无任何鉴权）相同或更窄（随机端口需先扫描），
// 不劣于被替代的旧架构；0.1.2 的鉴权主要防护对象是「网络暴露与跨站浏览器上下文」，
// 本代理未重新引入网络暴露。跨用户加固（每次激活的共享密钥/请求来源校验）如需可后续追加。
import http from 'node:http';
import type { Socket } from 'node:net';

/** 一次转发使用的上游目标（由调用方在每次请求前提供最新值） */
export interface ProxyTarget {
  /** 真实 DSH 地址（http://127.0.0.1:3080 或隧道可达地址） */
  url: string;
  /** 注入的 Cookie 头值（name=value；无鉴权的旧版 dsh 可省略=直通） */
  cookie?: string;
}

/** 代办依赖 */
export interface DshProxyDeps {
  /** 取当前转发目标；返回 null 时对请求回 503（服务未就绪） */
  getTarget: () => ProxyTarget | null;
  /**
   * 上游返回 401（会话失效/服务端凭据被重置）时回调——只作为信号，不阻断透传。
   * 由调用方决定是否丢弃会话并重新走兑换/登录（否则面板会永久停在 401 页）。
   */
  onAuthFailure?: () => void;
  /** 日志出口（可选） */
  log?: (line: string) => void;
}

/** 代办实例接口 */
export interface DshProxy {
  /** 监听端口（start 完成后可用） */
  port: number;
  /** 面板加载地址（http://127.0.0.1:<port>/） */
  baseUrl: string;
  /** 启动（监听 127.0.0.1 随机端口） */
  start(): Promise<void>;
  /** 停止并断开全部连接 */
  stop(): Promise<void>;
}

/** 剥离的 hop-by-hop/代管头（转发时移除，由本层重建） */
const STRIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'cookie', 'content-length', 'transfer-encoding', 'upgrade',
  // —— 浏览器来源头（DSH /api browser-trust fence 适配，实测必需）——
  // dsh-client-connection 的 isTrustedApiRequest 要求「Origin 的 host === Host 头」且
  // 「Sec-Fetch-Site 不得为 cross-site」。经本代理后：Host 被重写为真实 DSH authority，
  // 而浏览器的 Origin 是代理 origin（端口不同）、Sec-Fetch-Site 因顶层为 vscode-webview://
  // 被标为 cross-site —— 两者都会让 fence 回 403（用户实测：设置页「加载提供方目录失败…
  // HTTP 403」、工作区/会话列表空白）。本代理是同一台机器上持有会话 cookie 的受信中介，
  // 剥离这些头后 fence 视作「无来源信息请求」直接放行（与浏览器直连 DSH 页面等价语义）。
  // 若上游 fence 未来新增浏览器语义检查，需在此同步适配。
  'origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'referer',
]);
/** 响应头中剥离的字段：set-cookie 不落 iframe jar（见头注释）；connection 等 hop-by-hop 由本层管理 */
const STRIP_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding']);

/** 上游请求选项构造（host/port/path/headers 统一出口，测试注入用） */
export function buildUpstreamRequest(
  req: http.IncomingMessage,
  target: ProxyTarget,
): { hostname: string; port: number; path: string; method: string; headers: Record<string, string | string[]> } {
  const u = new URL(target.url);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lower)) continue;
    headers[lower] = value;
  }
  // Host 必须与 cookie 绑定的 authority 一致（服务端按 Host 校验），cookie 用会话记录覆盖
  headers.host = u.host;
  if (target.cookie !== undefined && target.cookie !== '') headers.cookie = target.cookie;
  return {
    hostname: u.hostname,
    port: u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port),
    path: req.url ?? '/',
    method: req.method ?? 'GET',
    headers,
  };
}

/** 过滤响应头（剥离 set-cookie 等由本层管理的字段） */
export function filterResponseHeaders(raw: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/**
 * 创建本地代办代理。
 * 生命周期：start 后监听 127.0.0.1 随机端口；getTarget 在每次请求时求值，
 * 因此目标地址/会话 cookie 变化（服务重启、重新兑换）无需重启代理。
 */
export function createDshProxy(deps: DshProxyDeps): DshProxy {
  let server: http.Server | null = null;
  let closed = false; // stop() 已调用：start() 若在停用竞态窗口完成监听，须立即关闭
  const state = { port: 0, baseUrl: '' };
  /** 活跃的 WebSocket 升级连接：Node 的 server.close()/closeAllConnections() 都不管 upgrade
   * 连接（升级后由用户负责），stop 时必须自行销毁，否则 close 永不回调 */
  const upgradeClients = new Set<Socket>();

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const target = deps.getTarget();
    if (target === null) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('DSH 代办目标未就绪（服务未启动或尚未完成登录）。');
      return;
    }
    const up = buildUpstreamRequest(req, target);
    const upReq = http.request(up, (upRes) => {
      // 会话失效信号（401 由服务端凭据/会话状态决定）：透传的同时通知调用方自愈
      if (upRes.statusCode === 401) deps.onAuthFailure?.();
      res.writeHead(upRes.statusCode ?? 502, filterResponseHeaders(upRes.headers));
      upRes.pipe(res); // 响应体流式透传（SSE/大文件不整包缓冲）
    });
    upReq.on('error', (err) => {
      deps.log?.(`[proxy] 上游请求失败 ${req.method} ${req.url}: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`DSH 上游不可达: ${String(err)}`);
      } else {
        res.destroy();
      }
    });
    // 请求体流式透传（上传大文件场景）；无 body 时 end 即发
    req.pipe(upReq);
    req.on('error', () => upReq.destroy());
  };

  const handleUpgrade = (req: http.IncomingMessage, clientSocket: Socket, head: Buffer): void => {
    upgradeClients.add(clientSocket);
    clientSocket.on('close', () => upgradeClients.delete(clientSocket));
    const target = deps.getTarget();
    if (target === null) {
      clientSocket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    const u = new URL(target.url);
    const headers: Record<string, string | string[]> = { host: u.host, connection: 'Upgrade' };
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (STRIP_REQUEST_HEADERS.has(lower) || lower === 'upgrade') continue;
      headers[lower] = value;
    }
    if (req.headers.upgrade !== undefined) headers.upgrade = String(req.headers.upgrade);
    if (target.cookie !== undefined && target.cookie !== '') headers.cookie = target.cookie;
    const upReq = http.request({
      hostname: u.hostname,
      port: u.port === '' ? 80 : Number(u.port),
      path: req.url ?? '/',
      method: req.method ?? 'GET',
      headers,
    });
    upReq.on('upgrade', (upRes, upSocket, upHead) => {
      // Node 的 http.request 会把上游 101 响应头解析消费掉（upHead 只含后续字节），
      // 必须把状态行与响应头原样写回客户端，再对接双向数据流。
      clientSocket.write(`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}\r\n`);
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (value === undefined) continue;
        const lower = name.toLowerCase();
        if (STRIP_RESPONSE_HEADERS.has(lower) && lower !== 'upgrade' && lower !== 'connection') continue;
        clientSocket.write(`${name}: ${Array.isArray(value) ? value.join(', ') : String(value)}\r\n`);
      }
      clientSocket.write('\r\n');
      if (upHead.length > 0) clientSocket.write(upHead);
      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);
      // 双向错误/关闭互传：任一端断开都要销毁另一端，防止上游 socket 滞留
      const destroyPeer = (peer: Socket) => () => peer.destroy();
      clientSocket.on('error', destroyPeer(upSocket));
      upSocket.on('error', destroyPeer(clientSocket));
      clientSocket.on('close', destroyPeer(upSocket));
      upSocket.on('close', destroyPeer(clientSocket));
    });
    upReq.on('error', (err) => {
      deps.log?.(`[proxy] WebSocket 上游失败: ${String(err)}`);
      clientSocket.destroy();
    });
    upReq.end(); // 触发 upgrade 请求（WebSocket 握手无请求体）
  };

  return {
    get port() {
      return state.port;
    },
    get baseUrl() {
      return state.baseUrl;
    },
    start: async () => {
      if (server !== null) return; // 幂等
      const s = http.createServer(handleRequest);
      s.on('upgrade', handleUpgrade);
      server = s;
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => resolve());
      });
      const address = s.address();
      if (address === null || typeof address === 'string') throw new Error('proxy listen 失败');
      if (closed) {
        // 停用竞态：start 期间 stop() 已被调用，立即关掉刚完成的监听
        s.closeAllConnections?.();
        await new Promise<void>((resolve) => s.close(() => resolve()));
        return;
      }
      state.port = address.port;
      state.baseUrl = `http://127.0.0.1:${state.port}/`;
    },
    stop: async () => {
      closed = true;
      const s = server;
      server = null;
      // 先销毁 upgrade 连接（server.close/closeAllConnections 不覆盖），否则 close 永不回调
      for (const sock of upgradeClients) sock.destroy();
      upgradeClients.clear();
      if (s === null) return;
      try {
        s.closeAllConnections?.();
      } catch {
        /* 忽略 */
      }
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
  };
}
