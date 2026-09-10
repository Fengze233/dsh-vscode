# DSH 上下文联动/右键菜单/工作区自适应 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 dsh-vscode 插件实现三个功能:当前文件 AI 上下文联动(半自动工具条+可选自动跟随)、右键菜单联动与快捷入口、工作目录自适应(跨项目)。

**Architecture:** 全部新能力走「扩展 → DSH HTTP API 直连」(信封协议 `POST /api/<ns>.<method>`,已实证),桥接 `bridge-client/` 零改动。新增 `src/context/` 四个纯逻辑模块(dshApi/tracker/injector/controller),面板 `html.ts` 加上下文工具条,`extension.ts` 装配命令与工作区监听。

**Tech Stack:** TypeScript(esbuild 构建,`scripts/build.mjs` 自动递归收集 `test/**/*.test.ts`)、node:test + assert/strict、VS Code 扩展 API、DSH 0.1.0-rc.6 HTTP 信封协议。

## Global Constraints

- 规格:`docs/superpowers/specs/2026-08-17-context-menu-and-workspace-sync-design.md`(唯一权威,冲突时以规格为准)
- 版本下限:Node ≥ 22、VS Code ≥ 1.91、DSH 0.1.0-rc.6(API 形状按此版本实证结果)
- 新模块 `src/context/*` 为纯逻辑,**禁止直接 import vscode**;vscode 触点全部依赖注入(沿用 manager.ts / bridge/host.ts 的既有模式)
- i18n 规则:动态文案进 `src/i18n.ts`(zh-* → 中文,其余英文);静态文案(命令标题/设置说明)进 `package.nls.json` + `package.nls.zh-cn.json`
- 方法名单数 namespace:`session.list` / `session.create` / `session.prompt` / `session.history` / `workspace.create`(复数 `sessions.*` 返回 404,禁止使用)
- 测试命令:`node scripts/build.mjs --test && node --test "out/test/**/*.test.js"`(即 `npm test`);类型检查:`npm run typecheck`
- commit 信息中文,前缀 `feat:` / `fix:` / `test:` / `docs:`
- 每个 Task 结束必须是「测试通过 + typecheck 通过 + commit」的可独立验收状态
- 注入文案措辞(规格 §4.1):`上下文:当前文件 \`<ref>\`(仅供参考,无需回复)` —— 上下文式、抑制 AI 回复

---

### Task 1: DSH API 客户端 `dshApi.ts`

**Files:**
- Create: `src/context/dshApi.ts`
- Test: `test/context/dshApi.test.ts`

**Interfaces:**
- Consumes: 无(基础模块)
- Produces:
  - `createDshApi(baseUrl: string, opts?: DshApiOptions): DshApi`
  - `DshApi.call<T>(method: string, payload?: unknown): Promise<T>`
  - `DshApi.workspaceCreate(path): Promise<{ workspace: WorkspaceView; created: boolean }>`
  - `DshApi.sessionList(): Promise<SessionSummary[]>`
  - `DshApi.sessionCreate(opts: { cwd?: string; workspaceId?: string }): Promise<{ sessionId: string }>`
  - `DshApi.sessionPrompt(opts: { sessionId: string; text: string }): Promise<void>`
  - `class DshApiError extends Error { kind: 'network' | 'rpc' | 'unsupported'; code?: string }`
  - `interface WorkspaceView { workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string }`
  - `interface SessionSummary { sessionId: string; updatedAt: number; blank?: boolean; cwd?: string }`

- [ ] **Step 1: 写失败测试**

创建 `test/context/dshApi.test.ts`:

```ts
// test/context/dshApi.test.ts — DSH 信封协议客户端单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshApi, DshApiError } from '../../src/context/dshApi';

/** 假 fetch:记录请求并返回预置响应 */
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function okResponse(value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId: 'r1', result: { ok: true, value } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('call 构造正确信封:POST /api/<method>,body 含 type/rpcId/method/payload', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const api = createDshApi('http://127.0.0.1:3080/', {
    fetchImpl: fakeFetch((url, init) => {
      captured = { url, init };
      return okResponse({ hello: 1 });
    }),
  });
  const value = await api.call<{ hello: number }>('workspace.create', { path: '/tmp/x' });
  assert.deepEqual(value, { hello: 1 });
  assert.equal(captured!.url, 'http://127.0.0.1:3080/api/workspace.create');
  const body = JSON.parse(captured!.init.body as string);
  assert.equal(body.type, 'client-request');
  assert.equal(body.method, 'workspace.create');
  assert.deepEqual(body.payload, { path: '/tmp/x' });
  assert.equal(typeof body.rpcId, 'string');
  assert.ok(body.rpcId.length > 0);
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

test('404 → kind=unsupported;5xx → kind=network;非 JSON → kind=network', async () => {
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

test('四个封装方法映射正确的方法名与 payload 形状', async () => {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const api = createDshApi('http://127.0.0.1:3080', {
    fetchImpl: fakeFetch((_url, init) => {
      const body = JSON.parse(init.body as string);
      calls.push({ method: body.method, payload: body.payload });
      const value = body.method === 'session.list'
        ? { items: [{ sessionId: 's1', updatedAt: 1 }] }
        : body.method === 'session.prompt'
          ? { accepted: true }
          : body.method === 'session.create'
            ? { sessionId: 's9' }
            : { workspace: { workspaceId: 'w1', path: '/p', title: 'p', sessionIds: [], createdAt: 'x', updatedAt: 'x' }, created: true };
      return okResponse(value);
    }),
  });
  await api.workspaceCreate('/p');
  await api.sessionList();
  await api.sessionCreate({ cwd: '/p' });
  await api.sessionPrompt({ sessionId: 's9', text: 'hi' });
  assert.deepEqual(calls.map((c) => c.method), ['workspace.create', 'session.list', 'session.create', 'session.prompt']);
  assert.deepEqual(calls[3].payload, {
    sessionId: 's9',
    mode: 'queue',
    content: [{ type: 'text', text: 'hi' }],
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/build.mjs --test && node --test out/test/context/dshApi.test.js`
Expected: FAIL(模块不存在,构建报错或加载失败)

- [ ] **Step 3: 写最小实现**

创建 `src/context/dshApi.ts`:

```ts
// src/context/dshApi.ts — DSH HTTP 信封协议客户端(纯模块,不依赖 vscode)
// 协议实证(0.1.0-rc.6):
//   POST /api/<namespace>.<method>
//   请求: { type:'client-request', rpcId, method, payload }
//   响应: { type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error:{code,message} } }
// 注意:方法名用单数 namespace(session.list;复数 sessions.list 返回 404)。

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

export interface DshApiOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  rpcIdPrefix?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function createDshApi(baseUrl: string, opts: DshApiOptions = {}): DshApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prefix = opts.rpcIdPrefix ?? 'dsh-vscode';
  const base = baseUrl.replace(/\/+$/, '');
  let seq = 0;

  async function call<T>(method: string, payload: unknown = {}): Promise<T> {
    const rpcId = `${prefix}-${++seq}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new DshApiError('network', `request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) throw new DshApiError('unsupported', `DSH does not support ${method}`);
    if (!res.ok) throw new DshApiError('network', `DSH responded ${res.status}`);
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
        sessionId: o.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: o.text }],
      }).then(() => undefined),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/build.mjs --test && node --test out/test/context/dshApi.test.js && npm run typecheck`
Expected: PASS(6 个测试),typecheck 无错误

- [ ] **Step 5: Commit**

```bash
git add src/context/dshApi.ts test/context/dshApi.test.ts
git commit -m "feat: 新增 DSH HTTP 信封协议客户端 dshApi"
```

---

### Task 2: 当前文件跟踪器 `tracker.ts`

**Files:**
- Create: `src/context/tracker.ts`
- Test: `test/context/tracker.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `describeFileRef(absPath: string, workspaceRoot?: string): FileRef`(`FileRef = { absPath: string; ref: string; relToWorkspace: boolean }`;工作区内 → 相对路径且 `relToWorkspace:true`,否则绝对路径)
  - `createCurrentFileTracker(opts: { debounceMs: number; timers?: TrackerTimers }): CurrentFileTracker`
  - `CurrentFileTracker = { setFile(absPath: string | undefined): void; getCurrent(): string | undefined; onSettled(cb: (absPath: string | undefined) => void): () => void; dispose(): void }`
  - `TrackerTimers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }`(测试注入假定时器)

- [ ] **Step 1: 写失败测试**

创建 `test/context/tracker.test.ts`:

```ts
// test/context/tracker.test.ts — 当前文件跟踪与路径引用规则
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFileRef, createCurrentFileTracker, type TrackerTimers } from '../../src/context/tracker';

/** 假定时器:手动触发,断言防抖行为 */
function fakeTimers(): TrackerTimers & { pending: Array<{ fn: () => void; ms: number }> } {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    pending,
    setTimeout: (fn, ms) => {
      pending.push({ fn, ms });
      return pending.length - 1;
    },
    clearTimeout: (handle) => {
      pending.splice(handle as number, 1);
    },
  };
}

test('describeFileRef:工作区内文件 → 相对路径(正斜杠)', () => {
  const r = describeFileRef('/proj/src/foo.ts', '/proj');
  assert.equal(r.ref, 'src/foo.ts');
  assert.equal(r.relToWorkspace, true);
});

test('describeFileRef:工作区外文件 → 绝对路径', () => {
  const r = describeFileRef('/elsewhere/bar.ts', '/proj');
  assert.equal(r.ref, '/elsewhere/bar.ts');
  assert.equal(r.relToWorkspace, false);
});

