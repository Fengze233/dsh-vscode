// test/bridge/host.test.ts — 桥接消息处理与路径解析单测
// 覆盖：resolveBridgePath 的绝对/相对/危险协议分支；handleBridgeMessage 的外链白名单
// 转发、危险协议拒绝、文件跳转路径解析、打开失败与路径无法解析的用户提示。
// 生产侧接 vscode API，这里注入假实现验证纯逻辑（showWarning 一并注入以断言提示文案）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBridgePath, handleBridgeMessage, saveImageToCwd, deleteImageFiles, createImageRegistry } from '../../src/bridge/host';

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
    showWarning: () => {},
  });
  assert.deepEqual(calls, ['https://a.b']);
});

test('handleBridgeMessage 拒绝危险协议的 openExternal', async () => {
  // javascript: 协议不允许走 openExternal（纵深防御，即使桥接侧已过滤）
  let called = false;
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'javascript:alert(1)' }, {
    openExternal: async () => { called = true; return true; },
    openTextDocument: async () => {},
    showWarning: () => {},
  });
  assert.equal(called, false);
});

test('handleBridgeMessage openExternal 抛错时提示用户', async () => {
  // 假 openExternal 抛错 → 应调用 showWarning（文案含 URL 与错误摘要），且不抛未处理异常
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'https://a.b/c' }, {
    openExternal: async () => { throw new Error('no default browser'); },
    openTextDocument: async () => {},
    showWarning: (m) => { warnings.push(m); },
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('https://a.b/c'), `提示应含链接，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('no default browser'), `提示应含错误摘要，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 调用打开文档', async () => {
  // 相对路径 + cwd → 解析为绝对路径后交给 openTextDocument
  const opened: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'src/main.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { opened.push(p); },
    showWarning: () => {},
    workspaceRoot: '/proj',
  });
  assert.deepEqual(opened, ['/proj/src/main.ts']);
});

test('handleBridgeMessage openFile 打开失败时提示用户', async () => {
  // 假 openTextDocument 抛错 → 应调用 showWarning，文案含解析后的路径与错误摘要，且不抛未处理异常
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'missing.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async () => { throw new Error('ENOENT: no such file'); },
    showWarning: (m) => { warnings.push(m); },
    workspaceRoot: '/proj',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('/proj/missing.ts'), `提示应含路径，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('ENOENT'), `提示应含错误摘要，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 路径无法解析时提示用户', async () => {
  // 危险协议（无基准可解析）→ invalid 分支应调用 showWarning（替代原 vscode 硬编码告警）
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'https://x.com/a' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: (m) => { warnings.push(m); },
    workspaceRoot: '/proj',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('https://x.com/a'), `提示应含原始路径，实际：${warnings[0]}`);
});
// —— v0.3.0 图片缓存落盘/删除（路径安全） ——
test('saveImageToCwd：合法写入并登记，返回绝对路径', async () => {
  const written: string[] = [];
  const reg = createImageRegistry();
  const ok = await saveImageToCwd(
    { writeFile: async (p: string, _b: string) => { written.push(p); }, rmFile: async () => {} },
    { cwd: '/ws', name: 'dsh-imgcache-a-0.png', dataB64: 'AAAA' },
    reg,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.path, '/ws/dsh-imgcache-a-0.png');
  assert.equal(written.length, 1);
  assert.ok(reg.has('/ws/dsh-imgcache-a-0.png'), '落盘后登记进注册表');
});

test('saveImageToCwd：无 cwd/相对 cwd/穿越文件名/非法扩展名/空数据一律拒绝且不写入', async () => {
  const written: string[] = [];
  const deps = { writeFile: async (p: string) => { written.push(p); }, rmFile: async () => {} };
  assert.equal((await saveImageToCwd(deps, { cwd: undefined, name: 'dsh-imgcache-a-0.png', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: 'rel/ws', name: 'dsh-imgcache-a-0.png', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: '/ws', name: '../dsh-imgcache-a-0.png', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: '/ws', name: 'dsh-imgcache-a-0.exe', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: '/ws', name: 'dsh-imgcache-a-0.png', dataB64: '' })).ok, false);
  assert.equal(written.length, 0, '任何拒绝都不落盘');
});

test('deleteImageFiles：只删除注册表中的缓存文件，任意路径被忽略', async () => {
  const reg = createImageRegistry();
  reg.add('/ws/dsh-imgcache-a-0.png');
  const deleted: string[] = [];
  const deps = { writeFile: async () => {}, rmFile: async (p: string) => { deleted.push(p); } };
  await deleteImageFiles(deps, { paths: ['/ws/dsh-imgcache-a-0.png', '/ws/user.txt', '/etc/passwd'] }, reg);
  assert.deepEqual(deleted, ['/ws/dsh-imgcache-a-0.png'], '只删注册过的缓存文件');
  assert.ok(!reg.has('/ws/dsh-imgcache-a-0.png'), '删除后移出注册表');
});

test('handleBridgeMessage 处理 bridgeSaveImage：回执 saveImageAck（ok+path）', async () => {
  const acks: unknown[] = [];
  await handleBridgeMessage({ type: 'bridgeSaveImage', requestId: 's1', name: 'dsh-imgcache-a-0.png', dataB64: 'AAAA', sessionCwd: '/ws' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: () => {},
    writeFile: async () => {},
    rmFile: async () => {},
    reply: async (m: unknown) => { acks.push(m); },
  });
  assert.equal(acks.length, 1);
  const a = acks[0] as { type: string; ok: boolean; path: string };
  assert.equal(a.type, 'bridgeSaveImageAck');
  assert.equal(a.ok, true);
  assert.equal(a.path, '/ws/dsh-imgcache-a-0.png');
});

test('handleBridgeMessage 处理 bridgeDeleteImages：回执 deleteImagesAck', async () => {
  const acks: unknown[] = [];
  await handleBridgeMessage({ type: 'bridgeDeleteImages', requestId: 'd1', paths: [] }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: () => {},
    writeFile: async () => {},
    rmFile: async () => {},
    reply: async (m: unknown) => { acks.push(m); },
  });
  assert.equal(acks.length, 1);
  assert.equal((acks[0] as { type: string }).type, 'bridgeDeleteImagesAck');
  assert.equal((acks[0] as { ok: boolean }).ok, true);
});

