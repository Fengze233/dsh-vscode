// src/bridge/api.ts — DSH HTTP API 信封客户端
// 该模块运行在 VS Code 扩展宿主（Node）内，用于让扩展直连本机 DSH 服务的 HTTP API。
// 实测结论：Node 直连本机服务不受浏览器信任栅栏限制，因此无需经过 webview 转发。
//
// 信封协议约定：
//   请求：POST http://<baseUrl>/api/<method>
//         body = {type:'client-request', rpcId, method, payload}
//   响应：{type:'server-response', rpcId, result:{ok:true,value} | {ok:false,error:{code,message}}}
// rpcId 为任意字符串，仅用于请求与响应对应，本客户端自行生成。

/** 单个工作区条目（对应 workspace.list 响应 items 数组中的一项） */
export interface WorkspaceItem {
  workspaceId: string;
  path: string;
  title?: string;
  sessionIds?: string[];
}

/** DSH API 客户端接口，暴露给 Task 5 工作区同步使用 */
export interface DshApiClient {
  /** 列出所有工作区，返回条目数组 */
  workspaceList(): Promise<WorkspaceItem[]>;
  /** 按路径创建（或打开）一个工作区，返回其条目 */
  workspaceCreate(path: string): Promise<WorkspaceItem>;
}

/** 构造一封客户端请求信封（不含序列化，返回纯对象便于测试与复用） */
export function buildRequest(rpcId: string, method: string, payload: unknown): object {
  return { type: 'client-request', rpcId, method, payload };
}

/** 信封响应中 result 的静态形状（仅用于解包，不对外导出） */
interface EnvelopeResult {
  ok: boolean;
  value?: unknown;
  error?: { code?: string; message?: string };
}

/** 从「任意」响应体文本中尽力提取服务端信封错误（{result:{error:{code,message}}}）。 */
function extractServerError(text: string): EnvelopeResult['error'] | undefined {
  try {
    const parsed = JSON.parse(text) as { result?: { error?: { code?: string; message?: string } } };
    return parsed?.result?.error;
  } catch {
    // 非 JSON 或结构不符，视为无法提取，返回 undefined 由调用方降级处理
    return undefined;
  }
}

/** 发一次信封请求并解包 result（ok:false 或协议异常一律抛错，且错误信息携带 code） */
async function call(baseUrl: string, fetchImpl: typeof fetch, method: string, payload: unknown): Promise<unknown> {
  // 生成一个尽量不重复的 rpcId，便于日志与响应对应
  const rpcId = `dsh-vscode-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify(buildRequest(rpcId, method, payload));
  const res = await fetchImpl(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  // 1. 协议层检查：非 2xx 视为 HTTP 错误。
  //    先尝试从响应体读取文本并解析出服务端信封错误 {result:{ok:false,error:{code,message}}}，
  //    能提取到 code 则抛出携带该 code 的错误；否则统一抛 code='http-error'。
  if (!res.ok) {
    const serverError = extractServerError(await res.text());
    if (serverError?.code) {
      throw new Error(`dsh api ${method} failed: ${serverError.code}: ${serverError.message ?? ''}`);
    }
    throw new Error(`dsh api ${method} failed: http-error: HTTP ${res.status}`);
  }

  // 2. 2xx 分支解析 JSON；解析失败（空 body、HTML 等）抛 code='invalid-response'，
  //    避免 res.json() 抛出裸 SyntaxError（不带 code，违反协议异常必须携带 code 的约束）。
  let json: { result?: EnvelopeResult };
  try {
    json = (await res.json()) as { result?: EnvelopeResult };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`dsh api ${method} failed: invalid-response: ${reason}`);
  }

  // 3. 信封解包：响应缺 result、result.ok 为 false 一律抛错，错误码优先取服务端 error.code。
  const result = json?.result;
  if (result === undefined || !result.ok) {
    const code = result?.error?.code ?? 'http-error';
    const message = result?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`dsh api ${method} failed: ${code}: ${message}`);
  }
  return result.value;
}

/** 创建 DSH API 客户端；fetchImpl 仅用于测试注入，默认使用 Node 全局 fetch */
export function createDshApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): DshApiClient {
  return {
    async workspaceList(): Promise<WorkspaceItem[]> {
      const value = (await call(baseUrl, fetchImpl, 'workspace.list', {})) as { items?: WorkspaceItem[] };
      // 服务端未返回 items 时按空列表处理，避免上层空引用
      return value?.items ?? [];
    },
    async workspaceCreate(path: string): Promise<WorkspaceItem> {
      const value = (await call(baseUrl, fetchImpl, 'workspace.create', { path })) as WorkspaceItem;
      return value;
    },
  };
}