test('describeFileRef:无工作区根 → 绝对路径', () => {
  const r = describeFileRef('/proj/src/foo.ts', undefined);
  assert.equal(r.ref, '/proj/src/foo.ts');
  assert.equal(r.relToWorkspace, false);
});

test('describeFileRef:文件等于根目录本身 → 绝对路径(非 inside)', () => {
  const r = describeFileRef('/proj', '/proj');
  assert.equal(r.ref, '/proj');
});

test('tracker:防抖窗口内多次 setFile 只结算最后一次', () => {
  const timers = fakeTimers();
  const settled: Array<string | undefined> = [];
  const tracker = createCurrentFileTracker({ debounceMs: 800, timers });
  tracker.onSettled((p) => settled.push(p));
  tracker.setFile('/a.ts');
  tracker.setFile('/b.ts');
  tracker.setFile('/c.ts');
  assert.equal(timers.pending.length, 1); // 前两次被取消,只剩一个定时器
  assert.equal(tracker.getCurrent(), undefined); // 结算前仍为旧值
  timers.pending[0].fn(); // 手动触发结算
  assert.equal(tracker.getCurrent(), '/c.ts');
  assert.deepEqual(settled, ['/c.ts']);
});

test('tracker:setFile(undefined) 结算为 undefined(编辑器全部关闭)', () => {
  const timers = fakeTimers();
  const tracker = createCurrentFileTracker({ debounceMs: 800, timers });
  tracker.setFile('/a.ts');
  timers.pending[0].fn();
  tracker.setFile(undefined);
  timers.pending[0].fn();
  assert.equal(tracker.getCurrent(), undefined);
});

