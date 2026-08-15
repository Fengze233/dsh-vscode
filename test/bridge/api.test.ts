// test/bridge/api.test.ts — DSH HTTP API 信封客户端单测
// 覆盖 buildRequest 信封构造、workspaceList 解析、workspaceCreate 发送、ok:false 抛错四个场景。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshApiClient, buildRequest } from '../../src/bridge/api';

test('buildRequest 构造信封', () => {
  // 构造的信封应包含 type / rpcId / method / payload 四个字段，且顺序与值完全一致。
  assert.deepEqual(buildRequest('r1', 'workspace.list', {}), {
    type: 'client-request', rpcId: 'r1', method: 'workspace.list', payload: {},
  });
});

test('workspaceList 解析 value.items', async () => {
  // 假 fetch 直接返回一封 server-response，其中 result.value.items 是工作区数组。
  const fetchImpl = async () => new Response(JSON.stringify({
    type: 'server-response', rpcId: 'r1',
    result: { ok: true, value: { items: [{ workspaceId: 'w1', path: '/proj', title: 'proj' }] } },
  }), { status: 200 });
  const api = createDshApiClient('http://127.0.0.1:3080', fetchImpl as unknown as typeof fetch);
  const items = await api.workspaceList();
  assert.deepEqual(items, [{ workspaceId: 'w1', path: '/proj', title: 'proj' }]);
});

test('workspaceCreate 发送 path 并解析响应', async () => {
  // 捕获实际发出的请求体，验证 method 为 workspace.create 且 payload.path 正确传递。
  let capturedBody: unknown;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      type: 'server-response', rpcId: 'r1',
      result: { ok: true, value: { workspaceId: 'w2', path: '/proj2' } },
    }), { status: 200 });
  };
  const api = createDshApiClient('http://127.0.0.1:3080', fetchImpl as unknown as typeof fetch);
  const ws = await api.workspaceCreate('/proj2');
  assert.equal(ws.workspaceId, 'w2');
  assert.deepEqual((capturedBody as { method: string; payload: { path: string } }).method, 'workspace.create');
  assert.equal((capturedBody as { payload: { path: string } }).payload.path, '/proj2');
});

test('ok:false 时抛错并携带 code', async () => {
  // 当 result.ok 为 false 时，应抛出包含错误码的异常。
  const fetchImpl = async () => new Response(JSON.stringify({
    type: 'server-response', rpcId: 'r1',
    result: { ok: false, error: { code: 'workspace-not-found', message: 'x' } },
  }), { status: 200 });
  const api = createDshApiClient('http://127.0.0.1:3080', fetchImpl as unknown as typeof fetch);
  await assert.rejects(() => api.workspaceList(), /workspace-not-found/);
});

test('非 JSON 响应（500 HTML）抛 http-error 且携带 code', async () => {
  // 服务端返回 500 + HTML 文本（如网关错误页），body 无法解析出信封 error，
  // 应按 http-error 处理并携带 HTTP 状态码，而不是裸 SyntaxError。
  const fetchImpl = async () => new Response('<html><body>Internal Server Error</body></html>', {
    status: 500,
    headers: { 'content-type': 'text/html' },
  });
  const api = createDshApiClient('http://127.0.0.1:3080', fetchImpl as unknown as typeof fetch);
  await assert.rejects(() => api.workspaceList(), /http-error/);
  await assert.rejects(() => api.workspaceList(), /HTTP 500/);
});

test('空 body 的 200 响应抛 invalid-response', async () => {
  // 200 但 body 为空时 res.json() 解析失败，应抛 invalid-response 而非裸 SyntaxError。
  const fetchImpl = async () => new Response('', { status: 200 });
  const api = createDshApiClient('http://127.0.0.1:3080', fetchImpl as unknown as typeof fetch);
  await assert.rejects(() => api.workspaceList(), /invalid-response/);
});

test('workspaceList 空 items 兜底返回 []', async () => {
  // 服务端 ok:true 但未返回 value.items（undefined），应兜底为空数组，避免上层空引用。
  const fetchImpl = async () => new Response(JSON.stringify({
    type: 'server-response', rpcId: 'r1',
    result: { ok: true, value: {} },
  }), { status: 200 });
  const api = createDshApiClient('http://127.0.0.1:3080', fetchImpl as unknown as typeof fetch);
  const items = await api.workspaceList();
  assert.deepEqual(items, []);
});

test('workspaceList 请求 URL 以 /api/workspace.list 结尾', async () => {
  // 捕获实际请求 URL，验证方法名被拼接到 /api/ 之后。
  let capturedUrl = '';
  const fetchImpl = async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify({
      type: 'server-response', rpcId: 'r1',
      result: { ok: true, value: { items: [] } },
    }), { status: 200 });
  };
  const api = createDshApiClient('http://127.0.0.1:3080', fetchImpl as unknown as typeof fetch);
  await api.workspaceList();
  assert.ok(capturedUrl.endsWith('/api/workspace.list'), `期望 URL 以 /api/workspace.list 结尾，实际：${capturedUrl}`);
});
