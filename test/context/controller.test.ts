// test/context/controller.test.ts — 上下文控制器:命令行为/错误分支/去重
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextController, type ControllerDeps } from '../../src/context/controller';
// 注:简报原样导入了 DshApiError,但测试体未使用;本项目 tsconfig 开启
// noUnusedLocals,未使用的导入会报 TS6133,故移除(语义无影响)。

interface Harness {
  controller: ContextController;
  infos: string[];
  warnings: string[];
  inputs: Array<{ prompt: string }>;
  inputAnswers: Array<string | undefined>;
  autoFollow: boolean;
  sessions: Array<{ sessionId: string; cwd?: string; updatedAt: number }>;
  prompts: Array<{ text: string }>;
  ensureCalls: number;
}

function makeHarness(opts?: { ready?: boolean }): Harness {
  const h: Harness = {
    controller: null as unknown as ContextController,
    infos: [],
    warnings: [],
    inputs: [],
    inputAnswers: [],
    autoFollow: false,
    sessions: [],
    prompts: [],
    ensureCalls: 0,
  };
  const ready = opts?.ready ?? true;
  const deps: ControllerDeps = {
    manager: {
      getSnapshot: () => ({ state: ready ? 'ready' : 'idle', url: null, error: null, owned: false }),
      getTarget: () => ({ host: '127.0.0.1', port: 3080 }),
      ensureRunning: async () => {
        h.ensureCalls += 1;
        return { state: 'ready', url: 'http://127.0.0.1:3080/', error: null, owned: true };
      },
    },
    getWorkspaceRoot: () => '/proj',
    getAutoFollow: () => h.autoFollow,
    setAutoFollow: async (v) => {
      h.autoFollow = v;
    },
    messages: {
      t: (k: string, vars?: Record<string, string | number>) =>
        vars ? `${k}:${JSON.stringify(vars)}` : k,
      showInformation: (m) => h.infos.push(m),
      showWarning: (m) => h.warnings.push(m),
      showInputBox: async (o) => {
        h.inputs.push(o);
        return h.inputAnswers.shift();
      },
    },
  };
  // 假 API:controller 内部 createDshApi 用真实实现;这里通过 fetch 全局注入假响应
  // 注:简报原写法有 `const realFetch = globalThis.fetch;`(备份原 fetch),
  // 但 restoreFetch 用 delete 恢复,该备份未消费;noUnusedLocals 会报 TS6133,故删除。
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // 注:简报原写法有 `const url = ...`(取请求 URL),但 mock 并不消费它,
    // tsconfig 开启 noUnusedLocals 会报 TS6133,故删除该行(语义无影响)。
    const body = JSON.parse((init?.body as string) ?? '{}') as {
      method: string;
      payload: Record<string, unknown> & { args?: Record<string, unknown> };
    };
    // 兼容两代线格式：0.1.2 用斜杠端点 + payload.args.<参数名> 包装；≤0.1.1 用点分 + 扁平 payload
    const method = body.method.replace(/\//g, '.');
    const payload = (body.payload.args !== undefined
      ? Object.values(body.payload.args)[0]
      : body.payload) as Record<string, unknown>;
    let value: unknown = {};
    if (method === 'workspace.create') value = { workspace: { workspaceId: 'w1' }, created: true };
    if (method === 'session.list') value = { items: h.sessions };
    if (method === 'session.create') value = { sessionId: 's-new' };
    if (method === 'session.prompt') h.prompts.push({ text: (payload.content as Array<{ text: string }>)[0].text });
    return new Response(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  h.controller = new ContextController(deps);
  return h;
}

function restoreFetch(): void {
  delete (globalThis as { fetch?: unknown }).fetch;
}

test.afterEach(restoreFetch);

test('addFileContext:注入成功后弹信息提示(含路径)', async () => {
  const h = makeHarness();
  await h.controller.addFileContext('/proj/src/foo.ts');
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].text, /`src\/foo\.ts`/);
  assert.equal(h.infos.length, 1);
  assert.match(h.infos[0], /src\/foo\.ts/);
});

test('addFileContext:服务未就绪时先 ensureRunning,仍失败则警告且不注入', async () => {
  const h = makeHarness({ ready: false });
  // 让 ensureRunning 也返回失败
  const deps = h.controller as unknown as { deps: ControllerDeps };
  deps.deps.manager.ensureRunning = async () => ({ state: 'failed', url: null, error: null, owned: false });
  await h.controller.addFileContext('/proj/src/foo.ts');
  assert.equal(h.prompts.length, 0);
  assert.equal(h.warnings.length, 1);
});

test('askAboutFile:用户取消输入框 → 不注入', async () => {
  const h = makeHarness();
  h.inputAnswers = [undefined];
  await h.controller.askAboutFile('/proj/src/foo.ts');
  assert.equal(h.prompts.length, 0);
  assert.equal(h.inputs.length, 1);
});

test('askAboutFile:输入问题 → 注入问题+引用文案', async () => {
  const h = makeHarness();
  h.inputAnswers = ['这段代码有问题吗?'];
  await h.controller.askAboutFile('/proj/src/foo.ts');
  assert.equal(h.prompts.length, 1);
  assert.ok(h.prompts[0].text.includes('这段代码有问题吗?'));
  assert.ok(h.prompts[0].text.includes('`src/foo.ts`'));
});

test('sendSelection:注入附言+行号+代码块', async () => {
  const h = makeHarness();
  h.inputAnswers = ['看看这段'];
  await h.controller.sendSelection({ fileAbsPath: '/proj/src/foo.ts', startLine: 10, code: 'const a = 1;' });
  assert.equal(h.prompts.length, 1);
  assert.ok(h.prompts[0].text.includes('`src/foo.ts:10`'));
  assert.ok(h.prompts[0].text.includes('const a = 1;'));
});

test('autoInject:同 ref 3 秒内去重;成功后不弹提示', async () => {
  const h = makeHarness();
  await h.controller.autoInject('/proj/src/foo.ts');
  await h.controller.autoInject('/proj/src/foo.ts');
  assert.equal(h.prompts.length, 1);
  assert.equal(h.infos.length, 0);
});

test('autoInject:不同 ref 不去重', async () => {
  const h = makeHarness();
  await h.controller.autoInject('/proj/src/foo.ts');
  await h.controller.autoInject('/proj/src/bar.ts');
  assert.equal(h.prompts.length, 2);
});

test('API 失败:unsupported → 升级提示;rpc → 拒绝提示', async () => {
  const h = makeHarness();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: false, error: { code: 'x', message: 'boom' } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  await h.controller.addFileContext('/proj/src/foo.ts');
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /boom/);
});

test('toggleAutoFollow:取反写入设置', async () => {
  const h = makeHarness();
  h.autoFollow = false;
  h.controller.toggleAutoFollow();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.autoFollow, true);
});

test('registerWorkspace:调用 workspaceCreate(工作区切换后注册)', async () => {
  const h = makeHarness();
  await h.controller.registerWorkspace();
  assert.equal(h.prompts.length, 0); // 只注册不注入
});