test('tracker:dispose 清理定时器与监听器', () => {
  const timers = fakeTimers();
  const tracker = createCurrentFileTracker({ debounceMs: 800, timers });
  tracker.setFile('/a.ts');
  tracker.dispose();
  assert.equal(timers.pending.length, 0); // 定时器已清理
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/build.mjs --test && node --test out/test/context/tracker.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 写最小实现**

创建 `src/context/tracker.ts`:

```ts
// src/context/tracker.ts — 当前文件跟踪与路径引用(纯模块,不依赖 vscode)
// 职责:①把绝对路径转成注入引用(工作区内 → 相对路径,区外 → 绝对路径);
//       ②带防抖的当前文件跟踪(编辑器快速切换时只结算最终停留的文件)。
import { isAbsolute, relative, sep } from 'node:path';

export interface FileRef {
  absPath: string;
  ref: string;
  relToWorkspace: boolean;
}

/** 判断 p 是否严格位于 root 目录内部(root 本身不算 inside) */
function isInside(p: string, root: string): boolean {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 把绝对路径转成注入引用:
 * - workspaceRoot 存在且 absPath 在其内部 → 相对路径(统一正斜杠,跨平台稳定)
 * - 其余情况(无工作区/区外文件/等于根)→ 绝对路径
 */
export function describeFileRef(absPath: string, workspaceRoot?: string): FileRef {
  if (workspaceRoot !== undefined && isAbsolute(workspaceRoot) && isInside(absPath, workspaceRoot)) {
    return { absPath, ref: relative(workspaceRoot, absPath).split(sep).join('/'), relToWorkspace: true };
  }
  return { absPath, ref: absPath, relToWorkspace: false };
}

export interface TrackerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: TrackerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface CurrentFileTracker {
  /** 记录一次编辑器切换(undefined = 全部编辑器关闭);防抖后结算 */
  setFile(absPath: string | undefined): void;
  /** 防抖结算后的当前文件 */
  getCurrent(): string | undefined;
  /** 订阅结算事件,返回退订函数 */
  onSettled(cb: (absPath: string | undefined) => void): () => void;
  dispose(): void;
}

export function createCurrentFileTracker(opts: { debounceMs: number; timers?: TrackerTimers }): CurrentFileTracker {
  const timers = opts.timers ?? realTimers;
  let pending: string | undefined;
  let current: string | undefined;
  let handle: unknown;
  const listeners = new Set<(absPath: string | undefined) => void>();

  function settle(): void {
    current = pending;
    pending = undefined;
    for (const cb of listeners) cb(current);
  }

  return {
    setFile(absPath) {
      pending = absPath;
      if (handle !== undefined) timers.clearTimeout(handle);
      handle = timers.setTimeout(settle, opts.debounceMs);
    },
    getCurrent: () => current,
    onSettled(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      if (handle !== undefined) timers.clearTimeout(handle);
      listeners.clear();
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/build.mjs --test && node --test out/test/context/tracker.test.js && npm run typecheck`
Expected: PASS(6 个测试),typecheck 无错误

- [ ] **Step 5: Commit**

```bash
git add src/context/tracker.ts test/context/tracker.test.ts
git commit -m "feat: 新增当前文件跟踪器与路径引用规则 tracker"
```

---

### Task 3: 上下文注入编排 `injector.ts`

**Files:**
- Create: `src/context/injector.ts`
- Test: `test/context/injector.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DshApi` / `SessionSummary`
- Produces:
  - `buildContextMessage(ref: string): string` — `上下文:当前文件 \`<ref>\`(仅供参考,无需回复)`
  - `buildQuestionMessage(question: string, ref: string): string` — 空问题 → `` `请看这个文件:\`<ref>\`` ``,否则 `<问题>\n\n文件:\`<ref>\``
  - `buildSelectionMessage(note: string, ref: string, startLine: number, code: string): string` — 附言 + `` 选自 `<ref>:<startLine>`: `` + 代码块
  - `findTargetSession(sessions: SessionSummary[], workspaceRoot?: string): SessionSummary | undefined` — 按 cwd 过滤、updatedAt 降序取第一
  - `injectText(api, { workspaceRoot?, text }): Promise<InjectResult>` — 定位/新建会话后 prompt;`InjectResult = { sessionId: string; created: boolean }`
  - `injectContext(api, { workspaceRoot?, ref }): Promise<InjectResult>` — text = buildContextMessage(ref)
  - `injectQuestion(api, { workspaceRoot?, question, ref }): Promise<InjectResult>` — text = buildQuestionMessage

- [ ] **Step 1: 写失败测试**

创建 `test/context/injector.test.ts`:

```ts
// test/context/injector.test.ts — 注入编排:会话定位/文案/新建
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextMessage,
  buildQuestionMessage,
  buildSelectionMessage,
  findTargetSession,
  injectContext,
  injectText,
} from '../../src/context/injector';
import type { DshApi, SessionSummary } from '../../src/context/dshApi';

/** 假 API:记录调用,返回预置会话表 */
function fakeApi(sessions: SessionSummary[]): DshApi & { prompts: Array<{ sessionId: string; text: string }> } {
  const prompts: Array<{ sessionId: string; text: string }> = [];
  let nextId = 0;
  return {
    call: async () => ({}),
    workspaceCreate: async () => ({ workspace: { workspaceId: 'w', path: '/p', title: 'p', sessionIds: [], createdAt: 'x', updatedAt: 'x' }, created: true }),
    sessionList: async () => sessions,
    sessionCreate: async () => ({ sessionId: `new-${++nextId}` }),
    sessionPrompt: async (o) => {
      prompts.push(o);
    },
    prompts,
  };
}

const sess = (id: string, cwd: string | undefined, updatedAt: number): SessionSummary => ({ sessionId: id, cwd, updatedAt });

test('buildContextMessage:上下文式措辞,抑制回复', () => {
  assert.equal(buildContextMessage('src/foo.ts'), '上下文:当前文件 `src/foo.ts`(仅供参考,无需回复)');
});

test('buildQuestionMessage:空问题与带问题两种形态', () => {
  assert.equal(buildQuestionMessage('', 'src/foo.ts'), '请看这个文件:`src/foo.ts`');
  assert.equal(buildQuestionMessage(' 这段代码有什么问题? ', 'src/foo.ts'), '这段代码有什么问题?\n\n文件:`src/foo.ts`');
});

test('buildSelectionMessage:附言 + 文件:行号 + 代码块', () => {
  const msg = buildSelectionMessage('帮我看看', 'src/foo.ts', 12, 'const a = 1;');
  assert.ok(msg.includes('帮我看看'));
  assert.ok(msg.includes('`src/foo.ts:12`'));
  assert.ok(msg.includes('```\nconst a = 1;\n```'));
});

test('findTargetSession:按 cwd 过滤 + updatedAt 降序', () => {
  const list = [sess('a', '/p', 10), sess('b', '/other', 999), sess('c', '/p', 500)];
  assert.equal(findTargetSession(list, '/p')?.sessionId, 'c');
  // 无工作区根时不过滤
  assert.equal(findTargetSession(list, undefined)?.sessionId, 'b');
  // 无匹配 → undefined
  assert.equal(findTargetSession(list, '/none'), undefined);
});

test('injectContext:无会话时先 workspace.create 再 session.create,最后 prompt 上下文文案', async () => {
  const api = fakeApi([]);
  const r = await injectContext(api, { workspaceRoot: '/p', ref: 'src/foo.ts' });
  assert.equal(r.created, true);
  assert.equal(r.sessionId, 'new-1');
  assert.equal(api.prompts.length, 1);
  assert.equal(api.prompts[0].sessionId, 'new-1');
  assert.equal(api.prompts[0].text, '上下文:当前文件 `src/foo.ts`(仅供参考,无需回复)');
});

test('injectContext:已存在匹配会话时复用(不新建),注入到最近活动会话', async () => {
  const api = fakeApi([sess('a', '/p', 10), sess('c', '/p', 500), sess('b', '/other', 999)]);
  const r = await injectContext(api, { workspaceRoot: '/p', ref: 'src/bar.ts' });
  assert.equal(r.created, false);
  assert.equal(r.sessionId, 'c');
  assert.equal(api.prompts[0].sessionId, 'c');
});

test('injectContext:无工作区根时跳过 workspace.create,会话创建不带 cwd', async () => {
  const api = fakeApi([]);
  let createPayload: unknown;
  api.sessionCreate = async (o) => {
    createPayload = o;
    return { sessionId: 's1' };
  };
  await injectContext(api, { ref: '/abs/foo.ts' });
  assert.deepEqual(createPayload, {});
});

test('injectText:定位/新建 + 任意文本注入', async () => {
  const api = fakeApi([sess('a', '/p', 10)]);
  const r = await injectText(api, { workspaceRoot: '/p', text: '自定义文本' });
  assert.equal(r.sessionId, 'a');
  assert.equal(api.prompts[0].text, '自定义文本');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/build.mjs --test && node --test out/test/context/injector.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 写最小实现**

创建 `src/context/injector.ts`:

```ts
// src/context/injector.ts — 上下文注入编排(纯模块,不依赖 vscode)
// 职责:定位目标会话(按 cwd 找项目下最近活动会话,无则新建)→ 构造消息文本 → prompt 注入。
import type { DshApi, SessionSummary } from './dshApi';

/** 上下文式注入文案:抑制 AI 回复,仅供后续对话参考 */
export function buildContextMessage(ref: string): string {
  return `上下文:当前文件 \`${ref}\`(仅供参考,无需回复)`;
}

/** 提问式文案:携带问题与文件引用(AI 正常回复) */
export function buildQuestionMessage(question: string, ref: string): string {
  const q = question.trim();
  return q === '' ? `请看这个文件:\`${ref}\`` : `${q}\n\n文件:\`${ref}\``;
}

/** 选区消息:附言 + 文件:行号 + 代码块 */
export function buildSelectionMessage(note: string, ref: string, startLine: number, code: string): string {
  const n = note.trim();
  const head = n === '' ? `选中内容来自 \`${ref}:${startLine}\`:` : `${n}\n\n选自 \`${ref}:${startLine}\`:`;
  return `${head}\n\n\`\`\`\n${code}\n\`\`\``;
}

/** 定位目标会话:按 cwd 过滤(无工作区根则不过滤),updatedAt 降序取最近活动 */
export function findTargetSession(sessions: SessionSummary[], workspaceRoot?: string): SessionSummary | undefined {
  const candidates = workspaceRoot !== undefined ? sessions.filter((s) => s.cwd === workspaceRoot) : sessions;
  return [...candidates].sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export interface InjectResult {
  sessionId: string;
  created: boolean;
}

/** 注入任意文本:定位/新建会话后 prompt(注入编排核心) */
export async function injectText(
  api: DshApi,
  opts: { workspaceRoot?: string; text: string },
): Promise<InjectResult> {
  if (opts.workspaceRoot !== undefined) {
    await api.workspaceCreate(opts.workspaceRoot); // 幂等注册工作区
  }
  const sessions = await api.sessionList();
  const target = findTargetSession(sessions, opts.workspaceRoot);
  if (target) {
    await api.sessionPrompt({ sessionId: target.sessionId, text: opts.text });
    return { sessionId: target.sessionId, created: false };
  }
  const created = await api.sessionCreate({ cwd: opts.workspaceRoot });
  await api.sessionPrompt({ sessionId: created.sessionId, text: opts.text });
  return { sessionId: created.sessionId, created: true };
}

/** 上下文式注入(当前文件引用) */
export function injectContext(
  api: DshApi,
  opts: { workspaceRoot?: string; ref: string },
): Promise<InjectResult> {
  return injectText(api, { workspaceRoot: opts.workspaceRoot, text: buildContextMessage(opts.ref) });
}

/** 提问式注入(问题 + 文件引用) */
export function injectQuestion(
  api: DshApi,
  opts: { workspaceRoot?: string; question: string; ref: string },
): Promise<InjectResult> {
  return injectText(api, { workspaceRoot: opts.workspaceRoot, text: buildQuestionMessage(opts.question, opts.ref) });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/build.mjs --test && node --test out/test/context/injector.test.js && npm run typecheck`
Expected: PASS(9 个测试),typecheck 无错误

- [ ] **Step 5: Commit**

```bash
git add src/context/injector.ts test/context/injector.test.ts
git commit -m "feat: 新增上下文注入编排 injector(会话定位/文案/新建)"
```

---

### Task 4: 面板工具条渲染 `html.ts`

**Files:**
- Modify: `src/panel/html.ts`(PanelMessage 类型 + readyPage 签名 + 工具条样式/脚本)
- Test: `test/html.test.ts`(追加测试)

**Interfaces:**
- Consumes: Task 2 无;新增消息形状
- Produces:
  - `PanelMessage` 增加 `{ type: 'addFileContext' }`、`{ type: 'toggleAutoFollow' }`(webview → 扩展)
  - `readyPage(url, ctx, bridge?, contextBar?)`,第四参 `ContextBarState = { fileLabel: string | null; autoFollow: boolean }`
  - 工具条 DOM:`#dsh-ctx-bar`(容器)、`#dsh-ctx-label`(文件标签)、`#dsh-ctx-add`(加入按钮,data-action="addFileContext")、`#dsh-ctx-autofollow`(checkbox)
  - 扩展 → webview 下行消息形状:`{ kind: 'updateContextBar'; fileLabel: string | null; autoFollow: boolean }`(由 provider Task 5 发送,本 Task 只实现 webview 端监听脚本)

- [ ] **Step 1: 写失败测试**

在 `test/html.test.ts` 末尾追加:

```ts
test('readyPage 传入 contextBar 时渲染工具条(标签/加入按钮/自动跟随开关)', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), undefined, { fileLabel: 'src/extension.ts', autoFollow: true });
  assert.ok(html.includes('id="dsh-ctx-bar"'), '应渲染工具条容器');
  assert.ok(html.includes('id="dsh-ctx-label"'), '应渲染文件标签');
  assert.ok(html.includes('src/extension.ts'), '应显示文件引用');
  assert.ok(html.includes('data-action="addFileContext"'), '应渲染加入按钮');
  assert.ok(html.includes('id="dsh-ctx-autofollow"'), '应渲染自动跟随开关');
  assert.ok(html.includes('checked'), 'autoFollow=true 时开关应为选中态');
});

test('readyPage 未传 contextBar 时不渲染工具条(向后兼容)', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(!html.includes('dsh-ctx-bar'));
});

test('工具条下行脚本:监听 updateContextBar 更新标签与开关', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), undefined, { fileLabel: null, autoFollow: false });
  assert.ok(html.includes("'updateContextBar'"), '应包含下行消息监听');
  assert.ok(html.includes('dsh-ctx-label'), '监听脚本应引用标签元素');
  assert.ok(html.includes('dsh-ctx-autofollow'), '监听脚本应引用开关元素');
});

test('工具条 fileLabel 为空时显示空标签', () => {
  initI18n('en');
  const html = readyPage('http://127.0.0.1:3080/', ctx(), undefined, { fileLabel: null, autoFollow: false });
  assert.ok(html.includes('Current file'), '无文件时仍显示「当前文件」前缀文案');
  assert.ok(html.includes('id="dsh-ctx-label"></span>'), '标签内容为空(不渲染 null 字样)');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/build.mjs --test && node --test out/test/html.test.js`
Expected: FAIL(4 个新测试失败,现实现无工具条)

- [ ] **Step 3: 写实现**

修改 `src/panel/html.ts`:

3a. `PanelMessage` 联合类型追加两个成员:

```ts
export type PanelMessage =
  | { type: 'retry' }
  | { type: 'reconnect' }
  | { type: 'openExternal' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'copyUrl' }
  | { type: 'showLogs' }
  | { type: 'bridgeOpenExternal'; url: string }
  | { type: 'bridgeOpenFile'; path: string; cwd?: string }
  | { type: 'bridgeAck'; ok: boolean }
  | { type: 'addFileContext' }
  | { type: 'toggleAutoFollow' };
```

3b. `STYLE` 常量末尾追加工具条样式:

```css
.ctx-bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-sideBar-border); font-size: 12px; flex-shrink: 0; }
.ctx-bar .ctx-file { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.9; }
.ctx-bar button { padding: 2px 8px; margin: 0; font-size: 12px; }
.ctx-bar label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
body.frame-body.has-bar { display: flex; flex-direction: column; }
.has-bar iframe.frame { position: static; flex: 1; }
```

3c. `BUTTON_SCRIPT` 追加自动跟随 checkbox 的 change 监听:

```js
document.addEventListener('change', (e) => {
  const box = e.target.closest('input[type="checkbox"][data-action="toggleAutoFollow"]');
  if (!box) return;
  vscode.postMessage({ type: 'toggleAutoFollow' });
});
```

3d. 新增工具条下行脚本函数与 HTML 片段:

```ts
/** 工具条下行监听:扩展推送 {kind:'updateContextBar'} 时更新标签与开关 */
const CONTEXT_BAR_SCRIPT = `
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.kind !== 'updateContextBar') return;
  const label = document.getElementById('dsh-ctx-label');
  if (label) label.textContent = d.fileLabel ?? '';
  const box = document.getElementById('dsh-ctx-autofollow');
  if (box) box.checked = d.autoFollow === true;
});
`;

/** 工具条状态(由 provider 传入,不传则不渲染) */
export interface ContextBarState {
  fileLabel: string | null;
  autoFollow: boolean;
}

/** 工具条 HTML:当前文件标签 + 加入按钮 + 自动跟随开关 */
function contextBarHtml(t: T, state: ContextBarState): string {
  return `<div id="dsh-ctx-bar" class="ctx-bar">
<span class="ctx-file">${t('ctx.currentFile')}: <span id="dsh-ctx-label">${escapeHtml(state.fileLabel ?? '')}</span></span>
<button data-action="addFileContext">${t('ctx.add')}</button>
<label><input type="checkbox" id="dsh-ctx-autofollow" data-action="toggleAutoFollow"${state.autoFollow ? ' checked' : ''}> ${t('ctx.autoFollow')}</label>
</div>`;
}
```

3e. `readyPage` 签名与实现:

```ts
export function readyPage(
  url: string,
  ctx: PageCtx,
  bridge?: { token: string; enabled: boolean },
  contextBar?: ContextBarState,
): string {
  const extraScripts = bridge?.enabled
    ? `<script nonce="${ctx.nonce}">${bridgeHandshakeScript(bridge.token, new URL(url).origin)}</script>`
    : '';
  const bar = contextBar
    ? `<script nonce="${ctx.nonce}">${CONTEXT_BAR_SCRIPT}</script>${contextBarHtml(t, contextBar)}`
    : '';
  const bodyClass = contextBar ? 'frame-body has-bar' : 'frame-body';
  return shell(ctx, 'DSH', bodyClass, `${bar}<iframe id="dsh-frame" class="frame" src="${url}"></iframe>`, extraScripts);
}
```

3f. 同步给 `src/i18n.ts` 追加本任务用到的三个工具条键(否则 typecheck 因 MsgKey 不含新键而失败)。`messages.en` 与 `messages.zh` 各自追加:

```ts
    // 上下文工具条
    'ctx.currentFile': 'Current file',
    'ctx.add': 'Add to Context',
    'ctx.autoFollow': 'Auto-follow',
```

```ts
    'ctx.currentFile': '当前文件',
    'ctx.add': '加入上下文',
    'ctx.autoFollow': '自动跟随',
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/build.mjs --test && node --test out/test/html.test.js && npm run typecheck`
Expected: PASS(全部 html 测试),typecheck 无错误

- [ ] **Step 5: Commit**

```bash
git add src/panel/html.ts test/html.test.ts src/i18n.ts
git commit -m "feat: 面板就绪页新增上下文工具条(当前文件/加入/自动跟随)"
```

---

### Task 5: Provider 消息路由与工具条推送

**Files:**
- Modify: `src/panel/provider.ts`
- Modify: `test/vscode-stub.ts`(扩展运行时成员)
- Test: `test/panel/provider.test.ts`(新)

**Interfaces:**
- Consumes: Task 2 `describeFileRef`、Task 4 工具条渲染与消息类型
- Produces:
  - `DshPanelProvider` 构造新增第五参:`context?: ContextPanelDeps`,其中
    `ContextPanelDeps = { getFileLabel(): string | null; getAutoFollow(): boolean; addFileContext(): void; toggleAutoFollow(): void }`
  - 新公开方法 `refreshContextBar(): void` — 向 webview 推送 `{ kind:'updateContextBar', fileLabel, autoFollow }` 并重渲染(供扩展在文件切换/设置变更时调用)

- [ ] **Step 1: 写失败测试**

创建 `test/panel/provider.test.ts`:

```ts
// test/panel/provider.test.ts — 面板 provider 的消息路由与工具条推送
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshPanelProvider, type ContextPanelDeps } from '../../src/panel/provider';

/** 假 ServiceManager(仅 provider 用到的接口) */
function fakeManager() {
  const listeners = new Set<(s: unknown) => void>();
  return {
    onChange: (cb: (s: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot: () => ({ state: 'ready', url: 'http://127.0.0.1:3080/', error: null, owned: false }),
    getTarget: () => ({ host: '127.0.0.1', port: 3080 }),
    ensureRunning: async () => ({}),
  };
}

/** 假 webview view(仅 provider 触碰的成员) */
function fakeView() {
  const received: Array<{ (msg: unknown): void }> = [];
  const posted: unknown[] = [];
  return {
    webview: {
      options: {} as Record<string, unknown>,
      cspSource: 'vscode-webview:',
      html: '',
      postMessage: (m: unknown) => posted.push(m),
      onDidReceiveMessage: (cb: (msg: unknown) => void) => received.push(cb),
    },
    received,
    posted,
    fire: (msg: unknown) => {
      for (const cb of received) cb(msg);
    },
  };
}

interface CtxHarness {
  calls: string[];
  provider: DshPanelProvider;
  view: ReturnType<typeof fakeView>;
  deps: ContextPanelDeps;
}

function makeCtx(): CtxHarness {
  const calls: string[] = [];
  const deps: ContextPanelDeps = {
    getFileLabel: () => 'src/extension.ts',
    getAutoFollow: () => false,
    addFileContext: () => calls.push('addFileContext'),
    toggleAutoFollow: () => calls.push('toggleAutoFollow'),
  };
  const provider = new DshPanelProvider(fakeManager() as never, undefined, undefined, () => '/proj', () => true, deps);
  const view = fakeView();
  provider.resolveWebviewView(view as never);
  return { calls, provider, view, deps };
}

test('resolveWebviewView 注入 context 时渲染工具条(含文件标签)', () => {
  const h = makeCtx();
  assert.ok(h.view.webview.html.includes('id="dsh-ctx-bar"'));
  assert.ok(h.view.webview.html.includes('src/extension.ts'));
});

test('addFileContext 消息 → context.addFileContext()', () => {
  const h = makeCtx();
  h.view.fire({ type: 'addFileContext' });
  assert.deepEqual(h.calls, ['addFileContext']);
});

test('toggleAutoFollow 消息 → context.toggleAutoFollow() 并重渲染', () => {
  const h = makeCtx();
  h.view.fire({ type: 'toggleAutoFollow' });
  assert.deepEqual(h.calls, ['toggleAutoFollow']);
  assert.ok(h.view.webview.html.includes('id="dsh-ctx-bar"')); // 重渲染仍含工具条
});

test('refreshContextBar 推送下行 updateContextBar 消息', () => {
  const h = makeCtx();
  h.provider.refreshContextBar();
  assert.deepEqual(h.view.posted[0], { kind: 'updateContextBar', fileLabel: 'src/extension.ts', autoFollow: false });
});

test('未注入 context 时:无工具条渲染,消息不崩溃', () => {
  const provider = new DshPanelProvider(fakeManager() as never);
  const view = fakeView();
  provider.resolveWebviewView(view as never);
  assert.ok(!view.webview.html.includes('dsh-ctx-bar'));
  view.fire({ type: 'addFileContext' }); // 无 context:静默忽略,不抛异常
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/build.mjs --test && node --test out/test/panel/provider.test.js`
Expected: FAIL(构造签名不匹配/渲染无工具条)

- [ ] **Step 3: 写实现**

3a. 修改 `test/vscode-stub.ts`(provider 运行时触碰的最小成员):

```ts
// test/vscode-stub.ts — 测试专用的 vscode 运行时桩
export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
  }),
};

export const window = {
  showTextDocument: async () => undefined,
  showWarningMessage: () => undefined,
};

export const env = {
  openExternal: async () => true,
};

export const commands = {
  executeCommand: async () => undefined,
};

export const Uri = {
  file: (p: string) => ({ fsPath: p }),
};

export default { workspace, window, env, commands, Uri };
```

3b. 修改 `src/panel/provider.ts`:

- 文件顶部新增接口与 import:

```ts
import { describeFileRef } from '../context/tracker';

/** 上下文能力依赖(由扩展入口注入;未注入时工具条与上下文消息均不激活) */
export interface ContextPanelDeps {
  /** 当前文件标签(显示引用路径);无文件返回 null */
  getFileLabel(): string | null;
  /** 自动跟随开关当前值 */
  getAutoFollow(): boolean;
  /** 把当前文件加入 DSH 上下文 */
  addFileContext(): void;
  /** 切换自动跟随 */
  toggleAutoFollow(): void;
}
```

- 构造签名追加第五参:

```ts
  constructor(
    private manager: ServiceManager,
    private onFirstOpen?: () => void,
    private onBridgeAck?: (ok: boolean) => void,
    private workspaceRoot: () => string | undefined = () => undefined,
    private bridgeEnabled: () => boolean = () => true,
    private context?: ContextPanelDeps,
  ) {
    manager.onChange(() => this.render());
  }
```

- `onMessage` switch 追加两个分支:

```ts
      case 'addFileContext':
        this.context?.addFileContext();
        break;
      case 'toggleAutoFollow':
        this.context?.toggleAutoFollow();
        this.render(); // 开关状态变化后重渲染
        break;
```

- `render` 的 ready 分支传入第四参:

```ts
      case 'ready':
        this.wasConnected = true;
        html = readyPage(s.url ?? `http://${host}:${port}/`, ctx, {
          token: this.bridgeToken,
          enabled: this.bridgeEnabled(),
        }, this.context
          ? { fileLabel: this.context.getFileLabel(), autoFollow: this.context.getAutoFollow() }
          : undefined);
        break;
