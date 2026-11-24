import { randomBytes, randomUUID } from 'node:crypto';
// src/service/session.ts — DSH ≥0.1.2 浏览器会话：启动网址(带一次性 token) → 签名 cookie 兑换与持有
// 纯模块：不依赖 vscode；fetch 与存储均依赖注入，便于 node:test 单测。
//
// 协议（对真实 dsh 0.1.2-rc.1 实测 + 读 dsh-client-connection 源码确认）：
// 1. `dsh web` 启动后在 stdout 打印 `dsh web: http://127.0.0.1:<port>/?token=<launchToken>`；
// 2. GET 该带 token 的 URL（Host 头与 authority 匹配）→ 303 → `location: /` +
//    `set-cookie: dsh-auth-<sha256(authority)>=<签名负载>; Max-Age=…; Path=/; HttpOnly; SameSite=Strict`；
// 3. 此后所有页面与 /api 请求都必须携带该 cookie（authority 绑定），无 cookie 一律 401；
// 4. cookie 由 ~/.dsh credentials 里的持久密钥签发（默认 30 天有效），服务重启不失效；
//    launch token 是 per-process 的（每次启动变化），只在兑换时用一次，之后即可丢弃。
//
// 为什么扩展必须自己持有 cookie（而不是把带 token 的 URL 塞给 iframe）：
// cookie 是 SameSite=Strict；VS Code 面板的 iframe 与 DSH 服务跨站（top 为 vscode-webview://），
// 浏览器不会在跨站嵌套上下文回送 Strict cookie（已用真实 Chromium 三种顶层形态实测），
// 因此页面必须经扩展的本地代理访问（见 service/proxy.ts），由代理代示 cookie。

/** 会话记录（按 authority 即 host:port 分开存，支持多 DSH 实例） */
export interface StoredSession {
  /** 待注入的 Cookie 头值（name=value，不含属性） */
  cookie: string;
  /** 过期时间戳（毫秒）；由响应头 Max-Age/Expires 解析，解析失败给保守的 1 小时 */
  expiresAt: number;
  /** 绑定的 authority（host:port，兑换时请求的 Host） */
  authority: string;
  /** 兑换成功时刻（毫秒，日志与排障用） */
  issuedAt: number;
}

/** 会话存储抽象（生产接 VS Code globalState；测试用内存 Map） */
export interface SessionStore {
  get(key: string): StoredSession | undefined;
  set(key: string, value: StoredSession): void;
  delete(key: string): void;
}

/** 会话依赖 */
export interface SessionDeps {
  /** fetch 实现（生产为全局 fetch；测试注入假实现或真实服务器） */
  fetchImpl: typeof fetch;
  /** 会话存储 */
  store: SessionStore;
  /** 当前时间戳注入（默认 Date.now，测试可控） */
  now?: () => number;
}

/** 兑换结果 */
export type ExchangeResult =
  | { status: 'ok'; authority: string; expiresAt: number } // 已换到 cookie
  | { status: 'no-auth'; authority: string }               // 0.1.1 及更早：无鉴权，无需 cookie
  | { status: 'rejected'; authority: string; reason: string }; // token 失效/服务拒绝（需新启动网址）

/** 会话记录在 store 里的键名前缀 */
const SESSION_KEY_PREFIX = 'auth-session:';

/** dsh 鉴权 cookie 名前缀（dsh-client-connection: COOKIE_PREFIX = "dsh-auth-"） */
const DSH_COOKIE_PREFIX = 'dsh-auth-';

/** 解析失败的保守有效时长（毫秒）：1 小时——宁可提前要求重新兑换，也不在失效后继续误用 */
const FALLBACK_MAX_AGE_MS = 60 * 60 * 1000;

/** 从启动网址提取 authority（host:port）与 token */
export function parseLaunchTarget(url: string): { authority: string; token: string } | null {
  try {
    const u = new URL(url);
    const token = u.searchParams.get('token');
    if (token === null || token === '' || u.hostname === '') return null;
    return { authority: u.host, token };
  } catch {
    return null;
  }
}

/** 解析 set-cookie 头里的有效时长（毫秒）：优先 Max-Age，其次 Expires；失败返回 null */
function cookieMaxAgeMs(setCookie: string, now: number): number | null {
  const maxAge = /(?:^|;\s*)Max-Age=(\d+)/i.exec(setCookie);
  if (maxAge !== null) return Number(maxAge[1]) * 1000;
  const expires = /(?:^|;\s*)Expires=([^;]+)/i.exec(setCookie);
  if (expires !== null) {
    const t = Date.parse(expires[1]);
    if (Number.isFinite(t)) return Math.max(0, t - now);
  }
  return null;
}

