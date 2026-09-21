// test/context/dshApi.test.ts — DSH 信封协议客户端单元测试（两代线格式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshApi, DshApiError, DSH_UNAUTHORIZED, buildRpcRequest, slashEndpoint, argsKeyOf } from '../../src/context/dshApi';

/** 假 fetch:记录请求并返回预置响应 */
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => {
    // 注:项目 tsconfig 无 DOM lib,fetch 类型来自 @types/node,input 为 string | URL | Request;
    // URL 用 href,Request 用 url(与简报原写法 input.url 语义等价)。
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function okResponse(value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId: 'r1', result: { ok: true, value } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('线格式工具：slashEndpoint / argsKeyOf', () => {
  assert.equal(slashEndpoint('session.list'), 'session/list');
  assert.equal(slashEndpoint('workspace.create'), 'workspace/create');
  assert.equal(argsKeyOf('session.list'), '_request');
  assert.equal(argsKeyOf('session.create'), 'request');
  assert.equal(argsKeyOf('session.prompt'), 'request');
  assert.equal(argsKeyOf('workspace.create'), 'request');
});

test('buildRpcRequest：新版（0.1.2）斜杠端点 + payload.args 包装；旧版点分 + 扁平 payload', () => {
  const modern = buildRpcRequest('session.list', { beforeSeq: 1 }, 'r1', 'modern');
  assert.equal(modern.path, '/api/session/list');
  assert.deepEqual(JSON.parse(modern.body), {
    type: 'client-request',
    rpcId: 'r1',
    method: 'session/list',
    payload: { args: { _request: { beforeSeq: 1 } } },
  });
  const legacy = buildRpcRequest('session.list', { beforeSeq: 1 }, 'r2', 'legacy');
  assert.equal(legacy.path, '/api/session.list');
  assert.deepEqual(JSON.parse(legacy.body), {
    type: 'client-request',
    rpcId: 'r2',
    method: 'session.list',
    payload: { beforeSeq: 1 },
  });
});

test('默认 auto：首请求走新版协议（斜杠端点 + args.request）', async () => {
  const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
  const api = createDshApi('http://127.0.0.1:3080/', {
    fetchImpl: fakeFetch((url, init) => {
      captured.push({ url, body: JSON.parse(init.body as string) });
      return okResponse({ hello: 1 });
    }),
  });
  const value = await api.call<{ hello: number }>('workspace.create', { path: '/tmp/x' });
  assert.deepEqual(value, { hello: 1 });
  assert.equal(captured.length, 1, '命中新版后不应有回退请求');
  assert.equal(captured[0].url, 'http://127.0.0.1:3080/api/workspace/create');
  const body = captured[0].body as { type: string; method: string; payload: unknown; rpcId: string };
  assert.equal(body.type, 'client-request');
  assert.equal(body.method, 'workspace/create');
  assert.deepEqual(body.payload, { args: { request: { path: '/tmp/x' } } });
  assert.equal(typeof body.rpcId, 'string');
});

test('auto 模式：新版端点 404（旧版 DSH）→ 自动回退旧协议并缓存判定', async () => {
  const seen: string[] = [];
  const api = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch((url) => {
      seen.push(url.replace('http://127.0.0.1:3080', ''));
      return url.includes('/api/session/list')
        ? new Response('not found', { status: 404 })
        : okResponse({ items: [{ sessionId: 's1', updatedAt: 1 }] });
    }),
  });
  const items = await api.sessionList();
  assert.equal(items.length, 1);
  assert.deepEqual(seen, ['/api/session/list', '/api/session.list'], '首个 404 后应回退旧点分端点');
  seen.length = 0;
  await api.sessionList();
  assert.deepEqual(seen, ['/api/session.list'], '回退判定应被缓存，后续不再探测');
});

test('显式 protocol=legacy：直接使用旧协议（≤0.1.1）', async () => {
  const seen: string[] = [];
  const api = createDshApi('http://127.0.0.1:3080', {
    protocol: 'legacy',
    fetchImpl: fakeFetch((url) => {
      seen.push(url);
      return okResponse({ items: [] });
    }),
  });
  await api.sessionList();
  assert.deepEqual(seen, ['http://127.0.0.1:3080/api/session.list']);
});

test('401/403（DSH ≥0.1.2 会话缺失）→ kind=unsupported 且 code=unauthorized（供上层引导登录）', async () => {
  for (const status of [401, 403]) {
    const api = createDshApi('http://127.0.0.1:3080', {
      fetchImpl: fakeFetch(() => new Response('unauthorized', { status })),
    });
    await assert.rejects(api.sessionList(), (err: unknown) => {
      assert.ok(err instanceof DshApiError);
      assert.equal((err as DshApiError).kind, 'unsupported');
      assert.equal((err as DshApiError).code, DSH_UNAUTHORIZED);
      return true;
    });
  }
});