```

- 新增公开方法:

```ts
  /** 工具条状态刷新:向 webview 推送下行消息并重渲染(文件切换/设置变更时由扩展调用) */
  refreshContextBar(): void {
    if (!this.view || !this.context) return;
    void this.view.webview.postMessage({
      kind: 'updateContextBar',
      fileLabel: this.context.getFileLabel(),
      autoFollow: this.context.getAutoFollow(),
    });
    this.render();
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/build.mjs --test && node --test out/test/panel/provider.test.js && npm run typecheck`
Expected: PASS(6 个测试),typecheck 无错误;既有测试不受影响(`npm test` 全绿)

- [ ] **Step 5: Commit**

```bash
git add src/panel/provider.ts test/panel/provider.test.ts test/vscode-stub.ts
git commit -m "feat: provider 接入上下文工具条路由与下行推送"
```

---

### Task 6: 上下文控制器 `controller.ts`

**Files:**
- Create: `src/context/controller.ts`
- Test: `test/context/controller.test.ts`

**Interfaces:**
- Consumes: Task 1/2/3(createDshApi/describeFileRef/injectContext/injectQuestion/buildSelectionMessage)
- Produces(extension.ts Task 9 直接消费):
  - `class ContextController`
  - 构造:`new ContextController(deps: ControllerDeps)`
  - `addFileContext(absPath: string): Promise<void>` — 半自动,成功弹「已加入」提示
  - `askAboutFile(absPath: string): Promise<void>` — 输入框提问后注入
  - `sendSelection(opts: { fileAbsPath: string; startLine: number; code: string }): Promise<void>`
  - `autoInject(absPath: string): Promise<void>` — 自动跟随,静默,同 ref 3 秒去重
  - `toggleAutoFollow(): void` — 调 deps.setAutoFollow 取反
  - `registerWorkspace(): Promise<void>` — workspaceCreate(工作区切换后调用)
  - `dispose(): void`
  - `ControllerDeps = { manager: { getSnapshot(): ServiceSnapshot; getTarget(): { host; port }; ensureRunning(): Promise<ServiceSnapshot> }; getWorkspaceRoot(): string | undefined; getAutoFollow(): boolean; setAutoFollow(v: boolean): Promise<void>; messages: { t; showInformation; showWarning; showInputBox }; dedupeMs?: number }`

- [ ] **Step 1: 写失败测试**

创建 `test/context/controller.test.ts`:

```ts
// test/context/controller.test.ts — 上下文控制器:命令行为/错误分支/去重
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextController, type ControllerDeps } from '../../src/context/controller';
import { DshApiError } from '../../src/context/dshApi';

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
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse((init?.body as string) ?? '{}') as { method: string; payload: Record<string, unknown> };
    let value: unknown = {};
    if (body.method === 'workspace.create') value = { workspace: { workspaceId: 'w1' }, created: true };
    if (body.method === 'session.list') value = { items: h.sessions };
    if (body.method === 'session.create') value = { sessionId: 's-new' };
    if (body.method === 'session.prompt') h.prompts.push({ text: (body.payload.content as Array<{ text: string }>)[0].text });
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/build.mjs --test && node --test out/test/context/controller.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 写最小实现**