/** 从响应提取 dsh 会话 cookie（名以 dsh-auth- 开头，只取第一个） */
function extractDshCookie(res: Response): { name: string; value: string; maxAgeMs: number | null } | null {
  const now = Date.now();
  const setCookies =
    typeof (res.headers as Headers).getSetCookie === 'function'
      ? (res.headers as Headers).getSetCookie()
      : [res.headers.get('set-cookie')].filter((v): v is string => typeof v === 'string');
  for (const sc of setCookies) {
    const eq = sc.indexOf('=');
    if (eq === -1) continue;
    const name = sc.slice(0, eq).trim();
    if (!name.startsWith(DSH_COOKIE_PREFIX)) continue;
    const semi = sc.indexOf(';', eq);
    const value = (semi === -1 ? sc.slice(eq + 1) : sc.slice(eq + 1, semi)).trim();
    return { name, value, maxAgeMs: cookieMaxAgeMs(sc, now) };
  }
  return null;
}

/**
 * 执行一次「启动网址 → 会话 cookie」兑换：
 * - 200：无鉴权的 DSH（≤0.1.1）→ no-auth；
 * - 303 + dsh-auth-* set-cookie：成功 → 写入 store → ok；
 * - 401/403/其它：token 失效或被拒 → rejected（调用方引导用户提供新的启动网址）。
 * @param launchUrl dsh web 打印的启动网址（`dsh web: ` 前缀之后的部分）
 */
export async function exchangeSession(
  launchUrl: string,
  deps: SessionDeps,
): Promise<ExchangeResult> {
  const target = parseLaunchTarget(launchUrl);
  if (target === null) {
    // 不回显原文：启动网址含一次性 token，避免经错误提示/日志扩散
    return { status: 'rejected', authority: '(unknown)', reason: '启动网址无法解析（缺少有效的 token 参数）' };
  }
  const now = deps.now?.() ?? Date.now();
  const res = await deps.fetchImpl(launchUrl, { redirect: 'manual' });
  if (res.status === 200) return { status: 'no-auth', authority: target.authority }; // 旧版 dsh
  if (res.status === 303) {
    const cookie = extractDshCookie(res);
    if (cookie !== null) {
      const expiresAt = now + (cookie.maxAgeMs ?? FALLBACK_MAX_AGE_MS);
      const record: StoredSession = {
        cookie: `${cookie.name}=${cookie.value}`,
        expiresAt,
        authority: target.authority,
        issuedAt: now,
      };
      deps.store.set(SESSION_KEY_PREFIX + target.authority, record);
      return { status: 'ok', authority: target.authority, expiresAt };
    }
    // 303 但没有 dsh cookie：非预期（可能是别的 303 落点），保守拒绝
    return { status: 'rejected', authority: target.authority, reason: '303 响应未携带 dsh 会话 cookie' };
  }
  return {
    status: 'rejected',
    authority: target.authority,
    reason: `兑换请求返回 HTTP ${res.status}（token 可能已随服务重启失效，请提供最新的启动网址）`,
  };
}

/** 读取某 authority 的未过期会话（过期即删除并返回 undefined） */
export function getValidSession(authority: string, deps: SessionDeps): StoredSession | undefined {
  const key = SESSION_KEY_PREFIX + authority;
  const record = deps.store.get(key);
  if (record === undefined) return undefined;
  const now = deps.now?.() ?? Date.now();
  if (record.expiresAt <= now) {
    deps.store.delete(key);
    return undefined;
  }
  return record;
}

/** 删除某 authority 的会话（cookie 失效/用户主动登出） */
export function dropSession(authority: string, deps: SessionDeps): void {
  deps.store.delete(SESSION_KEY_PREFIX + authority);
}

/**
 * 健康检查：带 cookie 访问根路径，确认会话仍被服务端接受（用于健康定时器/重连前自检）。
 * @returns ok=会话可用；expired=401（cookie 失效/被重置，需重新兑换）；down=服务不可达
 */
export async function probeSession(
  authority: string,
  deps: SessionDeps,
  timeoutMs = 3000,
): Promise<'ok' | 'expired' | 'down'> {
  const record = getValidSession(authority, deps);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetchImpl(`http://${authority}/`, {
      redirect: 'manual',
      signal: controller.signal,
      ...(record === undefined ? {} : { headers: { cookie: record.cookie } }),
    });
    if (res.status === 200) return 'ok';
    if (res.status === 401 || res.status === 403) return 'expired';
    return 'ok'; // 其它状态（303 等）：服务在响应，会话问题由后续真实请求暴露
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}


/** DSH >=0.2.3-alpha.2 设备配对凭据 */
export interface PairingTicket {
  id: string;
  secret: string;
}

export type PairingRequestResult =
  | { status: 'ok'; code: string; expiresInMs: number; pollIntervalMs: number }
  | { status: 'busy' }
  | { status: 'unavailable' }
  | { status: 'error'; reason: string };

export type PairingPollResult =
  | { status: 'pending'; retryAfterMs?: number }
  | { status: 'completed'; authority: string; expiresAt: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'error'; reason: string };

