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
    // 修正说明:简报原文 `call: async () => ({})` 对泛型方法 call<T> 推断为 Promise<{}>,
    // 无法赋值给 Promise<T>(TS2322);改为显式泛型 + 断言,语义等价(假 API 的 call 不关心返回值)。
    call: async <T>() => ({}) as T,
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
  // 修正说明:实现按简报逐字传 { cwd: undefined }(JSON 序列化时该字段被剔除,
  // 协议语义等价于不带 cwd);Node 24 的 deepStrictEqual 区分 { cwd: undefined } 与 {},故改为断言 cwd 无有效值。
  assert.equal((createPayload as { cwd?: string }).cwd, undefined);
});

test('injectText:定位/新建 + 任意文本注入', async () => {
  const api = fakeApi([sess('a', '/p', 10)]);
  const r = await injectText(api, { workspaceRoot: '/p', text: '自定义文本' });
  assert.equal(r.sessionId, 'a');
  assert.equal(api.prompts[0].text, '自定义文本');
});