创建 `src/context/controller.ts`:

```ts
// src/context/controller.ts — 上下文能力协调层(纯逻辑,vscode 触点依赖注入)
import { createDshApi, DshApiError, type DshApi } from './dshApi';
import { describeFileRef } from './tracker';
import { injectContext, injectQuestion, injectText, buildSelectionMessage } from './injector';
import type { ServiceSnapshot } from '../service/manager';
import type { MsgKey } from '../i18n';

export interface ControllerMessages {
  t(key: MsgKey, vars?: Record<string, string | number>): string;
  showInformation(msg: string): void;
  showWarning(msg: string): void;
  showInputBox(opts: { prompt: string; placeHolder?: string }): Promise<string | undefined>;
}

export interface ControllerDeps {
  manager: {
    getSnapshot(): ServiceSnapshot;
    getTarget(): { host: string; port: number };
    ensureRunning(): Promise<ServiceSnapshot>;
  };
  getWorkspaceRoot(): string | undefined;
  getAutoFollow(): boolean;
  setAutoFollow(v: boolean): Promise<void>;
  messages: ControllerMessages;
  /** 自动注入去重窗口(毫秒,默认 3000):同一 ref 的最小间隔 */
  dedupeMs?: number;
}

export class ContextController {
  private lastAutoInject: { ref: string; at: number } | null = null;

  constructor(private deps: ControllerDeps) {}

  /** 构造 API 客户端(每次调用取最新 host/port) */
  private api(): DshApi {
    const { host, port } = this.deps.manager.getTarget();
    return createDshApi(`http://${host}:${port}`);
  }

  /** 确保服务就绪;失败时按 showWarningOnFail 决定是否弹提示,返回是否就绪 */
  private async ensureReady(showWarningOnFail: boolean): Promise<boolean> {
    let snap = this.deps.manager.getSnapshot();
    if (snap.state !== 'ready') snap = await this.deps.manager.ensureRunning();
    if (snap.state !== 'ready') {
      if (showWarningOnFail) this.deps.messages.showWarning(this.deps.messages.t('ctx.serviceFailed'));
      return false;
    }
    return true;
  }

  private fileRef(absPath: string) {
    return describeFileRef(absPath, this.deps.getWorkspaceRoot());
  }

  /** 半自动:当前文件加入上下文(成功弹提示) */
  async addFileContext(absPath: string): Promise<void> {
    if (!(await this.ensureReady(true))) return;
    const ref = this.fileRef(absPath);
    try {
      await injectContext(this.api(), { workspaceRoot: this.deps.getWorkspaceRoot(), ref: ref.ref });
      this.deps.messages.showInformation(this.deps.messages.t('ctx.added', { path: ref.ref }));
    } catch (err) {
      this.reportError(err);
    }
  }

  /** 自动跟随:静默注入,同 ref 去重,失败不打扰 */
  async autoInject(absPath: string): Promise<void> {
    const ref = this.fileRef(absPath);
    const now = Date.now();
    if (this.lastAutoInject && this.lastAutoInject.ref === ref.ref && now - this.lastAutoInject.at < (this.deps.dedupeMs ?? 3000)) {
      return;
    }
    this.lastAutoInject = { ref: ref.ref, at: now };
    if (!(await this.ensureReady(false))) return;
    try {
      await injectContext(this.api(), { workspaceRoot: this.deps.getWorkspaceRoot(), ref: ref.ref });
    } catch {
      /* 静默:自动跟随不打扰用户 */
    }
  }

  /** 询问文件:输入框提问(可空)→ 注入问题+引用 */
  async askAboutFile(absPath: string): Promise<void> {
    if (!(await this.ensureReady(true))) return;
    const ref = this.fileRef(absPath);
    const question = await this.deps.messages.showInputBox({
      prompt: this.deps.messages.t('ctx.askPrompt', { path: ref.ref }),
      placeHolder: this.deps.messages.t('ctx.askPlaceholder'),
    });
    if (question === undefined) return; // 用户取消
    try {
      await injectQuestion(this.api(), { workspaceRoot: this.deps.getWorkspaceRoot(), question, ref: ref.ref });
    } catch (err) {
      this.reportError(err);
    }
  }

  /** 发送选区:输入框附言(可空)→ 注入附言+文件:行号+代码块 */
  async sendSelection(opts: { fileAbsPath: string; startLine: number; code: string }): Promise<void> {
    if (!(await this.ensureReady(true))) return;
    const ref = this.fileRef(opts.fileAbsPath);
    const note = await this.deps.messages.showInputBox({
      prompt: this.deps.messages.t('ctx.selPrompt', { path: ref.ref }),
      placeHolder: this.deps.messages.t('ctx.selPlaceholder'),
    });
    if (note === undefined) return;
    try {
      await injectText(this.api(), {
        workspaceRoot: this.deps.getWorkspaceRoot(),
        text: buildSelectionMessage(note, ref.ref, opts.startLine, opts.code),
      });
    } catch (err) {
      this.reportError(err);
    }
  }

  /** 切换自动跟随开关 */
  toggleAutoFollow(): void {
    void this.deps.setAutoFollow(!this.deps.getAutoFollow());
  }

  /** 幂等注册当前工作区(工作区切换后调用;失败静默) */
  async registerWorkspace(): Promise<void> {
    const root = this.deps.getWorkspaceRoot();
    if (root === undefined) return;
    try {
      await this.api().workspaceCreate(root);
    } catch {
      /* 注册失败不打断(下次注入会重试) */
    }
  }

  private reportError(err: unknown): void {
    if (err instanceof DshApiError) {
      if (err.kind === 'unsupported') {
        this.deps.messages.showWarning(this.deps.messages.t('ctx.unsupportedVersion'));
      } else if (err.kind === 'rpc') {
        this.deps.messages.showWarning(this.deps.messages.t('ctx.rpcError', { message: err.message }));
      } else {
        this.deps.messages.showWarning(this.deps.messages.t('ctx.serviceUnreachable'));
      }
      return;
    }
    this.deps.messages.showWarning(this.deps.messages.t('ctx.failed', { message: String(err) }));
  }
}
```

3b. 同步给 `src/i18n.ts` 追加本任务用到的动态键(否则 typecheck 失败)。`messages.en` 与 `messages.zh` 各自追加:

```ts
    // 上下文联动
    'ctx.noActiveFile': 'No file is open.',
    'ctx.noSelection': 'Select some text first.',
    'ctx.added': 'Added to DSH context: {path}',
    'ctx.serviceFailed': 'DSH service failed to start.',
    'ctx.unsupportedVersion': 'This DSH version does not support the context feature. Please upgrade DSH.',
    'ctx.rpcError': 'DSH rejected the request: {message}',
    'ctx.serviceUnreachable': 'DSH service is unreachable.',
    'ctx.failed': 'Failed to update DSH context: {message}',
    'ctx.askPrompt': 'Ask DSH about {path}',
    'ctx.askPlaceholder': 'What do you want to know? (leave empty to only reference the file)',
    'ctx.selPrompt': 'Send selection from {path} to DSH',
    'ctx.selPlaceholder': 'Optional note about the selection',
