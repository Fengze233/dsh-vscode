// test/bridge/host.test.ts — 桥接消息处理与路径解析单测
// 覆盖：resolveBridgePath 的绝对/相对/危险协议分支；handleBridgeMessage 的外链白名单
// 转发、危险协议拒绝、文件跳转路径解析。生产侧接 vscode API，这里注入假实现验证纯逻辑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBridgePath, handleBridgeMessage } from '../../src/bridge/host';

test('resolveBridgePath 处理绝对/相对/危险协议', () => {
  // 绝对路径直接采用（忽略 cwd 与工作区根）
  assert.deepEqual(resolveBridgePath('/a/b.ts', undefined, '/proj'), { kind: 'abs', path: '/a/b.ts' });
  // 相对路径优先按会话 cwd 解析（工作区根不同也不影响）
  assert.deepEqual(resolveBridgePath('src/main.ts', '/proj', '/other'), { kind: 'abs', path: '/proj/src/main.ts' });
  // 会话 cwd 缺失时回退工作区根
  assert.deepEqual(resolveBridgePath('src/main.ts', undefined, '/proj'), { kind: 'abs', path: '/proj/src/main.ts' });
  // 无任何基准的相对路径：无法解析
  assert.deepEqual(resolveBridgePath('..\\evil.ts', undefined, undefined), { kind: 'invalid' });
  // 协议串（URL）：一律拒绝
  assert.deepEqual(resolveBridgePath('https://x.com/a', undefined, '/proj'), { kind: 'invalid' });
});

test('handleBridgeMessage 转发 openExternal 到外部浏览器', async () => {
  // 记录被转发的 URL，验证 http/https 外链原样透传
  const calls: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'https://a.b' }, {
    openExternal: async (u) => { calls.push(u); return true; },
    openTextDocument: async () => {},
  });
  assert.deepEqual(calls, ['https://a.b']);
});

test('handleBridgeMessage 拒绝危险协议的 openExternal', async () => {
  // javascript: 协议不允许走 openExternal（纵深防御，即使桥接侧已过滤）
  let called = false;
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'javascript:alert(1)' }, {
    openExternal: async () => { called = true; return true; },
    openTextDocument: async () => {},
  });
  assert.equal(called, false);
});

test('handleBridgeMessage openFile 调用打开文档', async () => {
  // 相对路径 + cwd → 解析为绝对路径后交给 openTextDocument
  const opened: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'src/main.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { opened.push(p); },
    workspaceRoot: '/proj',
  });
  assert.deepEqual(opened, ['/proj/src/main.ts']);
});
