// src/context/dshApi.ts — DSH HTTP 信封协议客户端(纯模块,不依赖 vscode)
//
// 两代线格式都支持(DSH 0.1.2 起协议变更，实测确认)：
//   ① ≤0.1.1：POST /api/<namespace>.<method>
//      请求 { type:'client-request', rpcId, method:'session.list', payload:{ 业务参数扁平 } }
//   ② ≥0.1.2：POST /api/<namespace>/<method>（斜杠端点）
//      请求 { type:'client-request', rpcId, method:'session/list',
//             payload:{ args:{ <参数名>: 业务参数 } } }
//      参数名按宿主控制器的 TS 形参命名：prompt/create/workspace.create 是 request，
//      list 是 _request（不可省略，否则网关报 args fields do not match the descriptor）。
// 默认 protocol='auto'：先按新版协议请求；若返回 404（旧版不认识斜杠端点）则自动回退旧协议，
// 并在本实例内缓存判定结果，后续请求不再重复探测。
//
// 鉴权（DSH ≥0.1.2 强制浏览器会话，未带 cookie 一律 401）：
//   生产路径由扩展的「本地代办代理」注入会话 cookie 并适配 /api browser-trust fence，
//   因此 baseUrl 应指向代办地址（http://127.0.0.1:<proxyPort>）；
//   也可用 opts.headers 显式附加 Cookie（集成测试用此方式模拟代办注入会话）。

export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  blank?: boolean;
  cwd?: string;
}

export type DshApiErrorKind = 'network' | 'rpc' | 'unsupported';

/** DSH 侧 401/403（会话缺失或失效）时携带的错误码，上层据此提示「需要登录」 */
export const DSH_UNAUTHORIZED = 'unauthorized';

export class DshApiError extends Error {
  constructor(
    readonly kind: DshApiErrorKind,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DshApiError';
  }
}

interface RpcEnvelope {
  type: 'server-response';
  rpcId: string;
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
}

export interface DshApi {
  call<T>(method: string, payload?: unknown): Promise<T>;
  workspaceCreate(path: string): Promise<{ workspace: WorkspaceView; created: boolean }>;
  sessionList(): Promise<SessionSummary[]>;
  sessionCreate(opts: { cwd?: string; workspaceId?: string }): Promise<{ sessionId: string }>;
  sessionPrompt(opts: { sessionId: string; text: string }): Promise<void>;
}

/** 线格式模式：auto（默认，先新后旧）/ modern（0.1.2+）/ legacy（≤0.1.1） */
export type DshApiProtocol = 'auto' | 'modern' | 'legacy';

export interface DshApiOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  rpcIdPrefix?: string;
  /** 线格式模式（默认 auto：先按 0.1.2 的斜杠端点请求，404 时回退旧点分端点） */
  protocol?: DshApiProtocol;
  /** 额外请求头（如集成测试用 { cookie } 模拟代办注入会话） */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** 点分方法名 → 新版斜杠端点名（'session.list' → 'session/list'） */
export function slashEndpoint(method: string): string {
  return method.replace(/\./g, '/');
}

/**
 * 参数名映射：新版协议要求业务参数按宿主控制器形参名包裹在 payload.args 下。
 * list 的形参是 `_request`，其余（prompt / create / workspace.create）是 `request`。
 */
export function argsKeyOf(method: string): string {
  return /\.list$/.test(method) ? '_request' : 'request';
}

/** 构造请求（导出便于单测断言两代线格式形状） */
export function buildRpcRequest(
  method: string,
  payload: unknown,
  rpcId: string,
  protocol: 'modern' | 'legacy',
): { path: string; body: string } {
  if (protocol === 'modern') {
    const endpoint = slashEndpoint(method);
    return {
      path: `/api/${endpoint}`,
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload: { args: { [argsKeyOf(method)]: payload } },
      }),
    };
  }
  return {
    path: `/api/${method}`,
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  };
}

export function createDshApi(baseUrl: string, opts: DshApiOptions = {}): DshApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prefix = opts.rpcIdPrefix ?? 'dsh-vscode';
  const base = baseUrl.replace(/\/+$/, '');
  const extraHeaders = opts.headers ?? {};
  let seq = 0;
  // auto 模式下的协议判定缓存：默认按新版；遇 404 降级 legacy 后不再回探
  let protocol: 'modern' | 'legacy' = opts.protocol === 'legacy' ? 'legacy' : 'modern';
  const probeFallbackAllowed = opts.protocol === undefined || opts.protocol === 'auto';

  async function send(
    method: string,
    payload: unknown,
    rpcId: string,
    proto: 'modern' | 'legacy',
  ): Promise<{ status: number; res: Response }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const { path, body } = buildRpcRequest(method, payload, rpcId, proto);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body,
        signal: controller.signal,
      });
      return { status: res.status, res };
    } catch (err) {
      throw new DshApiError('network', `request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<T>(method: string, payload: unknown = {}): Promise<T> {
    const rpcId = `${prefix}-${++seq}`;
    let { status, res } = await send(method, payload, rpcId, protocol);
    // auto：新版端点 404（旧版 DSH 不认识斜杠端点）→ 回退旧协议重试一次并缓存判定
    if (status === 404 && protocol === 'modern' && probeFallbackAllowed) {
      protocol = 'legacy';
      ({ status, res } = await send(method, payload, rpcId, 'legacy'));
    }
    if (status === 404) throw new DshApiError('unsupported', `DSH does not support ${method}`);
    // 401/403：DSH ≥0.1.2 的会话缺失/失效（或 /api fence 拒绝）——单独归类，便于上层引导登录
    if (status === 401) throw new DshApiError('unsupported', 'DSH requires browser sign-in (401)', DSH_UNAUTHORIZED);
    if (status === 403) throw new DshApiError('unsupported', 'DSH rejected the request (403)', DSH_UNAUTHORIZED);
    if (!res.ok) throw new DshApiError('network', `DSH responded ${status}`);
    let body: RpcEnvelope;
    try {
      body = (await res.json()) as RpcEnvelope;
    } catch {
      throw new DshApiError('network', 'malformed DSH response');
    }
    if (body.type !== 'server-response' || !body.result) {
      throw new DshApiError('network', 'malformed DSH response');
    }
    if (!body.result.ok) {
      throw new DshApiError('rpc', body.result.error.message, body.result.error.code);
    }
    return body.result.value as T;
  }

  return {
    call,
    workspaceCreate: (path) => call<{ workspace: WorkspaceView; created: boolean }>('workspace.create', { path }),
    sessionList: () => call<{ items: SessionSummary[] }>('session.list').then((r) => r.items),
    sessionCreate: (o) => call<{ sessionId: string }>('session.create', o),
    sessionPrompt: (o) =>
      call<{ accepted: true }>('session.prompt', {
        // 契约必填：SessionPromptRequest.requestId 是「客户端生成、持久化在该条用户消息上的标识」，
        // 缺失会被 typert 网关以 gateway/input-invalid（wire field "request" failed boundary
        // validation）拒绝（0.1.2 实测）。
        requestId: `${prefix}-msg-${++seq}`,
        sessionId: o.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: o.text }],
      }).then(() => undefined),
  };
}