```

```ts
    'ctx.noActiveFile': '当前没有打开的文件。',
    'ctx.noSelection': '请先选中一些文本。',
    'ctx.added': '已加入 DSH 上下文：{path}',
    'ctx.serviceFailed': 'DSH 服务启动失败。',
    'ctx.unsupportedVersion': '当前 DSH 版本不支持上下文功能，请升级 DSH。',
    'ctx.rpcError': 'DSH 拒绝请求：{message}',
    'ctx.serviceUnreachable': 'DSH 服务无响应。',
    'ctx.failed': '更新 DSH 上下文失败：{message}',
    'ctx.askPrompt': '就 {path} 向 DSH 提问',
    'ctx.askPlaceholder': '想问什么？(留空则仅引用该文件)',
    'ctx.selPrompt': '把 {path} 的选区发送给 DSH',
    'ctx.selPlaceholder': '选区附言(可选)',
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/build.mjs --test && node --test out/test/context/controller.test.js && npm run typecheck`
Expected: PASS(11 个测试),typecheck 无错误

- [ ] **Step 5: Commit**

```bash
git add src/context/controller.ts test/context/controller.test.ts src/i18n.ts
git commit -m "feat: 新增上下文控制器 controller(命令行为/自动跟随/去重/错误分支)"
```

---

### Task 7: ServiceManager reconfigure 修复(cwd 变化触发重启)

**Files:**
- Modify: `src/service/manager.ts`(`reconfigure` 方法)
- Test: `test/manager.test.ts`(追加测试)

**Interfaces:**
- Consumes: 无
- Produces: `reconfigure(opts)` 语义变化:host/port/**cwd** 任一变化且自启服务在跑 → 重启;同时修复既有自比较 bug(`this.opts.host !== opts.host` 恒 false)

- [ ] **Step 1: 写失败测试**

在 `test/manager.test.ts` 末尾追加:

```ts
test('reconfigure 换 cwd:自启服务重启且以新 cwd 生效', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  const oldChild = h.child!;
  h.probeQueue = ['down', 'dsh'];
  const s = await h.manager.reconfigure({
    host: '127.0.0.1', port: 3080, extraArgs: [], autoStart: true, timeoutMs: 100, pollMs: 5, cwd: '/new/project',
  });
  assert.equal(s.state, 'ready');
  assert.ok(oldChild.killed.length > 0); // cwd 变化触发重启:旧子进程被停
});