test('headers 选项：可注入 Cookie（集成测试模拟代办）', async () => {
  let cookie: string | undefined;
  const api = createDshApi('http://127.0.0.1:3080', {
    headers: { cookie: 'dsh-auth-x=v1' },
    fetchImpl: fakeFetch((_url, init) => {
      cookie = (init.headers as Record<string, string>).cookie;
      return okResponse({ items: [] });
    }),
  });
  await api.sessionList();
  assert.equal(cookie, 'dsh-auth-x=v1');
});

test('rpcId 递增且带前缀', async () => {
  const seen: string[] = [];
  const api = createDshApi('http://127.0.0.1:3080', {
    rpcIdPrefix: 'probe',
    fetchImpl: fakeFetch((_url, init) => {
      seen.push((JSON.parse(init.body as string) as { rpcId: string }).rpcId);
      return okResponse({});
    }),
  });
  await api.call('a.b');
  await api.call('a.b');
  assert.deepEqual(seen, ['probe-1', 'probe-2']);
});

test('RPC 错误(result.ok=false)→ DshApiError kind=rpc 且带 code', async () => {
  const api = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch(() =>
      new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: 'r1',
          result: { ok: false, error: { code: 'bad-request', message: 'invalid payload' } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  });
  await assert.rejects(api.call('session.prompt', {}), (err: unknown) => {
    assert.ok(err instanceof DshApiError);
    assert.equal((err as DshApiError).kind, 'rpc');
    assert.equal((err as DshApiError).code, 'bad-request');
    assert.match((err as DshApiError).message, /invalid payload/);
    return true;
  });
});

test('404（两种协议都不支持）→ kind=unsupported;5xx → kind=network;非 JSON → kind=network', async () => {
  const notFound = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch(() => new Response('not found', { status: 404 })),
  });
  await assert.rejects(notFound.call('sessions.list', {}), (err: unknown) => (err as DshApiError).kind === 'unsupported');

  const serverError = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch(() => new Response('oops', { status: 500 })),
  });
  await assert.rejects(serverError.call('session.list'), (err: unknown) => (err as DshApiError).kind === 'network');

  const malformed = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch(() => new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  });
  await assert.rejects(malformed.call('session.list'), (err: unknown) => (err as DshApiError).kind === 'network');
});

test('fetch 抛错(网络失败/超时 abort)→ kind=network', async () => {
  const api = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: (() => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch,
  });
  await assert.rejects(api.call('session.list'), (err: unknown) => (err as DshApiError).kind === 'network');
});

test('四个封装方法映射正确的方法名与 payload 形状（新版协议）', async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const api = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch((_url, init) => {
      const body = JSON.parse(init.body as string) as { method: string; payload: { args: Record<string, unknown> } };
      calls.push({ method: body.method, args: body.payload.args });
      const m = body.method;
      const value = m === 'session/list'
        ? { items: [{ sessionId: 's1', updatedAt: 1 }] }
        : m === 'session/prompt'
          ? { accepted: true }
          : m === 'session/create'
            ? { sessionId: 's9' }
            : { workspace: { workspaceId: 'w1', path: '/p', title: 'p', sessionIds: [], createdAt: 'x', updatedAt: 'x' }, created: true };
      return okResponse(value);
    }),
  });
  await api.workspaceCreate('/p');
  await api.sessionList();
  await api.sessionCreate({ cwd: '/p' });
  await api.sessionPrompt({ sessionId: 's9', text: 'hi' });
  assert.deepEqual(calls.map((c) => c.method), ['workspace/create', 'session/list', 'session/create', 'session/prompt']);
  // list 的参数名是 _request，其余是 request
  assert.deepEqual(calls[1].args, { _request: {} }); // list 的参数名是 _request，且不可省略
  const promptReq = calls[3].args.request as {
    requestId: string; sessionId: string; mode: string; content: Array<{ type: string; text: string }>;
  };
  assert.equal(typeof promptReq.requestId, 'string', '必须携带契约必填的 requestId（0.1.2 实测缺失即被拒）');
  assert.ok(promptReq.requestId.length > 0);
  assert.equal(promptReq.sessionId, 's9');
  assert.equal(promptReq.mode, 'queue');
  assert.deepEqual(promptReq.content, [{ type: 'text', text: 'hi' }]);
});
