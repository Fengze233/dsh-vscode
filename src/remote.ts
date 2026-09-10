// src/remote.ts — 远程（SSH Remote/WSL/Dev Container/Codespaces）场景检测与 URL 隧道解析
// 纯逻辑 + 注入式 vscode API（asExternalUri），便于 node:test 单测。
// 设计背景（v0.3.0 需求 1）：在远程窗口中，扩展宿主运行在远端，spawn 的 dsh 跑在远端
// 127.0.0.1:<port>；而面板 iframe 在本地浏览器里无法直接访问远端回环地址。
// 做法：调用 vscode.env.asExternalUri 让 VS Code 自动在「远端 127.0.0.1:<port> ↔ 本地」建立
// 端口转发隧道，返回本地可达的 URI；本地（非远程）时 asExternalUri 原样返回，无需分支。
//
// WSL 特判（issue #13-3）：Remote-WSL 里 vscode-server / webview / dsh 全在同一 WSL 内，
// 127.0.0.1 直达、不需要隧道；且 asExternalUri 对 WSL 的 127.0.0.1 返回原样（不建隧道）。
// WSL 与 SSH Remote 的本质差异：WSL 有 Windows→WSL 的 localhost 转发（VS Code Remote-WSL
// 常态可用），因此 WSL 场景把 iframe 地址的 host 从 127.0.0.1 换成 localhost 即可，
// 顺带绕开 webview service worker 对 127.0.0.1 iframe 的 origin 重写（见握手脚本注释）。

/** 远程窗口分类：local 本地 / wsl（Remote-WSL：同机直连 + localhost 转发）/ tunneled（SSH 等：需 asExternalUri 隧道） */
export type RemoteKind = 'local' | 'wsl' | 'tunneled';

/** 最小 Uri 形状（兼容 vscode.Uri 与测试桩） */
export type UriLike = { toString(): string };

/**
 * 远程窗口分类：
 * - undefined/空 → 'local'
 * - 'wsl'（vscode.env.remoteName 的 WSL 值）→ 'wsl'
 * - 其余（ssh-remote/dev-container/codespaces/attached-container/…）→ 'tunneled'
 */
export function classifyRemote(name: string | undefined): RemoteKind {
  if (typeof name !== 'string' || name.trim() === '') return 'local';
  return name === 'wsl' ? 'wsl' : 'tunneled';
}

/**
 * 判断窗口是否为远程窗口：vscode.env.remoteName 非空即远程。
 * 空串/未定义视为本地。注意：WSL 也返回 true（它确实是远程窗口形态），
 * 是否可用由 classifyRemote 区分（WSL 不需要隧道、默认放行）。
 */
export function isRemoteName(name: string | undefined): boolean {
  return typeof name === 'string' && name.trim() !== '';
}

/** 环回主机名集合（WSL host 替换的目标/来源） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 桥接握手超时（毫秒，issue #13-5）：面板打开且服务就绪后，此时间内无 bridgeAck 视为握手失败。
 * - tunneled（SSH Remote/容器，需 asExternalUri 隧道 + iframe 慢载）：15s——
 *   探测 → 隧道解析 → iframe 加载 → DSH 页面 70 个插件 boot（实测 1.5~3s）全链路 5~10s；
 * - local / wsl：5s（wsl 直连加载快；给 DSH 页面 boot 留余量）。
 */
export function handshakeTimeoutMs(remoteName: string | undefined): number {
  return classifyRemote(remoteName) === 'tunneled' ? 15000 : 5000;
}

/** 桥接状态评估延迟（毫秒）：略大于握手超时，给握手回执留出时间 */
export function bridgeEvalDelayMs(remoteName: string | undefined): number {
  return handshakeTimeoutMs(remoteName) + 1500;
}

/**
 * 把回环地址的 host 统一替换为 localhost（Windows→WSL 的 localhost 转发依赖该形式）。
 * 非环回 host（如 asExternalUri 的隧道地址）原样返回。
 */
export function toLocalhostUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!LOOPBACK_HOSTS.has(u.hostname)) return url;
    u.hostname = 'localhost';
    return u.href;
  } catch {
    return url;
  }
}

/** asExternalUri 注入接口（生产接 vscode.env，测试注入假实现） */
export interface ExternalUriApp {
  asExternalUri(uri: UriLike): Promise<UriLike>;
}

/**
 * 构造「URL → 本地可达 URL」的解析器。
 * - 本地：asExternalUri 原样返回；
 * - 远程：VS Code 自动建隧道并返回本地 URI；
 * - asExternalUri 抛错时回退原 URL（不中断面板，本地可达场景仍可用）。
 */
export function createUrlResolver(app: ExternalUriApp) {
  return async (url: string): Promise<string> => {
    try {
      const r = await app.asExternalUri({ toString: () => url } as UriLike);
      return r.toString();
    } catch {
      return url;
    }
  };
}