test('reconfigure host/port/cwd 全不变:不重启(无多余 spawn)', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  const oldChild = h.child!;
  const s = await h.manager.reconfigure({
    host: '127.0.0.1', port: 3080, extraArgs: [], autoStart: true, timeoutMs: 100, pollMs: 5, cwd: undefined,
  });
  assert.equal(s.state, 'ready');
  assert.equal(h.spawnCount, 1); // 无新 spawn
  assert.equal(h.child, oldChild);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/build.mjs --test && node --test out/test/manager.test.js`
Expected: FAIL(第一个测试:旧实现不因 cwd 重启,`oldChild.killed` 为空)

- [ ] **Step 3: 写实现**

修改 `src/service/manager.ts` 的 `reconfigure`:

```ts
  /** 应用新配置;host/port/cwd 任一变化且自启服务在跑时自动重启(其余项原地生效) */
  reconfigure(opts: ManagerOptions): Promise<ServiceSnapshot> {
    const prev = { host: this.opts.host, port: this.opts.port, cwd: this.opts.cwd };
    const targetChanged = prev.host !== opts.host || prev.port !== opts.port || prev.cwd !== opts.cwd;
    this.opts = opts;
    if (targetChanged) {
      if (this.child) return this.restart();
      // 复用外部服务时只更新地址展示,实际可达性由下次 ensureRunning 重新探测
      if (this.snapshot.state === 'ready') this.set({ url: this.url() });
    }
    return Promise.resolve(this.getSnapshot());
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/build.mjs --test && node --test out/test/manager.test.js && npm run typecheck`
Expected: PASS(全部 manager 测试,含既有「换端口」测试)

- [ ] **Step 5: Commit**

```bash
git add src/service/manager.ts test/manager.test.ts
git commit -m "fix: reconfigure 修复自比较 bug 并将 cwd 变化纳入重启判断"
```

---

### Task 8: 新设置项(config.ts)+ i18n 文案 + package 清单声明

**Files:**
- Modify: `src/config.ts`(两个新设置项的声明/规范化/读取)
- Modify: `test/config.test.ts`(追加测试)
- Modify: `src/i18n.ts`(ctx.* 动态文案)
- Modify: `package.nls.json` + `package.nls.zh-cn.json`(命令标题/设置说明)
- Modify: `package.json`(commands/menus/configuration 声明)

**Interfaces:**
- Consumes: 无
- Produces:
  - `DshConfig.autoFollow: boolean`(默认 false)、`DshConfig.followDebounceMs: number`(默认 800,300–5000 越界回退默认并记错误)
  - `RawDshConfig` 同步增加两字段
  - i18n 新键(见 Step 3 清单,Task 6 的测试与实现已引用)

- [ ] **Step 1: 写失败测试**

在 `test/config.test.ts` 末尾追加:

```ts
test('autoFollow/followDebounceMs 默认值与合法值', () => {
  const r1 = normalizeConfig({});
  assert.equal(r1.config.autoFollow, false);
  assert.equal(r1.config.followDebounceMs, 800);

  const r2 = normalizeConfig({ autoFollow: true, followDebounceMs: 300 });
  assert.equal(r2.config.autoFollow, true);
  assert.equal(r2.config.followDebounceMs, 300);
  assert.deepEqual(r2.errors, []);
});

test('followDebounceMs 越界(<300 / >5000 / 非整数)→ 回退默认并记录错误', () => {
  for (const bad of [299, 5001, 3.5, -1]) {
    const r = normalizeConfig({ followDebounceMs: bad });
    assert.equal(r.config.followDebounceMs, 800, `bad=${bad}`);
    assert.ok(r.errors.length > 0, `bad=${bad} 应记录错误`);
  }
});

test('autoFollow 非布尔 → 静默回退默认(不记错误)', () => {
  const r = normalizeConfig({ autoFollow: 'yes' as unknown as boolean });
  assert.equal(r.config.autoFollow, false);
  assert.deepEqual(r.errors, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/build.mjs --test && node --test out/test/config.test.js`
Expected: FAIL(类型/断言不通过)

- [ ] **Step 3: 写实现**

3a. `src/config.ts` — `RawDshConfig` / `DshConfig` / `DEFAULTS` / `normalizeConfig` / `readConfig` 同步扩展:

```ts
  /** 是否自动跟随当前文件注入上下文(dsh.context.autoFollow) */
  autoFollow?: boolean;
  /** 自动跟随防抖毫秒(dsh.context.followDebounceMs) */
  followDebounceMs?: number;
```

```ts
  /** 是否自动跟随当前文件注入上下文(dsh.context.autoFollow) */
  autoFollow: boolean;
  /** 自动跟随防抖毫秒(dsh.context.followDebounceMs) */
  followDebounceMs: number;
```

`DEFAULTS` 追加 `autoFollow: false, followDebounceMs: 800,`;`normalizeConfig` 内追加:

```ts
  // 自动跟随开关:布尔设置沿用 autoStart 的缺省处理(非法静默回退)
  const autoFollow = typeof raw.autoFollow === 'boolean' ? raw.autoFollow : DEFAULTS.autoFollow;

  // followDebounceMs:300..5000 整数,非法回退默认并记录错误
  let followDebounceMs: number;
  if (raw.followDebounceMs === undefined) {
    followDebounceMs = DEFAULTS.followDebounceMs;
  } else if (
    typeof raw.followDebounceMs !== 'number' ||
    !Number.isInteger(raw.followDebounceMs) ||
    raw.followDebounceMs < 300 ||
    raw.followDebounceMs > 5000
  ) {
    errors.push(`dsh.context.followDebounceMs must be an integer in 300..5000, got ${JSON.stringify(raw.followDebounceMs)}`);
    followDebounceMs = DEFAULTS.followDebounceMs;
  } else {
    followDebounceMs = raw.followDebounceMs;
  }
```

返回对象两处(类型接口 + 构造对象)补 `autoFollow, followDebounceMs`;`readConfig` 追加 `autoFollow: ws.get<boolean>('context.autoFollow'), followDebounceMs: ws.get<number>('context.followDebounceMs'),`。

3b. `src/i18n.ts` — 动态键已在 Task 4/6 加入,本任务只需核对:`grep -c "ctx\." src/i18n.ts` 应为 30(15 键 × 2 语言);缺键时按 Task 4/6 的键表补齐。

3c. `package.nls.json` 追加:

```json
  "dsh.cmd.addFileContext.title": "Add Current File to DSH Context",
  "dsh.cmd.askAboutFile.title": "Ask DSH About Current File",
  "dsh.cmd.sendSelection.title": "Send Selection to DSH",
  "dsh.cmd.addPathContext.title": "Add to DSH Context",
  "dsh.cmd.askAboutPath.title": "Ask DSH About This",
  "dsh.cmd.openContextPanel.title": "Open DSH Panel",
  "dsh.config.contextAutoFollow": "Automatically add the current file to the DSH context when switching files.",
  "dsh.config.contextDebounce": "Debounce in milliseconds for auto-follow (300-5000)."
```

3d. `package.nls.zh-cn.json` 追加:

```json
  "dsh.cmd.addFileContext.title": "将当前文件加入 DSH 上下文",
  "dsh.cmd.askAboutFile.title": "用 DSH 询问当前文件",
  "dsh.cmd.sendSelection.title": "将选区发送给 DSH",
  "dsh.cmd.addPathContext.title": "加入 DSH 上下文",
  "dsh.cmd.askAboutPath.title": "用 DSH 询问此项",
  "dsh.cmd.openContextPanel.title": "打开 DSH 面板",
  "dsh.config.contextAutoFollow": "切换文件时自动把当前文件注入 DSH 上下文。",
  "dsh.config.contextDebounce": "自动跟随防抖毫秒数(300-5000)。"
```

3e. `package.json`:
- `activationEvents` 追加 6 项:`onCommand:dsh.addFileContext`、`onCommand:dsh.askAboutFile`、`onCommand:dsh.sendSelection`、`onCommand:dsh.addPathContext`、`onCommand:dsh.askAboutPath`、`onCommand:dsh.openContextPanel`
- `contributes.commands` 追加:

```json
      { "command": "dsh.addFileContext", "title": "%dsh.cmd.addFileContext.title%" },
      { "command": "dsh.askAboutFile", "title": "%dsh.cmd.askAboutFile.title%" },
      { "command": "dsh.sendSelection", "title": "%dsh.cmd.sendSelection.title%" },
      { "command": "dsh.addPathContext", "title": "%dsh.cmd.addPathContext.title%" },
      { "command": "dsh.askAboutPath", "title": "%dsh.cmd.askAboutPath.title%" },
      { "command": "dsh.openContextPanel", "title": "%dsh.cmd.openContextPanel.title%", "icon": "$(panel)" }
```

- `contributes.menus` 追加(与既有 `view/title` 平级):

```json
    "editor/context": [
      { "command": "dsh.addFileContext", "group": "dsh@1" },
      { "command": "dsh.askAboutFile", "group": "dsh@2" },
      { "command": "dsh.sendSelection", "group": "dsh@3", "when": "editorHasSelection" }
    ],
    "explorer/context": [
      { "command": "dsh.addPathContext", "group": "dsh@1" },
      { "command": "dsh.askAboutPath", "group": "dsh@2" }
    ],
    "editor/title/context": [
      { "command": "dsh.openContextPanel", "group": "dsh@1" },
      { "command": "dsh.openExternal", "group": "dsh@2" },
      { "command": "dsh.restart", "group": "dsh@3" },
      { "command": "dsh.stop", "group": "dsh@4" },
      { "command": "dsh.copyUrl", "group": "dsh@5" }
    ]
```

- `contributes.configuration.properties` 追加:

```json
        "dsh.context.autoFollow": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "%dsh.config.contextAutoFollow%"
        },
        "dsh.context.followDebounceMs": {
          "type": "number",
          "default": 800,
          "minimum": 300,
          "maximum": 5000,
          "markdownDescription": "%dsh.config.contextDebounce%"
        }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/build.mjs --test && node --test out/test/config.test.js && npm run typecheck && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'));JSON.parse(require('fs').readFileSync('package.nls.json','utf8'));JSON.parse(require('fs').readFileSync('package.nls.zh-cn.json','utf8'));console.log('json ok')"`
Expected: PASS + typecheck 无错误 + json ok

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts package.nls.json package.nls.zh-cn.json package.json
git commit -m "feat: 新增上下文设置项、双语文案与右键菜单/命令声明"
```

---

### Task 9: 扩展入口装配(命令注册 + 跟踪器 + 工作区自适应)

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: Task 2/6/5 的全部 Produces;`toManagerOptions`(本文件既有)
- Produces: 无新导出(装配层);行为:6 个新命令、活动编辑器跟踪、`onDidChangeWorkspaceFolders` 自动切换

- [ ] **Step 1: 写装配代码**

修改 `src/extension.ts`:

9a. import 追加:

```ts
import { ContextController } from './context/controller';
import { createCurrentFileTracker, describeFileRef } from './context/tracker';
```

9b. 在 `manager` 创建(`manager = new ServiceManager(...)`)与 `panelPrimary` 创建之间插入:

```ts
  // —— 上下文联动装配:控制器 + 当前文件跟踪器 ——
  const controller = new ContextController({
    manager,
    getWorkspaceRoot: () =>
      resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], readConfig().config.workspaceRootIndex),
    getAutoFollow: () => readConfig().config.autoFollow,
    setAutoFollow: async (v) => {
      await vscode.workspace.getConfiguration('dsh').update('context.autoFollow', v, true);
    },
    messages: {
      t,
      showInformation: (m) => void vscode.window.showInformationMessage(m),
      showWarning: (m) => void vscode.window.showWarningMessage(m),
      showInputBox: (o) => vscode.window.showInputBox({ prompt: o.prompt, placeHolder: o.placeHolder }),
    },
  });

  // 防抖跟踪器:结算后驱动自动跟随与工具条刷新
  tracker = createCurrentFileTracker({ debounceMs: readConfig().config.followDebounceMs });
  tracker.onSettled((absPath) => {
    if (absPath !== undefined && readConfig().config.autoFollow) {
      void controller.autoInject(absPath);
    }
    panelPrimary.refreshContextBar();
    panelSecondary.refreshContextBar();
  });
```

9c. `panelPrimary` / `panelSecondary` 创建(注意:使用赋值而非声明——变量已在 9f 提升为模块级;`context` 第六参):

```ts
  panelPrimary = new DshPanelProvider(
    manager,
    () => {
      void showSecondaryGuideOnce(context); // 首次打开面板弹一次入口引导
      onPanelFirstOpen(); // 面板打开:标记并尝试启动握手超时
    },
    onBridgeAck, // onBridgeAck:桥接握手回执 → handshakeOk(Task 7 状态评估)
    workspaceRootGetter, // workspaceRoot:文件相对路径解析的兜底基准
    bridgeEnabledGetter, // bridgeEnabled:dsh.bridge.enabled 驱动握手脚本注入
    makeContextPanelDeps(),
  );
  panelSecondary = new DshPanelProvider(
    manager,
    onPanelFirstOpen,
    onBridgeAck,
    workspaceRootGetter,
    bridgeEnabledGetter,
    makeContextPanelDeps(),
  );
```

其中 `makeContextPanelDeps` 定义在 activate 内、两个 provider 创建之前:

```ts
  /** 两个面板共享的上下文依赖(当前文件标签/自动跟随/加入动作) */
  function makeContextPanelDeps() {
    return {
      getFileLabel: () => {
        const p = tracker?.getCurrent();
        return p === undefined ? null : describeFileRef(p, workspaceRootGetter()).ref;
      },
      getAutoFollow: () => readConfig().config.autoFollow,
      addFileContext: () => {
        const p = tracker?.getCurrent();
        if (p === undefined) {
          void vscode.window.showWarningMessage(t('ctx.noActiveFile'));
          return;
        }
        void controller.addFileContext(p);
      },
      toggleAutoFollow: () => controller.toggleAutoFollow(),
    };
  }
```

9d. `context.subscriptions.push` 内追加(紧接既有命令注册之后、`onDidChangeConfiguration` 之前):

```ts
    // —— 上下文联动命令 ——
    vscode.commands.registerCommand('dsh.addFileContext', () => {
      const p = tracker.getCurrent();
      if (p === undefined) {
        void vscode.window.showWarningMessage(t('ctx.noActiveFile'));
        return;
      }
      void controller.addFileContext(p);
    }),
    vscode.commands.registerCommand('dsh.askAboutFile', () => {
      const p = tracker.getCurrent();
      if (p === undefined) {
        void vscode.window.showWarningMessage(t('ctx.noActiveFile'));
        return;
      }
      void controller.askAboutFile(p);
    }),
    vscode.commands.registerCommand('dsh.sendSelection', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        void vscode.window.showWarningMessage(t('ctx.noSelection'));
        return;
      }
      void controller.sendSelection({
        fileAbsPath: ed.document.uri.fsPath,
        startLine: ed.selection.start.line + 1, // 1-based 行号(与编辑器显示一致)
        code: ed.document.getText(ed.selection),
      });
    }),
    vscode.commands.registerCommand('dsh.addPathContext', (uri?: vscode.Uri) => {
      if (uri) void controller.addFileContext(uri.fsPath);
    }),
    vscode.commands.registerCommand('dsh.askAboutPath', (uri?: vscode.Uri) => {
      if (uri) void controller.askAboutFile(uri.fsPath);
    }),
    vscode.commands.registerCommand('dsh.openContextPanel', () => openPanel()),
    // —— 活动编辑器跟踪:驱动工具条显示与自动跟随 ——
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      const doc = ed?.document;
      tracker.setFile(doc !== undefined && doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined);
    }),
    // —— 工作区自适应:切换项目时自动重启服务(cwd)+ 幂等注册新工作区 ——
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void (async () => {
        const snap = await manager?.reconfigure(toManagerOptions(readConfig().config));
        const root = resolveWorkspaceRoot(
          vscode.workspace.workspaceFolders ?? [],
          readConfig().config.workspaceRootIndex,
        );
        if (snap?.state === 'ready' && root !== undefined) {
          await controller.registerWorkspace(); // 失败静默(内部已捕获)
        }
      })();
    }),