/** 生成一次性设备配对凭据（UUID v4 + 43 字符 base64url secret） */
export function createPairingTicket(): PairingTicket {
  return {
    id: randomUUID(),
    secret: randomBytes(32).toString('base64url'),
  };
}

/** 发起设备配对请求（POST /pairing/request） */
export async function requestPairing(
  authority: string,
  ticket: PairingTicket,
  deps: Pick<SessionDeps, 'fetchImpl'>,
  timeoutMs = 5000,
): Promise<PairingRequestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetchImpl(`http://${authority}/pairing/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ticket.id, secret: ticket.secret }),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status === 429) return { status: 'busy' };
    if (res.status === 503) return { status: 'unavailable' };
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
    const data = (await res.json()) as {
      code?: unknown;
      expiresInMs?: unknown;
      pollIntervalMs?: unknown;
    };
    if (typeof data.code !== 'string' || data.code === '') {
      return { status: 'error', reason: 'Missing pairing code in response' };
    }
    return {
      status: 'ok',
      code: data.code,
      expiresInMs: typeof data.expiresInMs === 'number' && data.expiresInMs > 0 ? data.expiresInMs : 300_000,
      pollIntervalMs: typeof data.pollIntervalMs === 'number' && data.pollIntervalMs >= 500 ? data.pollIntervalMs : 2000,
    };
  } catch (err) {
    return { status: 'error', reason: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 轮询设备配对状态（POST /pairing/status）；completed 时自动提取并保存 dsh-auth-* cookie */
export async function pollPairingStatus(
  authority: string,
  ticket: PairingTicket,
  deps: SessionDeps,
  timeoutMs = 5000,
): Promise<PairingPollResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const now = deps.now?.() ?? Date.now();
    const res = await deps.fetchImpl(`http://${authority}/pairing/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ticket.id, secret: ticket.secret }),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status === 429) return { status: 'pending', retryAfterMs: 5000 };
    if (res.status === 503) return { status: 'unavailable' };
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
    const data = (await res.json()) as { status?: unknown };
    const st = data.status;
    if (st === 'completed') {
      const cookie = extractDshCookie(res);
      if (cookie === null) {
        return { status: 'error', reason: 'Completed response missing dsh-auth cookie' };
      }
      const expiresAt = now + (cookie.maxAgeMs ?? FALLBACK_MAX_AGE_MS);
      const record: StoredSession = {
        cookie: `${cookie.name}=${cookie.value}`,
        expiresAt,
        authority,
        issuedAt: now,
      };
      deps.store.set(SESSION_KEY_PREFIX + authority, record);
      return { status: 'completed', authority, expiresAt };
    }
    if (st === 'pending' || st === 'denied' || st === 'expired' || st === 'cancelled' || st === 'unavailable') {
      return { status: st };
    }
    return { status: 'error', reason: `Unexpected pairing status: ${String(st)}` };
  } catch (err) {
    return { status: 'error', reason: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 取消进行中的设备配对请求（POST /pairing/cancel） */
export async function cancelPairing(
  authority: string,
  ticket: PairingTicket,
  deps: Pick<SessionDeps, 'fetchImpl'>,
  timeoutMs = 3000,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await deps.fetchImpl(`http://${authority}/pairing/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ticket.id, secret: ticket.secret }),
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    // Best-effort cancellation
  } finally {
    clearTimeout(timer);
  }
}

const LOOPBACK_ALIASES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 规范化用户粘贴的登录输入：
 * - 支持裸 43 位 token（自动拼到 targetAuthority）
 * - 支持 localhost / --public-url（如 https://dsh.example.com/?token=...）自动映射为 http://targetAuthority/?token=...
 * - 若为另一台不同端口的环回地址（如 127.0.0.1:3081 vs 127.0.0.1:3080）则保留原 host 以便上层提示端口不匹配
 */
export function normalizeAuthInput(rawInput: string, targetAuthority: string): string | null {
  const trimmed = rawInput.trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    return `http://${targetAuthority}/?token=${trimmed}`;
  }
  const m = /https?:\/\/[^\s]+/.exec(trimmed);
  if (m === null) return null;
  try {
    const u = new URL(m[0]);
    const token = u.searchParams.get('token');
    if (token !== null && token !== '') {
      const targetUrl = new URL(`http://${targetAuthority}/`);
      const samePort = (u.port || (u.protocol === 'https:' ? '443' : '80')) === (targetUrl.port || '80');
      const isLoopback = LOOPBACK_ALIASES.has(u.hostname);
      // Either loopback alias on same port (localhost:3080 -> 127.0.0.1:3080) OR non-loopback public URL (--public-url)
      if ((isLoopback && samePort) || !isLoopback) {
        return `http://${targetAuthority}/?token=${encodeURIComponent(token)}`;
      }
    }
    return u.href;
  } catch {
    return null;
  }
}