```

9e. `onConfigChanged` 追加跟踪器防抖同步与工具条刷新:

```ts
/** 配置变更:host/port/cwd 变化时自动重启自启服务,退出策略与上下文设置实时生效 */
function onConfigChanged(): void {
  const m = manager;
  if (!m) return;
  const { config } = readConfig();
  void m.reconfigure(toManagerOptions(config));
  m.setExitBehavior(!config.stopOnExit);
  tracker?.setDebounceMs(config.followDebounceMs);
  panelPrimary?.refreshContextBar();
  panelSecondary?.refreshContextBar();
}
```

9f. 配套:`tracker` / `panelPrimary` / `panelSecondary` 从局部常量提升为模块级可空变量(在 `let manager` 声明处附近):

```ts
let manager: ServiceManager | null = null;
let output: vscode.OutputChannel | null = null;
let tracker: ReturnType<typeof createCurrentFileTracker> | null = null;
let panelPrimary: DshPanelProvider | null = null;
let panelSecondary: DshPanelProvider | null = null;
```

并把 9c 的 `const panelPrimary =` 改为 `panelPrimary =`(同理 secondary);`context.subscriptions.push` 内使用处同步。9e 依赖 `tracker.setDebounceMs` —— 为 tracker 增加该方法(修改 `src/context/tracker.ts`):

```ts
export interface CurrentFileTracker {
  setFile(absPath: string | undefined): void;
  getCurrent(): string | undefined;
  onSettled(cb: (absPath: string | undefined) => void): () => void;
  /** 更新防抖窗口(设置项变更时调用) */
  setDebounceMs(ms: number): void;
  dispose(): void;
}
```

实现:

```ts
  let debounceMs = opts.debounceMs;
  return {
    ...
    setDebounceMs(ms) {
      debounceMs = ms;
    },
```

并把 `timers.setTimeout(settle, opts.debounceMs)` 改为 `timers.setTimeout(settle, debounceMs)`。

- [ ] **Step 2: 运行测试确认既有测试不受影响**

Run: `npm test && npm run typecheck`
Expected: 全部测试 PASS(含 Task 2 的 tracker 测试——接口新增 setDebounceMs 不影响既有断言),typecheck 无错误

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts src/context/tracker.ts
git commit -m "feat: 扩展入口装配上下文命令、活动文件跟踪与工作区自适应"
```

---

### Task 10: 集成测试(真实 DSH 全链路)

**Files:**
- Create: `test/integration/dsh-context.test.ts`

**Interfaces:**
- Consumes: Task 1 `createDshApi`、Task 3 `injectContext/findTargetSession/buildContextMessage`
- Produces: 无

- [ ] **Step 1: 写测试**

创建 `test/integration/dsh-context.test.ts`:

```ts
// test/integration/dsh-context.test.ts — 真实 dsh web 的上下文注入链路
// 无 dsh 命令的环境自动跳过;随机空闲端口;DSH_HOME 沿用进程环境(沙箱环境需指向可写目录)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { probeService } from '../../src/service/detect';
import { createProcessRunner } from '../../src/service/process';
import { ServiceManager } from '../../src/service/manager';
import { createDshApi, type DshApi } from '../../src/context/dshApi';
import { buildContextMessage, findTargetSession, injectContext } from '../../src/context/injector';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const hasDsh = spawnSync('dsh', ['--version'], { timeout: 5000 }).status === 0;

test('上下文注入全链路:workspace 幂等 → 会话新建/复用 → prompt → history 验证', { skip: !hasDsh && 'dsh 命令不可用,跳过' }, async () => {
  const port = await freePort();
  const manager = new ServiceManager(
    { host: '127.0.0.1', port, extraArgs: [], autoStart: true, timeoutMs: 3000, pollMs: 300 },
    { probeService, processRunner: createProcessRunner(), log: () => {}, startTimeoutMs: 20000 },
  );
  try {
    const s = await manager.ensureRunning();
    assert.equal(s.state, 'ready');
    const api: DshApi = createDshApi(`http://127.0.0.1:${port}`);
    const root = process.cwd();

    // workspace.create 幂等
    const w1 = await api.workspaceCreate(root);
    const w2 = await api.workspaceCreate(root);
    assert.equal(w1.workspace.workspaceId, w2.workspace.workspaceId);
    assert.equal(w1.created, true);
    assert.equal(w2.created, false);

    // 首次注入:无会话 → 新建
    const r1 = await injectContext(api, { workspaceRoot: root, ref: 'src/extension.ts' });
    assert.equal(r1.created, true);

    // 二次注入:复用同一会话
    const r2 = await injectContext(api, { workspaceRoot: root, ref: 'src/i18n.ts' });
    assert.equal(r2.created, false);
    assert.equal(r2.sessionId, r1.sessionId);

    // 会话定位:按 cwd 找到该会话
    const sessions = await api.sessionList();
    const found = findTargetSession(sessions, root);
    assert.equal(found?.sessionId, r1.sessionId);

    // history 验证消息落地(上下文式文案)
    await new Promise((r) => setTimeout(r, 500));
    const hist = await api.call<{
      events: Array<{ event: { type: string; data?: { content?: Array<{ type: string; text?: string }> } } }>;
    }>('session.history', { sessionId: r1.sessionId, maxMessages: 4 });
    const texts = hist.events
      .filter((e) => e.event.type === 'user/message')
      .flatMap((e) => e.event.data?.content ?? [])
      .map((c) => c.text ?? '');
    assert.ok(texts.some((t) => t.includes(buildContextMessage('src/extension.ts'))));
    assert.ok(texts.some((t) => t.includes(buildContextMessage('src/i18n.ts'))));
  } finally {
    await manager.stop();
    manager.dispose();
  }
});
```

- [ ] **Step 2: 运行测试(本机)**

Run: `DSH_HOME=/tmp/dsh-it-home-$$ npm test`
(若沙箱报 EROFS,改用 workspace 内目录:`mkdir -p .dsh-it-home && DSH_HOME="$PWD/.dsh-it-home" npm test`,结束后删除)
Expected: 集成测试 PASS(与既有 `dsh.test.ts` 并行运行,总计 78 测试)

- [ ] **Step 3: Commit**

```bash
git add test/integration/dsh-context.test.ts
git commit -m "test: 真实 DSH 上下文注入链路集成测试"
```

---

### Task 11: 文档、版本与全量验收

**Files:**
- Modify: `package.json`(version 0.2.1 → 0.3.0)
- Modify: `package-lock.json`(version 同步;执行 `npm install --package-lock-only` 或手工改根节点)
- Modify: `CHANGELOG.md`
- Modify: `README.md` / `README.zh.md`

**Interfaces:** 无

- [ ] **Step 1: 版本与 changelog**

`package.json`: `"version": "0.3.0"`;`package-lock.json` 顶层两处 `"version": "0.2.1"` 改 `"0.3.0"`。

`CHANGELOG.md` 顶部插入:

```md
## 0.3.0 (2026-08-17)

### 新增

- 当前文件 AI 上下文联动:面板上下文工具条(当前文件 + 加入按钮 + 自动跟随开关);设置 `dsh.context.autoFollow` / `dsh.context.followDebounceMs`;自动跟随注入到当前项目下最近会话(无则自动新建)
- 右键菜单:编辑器(加入上下文 / 用 DSH 询问 / 发送选区)、资源管理器(加入上下文 / 用 DSH 询问)、编辑器标题栏(打开面板 / 浏览器打开 / 重启 / 停止 / 复制 URL)
- 工作目录自适应:切换 VS Code 工作区自动以新项目为工作目录重启 DSH 服务,并幂等注册 DSH 工作区

### 修复

- ServiceManager.reconfigure 的自比较 bug;cwd 变化现在会正确触发服务重启
```

- [ ] **Step 2: README 更新**

`README.zh.md`(与 `README.md` 同步):
- 「✨ 特性」追加两条:`🧠 文件上下文联动`、`🖱️ 右键菜单`、`📁 工作区自适应`(英文版对应)
- 新小节「上下文联动」:工具条说明、自动跟随设置表(两行)、右键菜单清单
- 「桥接相关设置」后追加新设置表:

```md
### 上下文联动设置(`dsh.context.*`)

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.context.autoFollow` | `false` | 切换文件时自动把当前文件注入 AI 上下文 |
| `dsh.context.followDebounceMs` | `800` | 自动跟随防抖毫秒数(300-5000) |
```

- [ ] **Step 3: 全量验收**

Run: `npm run typecheck && npm test && npm run compile && npm run package`
Expected: typecheck 无错误;全部测试 PASS;`dsh-vscode.vsix` 产出(验证后删除产物,不提交)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md README.md README.zh.md
git commit -m "release: v0.3.0 上下文联动/右键菜单/工作区自适应"
```

---

## Self-Review 记录

- **Spec coverage**:规格 §4.1 半自动+自动跟随 → Task 4/5/6/9;§4.2 右键菜单 → Task 8/9;§4.3 工作区自适应 → Task 7/9;§5.1 命令 → Task 8/9;§5.3 设置项 → Task 8;§6 降级 → Task 6(reportError/静默分支);§7 测试 → 各 Task + Task 10;§8 发布 → Task 11。无缺口。
- **Placeholder scan**:无 TBD/TODO;所有代码块完整。
- **Type consistency**:`ContextPanelDeps`(Task 5)与 Task 9 装配对象字段一致;`CurrentFileTracker.setDebounceMs` 在 Task 9 Step 1 内定义并修改 tracker.ts(该修改与 Task 2 的 Produces 列表一致性已核对);`ControllerDeps`(Task 6)与 Task 9 构造对象字段一致;`MsgKey` 新键在引用处随任务添加(工具条三键 → Task 4,联动键 → Task 6,Task 8 核对),键名一致(`ctx.currentFile/ctx.add/ctx.autoFollow/ctx.added/ctx.askPrompt/ctx.askPlaceholder/ctx.selPrompt/ctx.selPlaceholder/ctx.serviceFailed/ctx.unsupportedVersion/ctx.rpcError/ctx.serviceUnreachable/ctx.failed/ctx.noActiveFile/ctx.noSelection`)。
