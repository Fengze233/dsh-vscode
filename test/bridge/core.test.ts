// test/bridge/core.test.ts — 桥接纯逻辑单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedExternalUrl,
  buildOpenExternalMessage,
  buildOpenFileMessage,
  buildSyncWorkspaceAck,
  buildCopyTextMessage,
  buildCopyTextAck,
  isBridgeMessage,
  HANDSHAKE_TOKEN_KEY,
  getShortcutCommand,
  isEditableElement,
  computeInsertedValue,
  buildReadTextMessage,
  buildReadTextAck,
  FILE_ENTRY_SELECTOR,
  resolveFileEntryPath,
} from '../../bridge-client/lib/core.js';

/** 构造最小按钮替身（只实现 resolveFileEntryPath 需要的接口） */
function fakeBtn(attrs: { title?: string; 'aria-label'?: string; text?: string; haspopup?: boolean }) {
  return {
    getAttribute: (name: string) => {
      if (name === 'title') return attrs.title ?? null;
      if (name === 'aria-label') return attrs['aria-label'] ?? null;
      return null;
    },
    textContent: attrs.text ?? '',
    matches: (sel: string) => (sel === '[aria-haspopup]' ? attrs.haspopup === true : false),
  };
}

// ——— issue #22：文件入口解析（原先 classList.contains('fileMention') 恒不命中） ———
test('FILE_ENTRY_SELECTOR 覆盖三类文件入口', () => {
  // markdown 文件名（CSS Module 哈希类名，必须用 class*= 而非精确类名）
  assert.ok(FILE_ENTRY_SELECTOR.includes('button[class*="fileMention"]'));
  // produced 芯片 / present 卡片预览面：稳定 data 属性 + title
  assert.ok(FILE_ENTRY_SELECTOR.includes('[data-produced-files-row] button[title]'));
  assert.ok(FILE_ENTRY_SELECTOR.includes('[data-presented-file] button[title]'));
});

test('resolveFileEntryPath：title 优先（title 才是路径，aria-label 是动作文案）', () => {
  // produced 芯片：title 是相对路径，aria-label 是「打开 <路径>」的本地化文案
  assert.equal(
    resolveFileEntryPath(fakeBtn({ title: 'docs/progress.md', 'aria-label': '打开 docs/progress.md' })),
    'docs/progress.md',
  );
  // present 卡片：title 已是工作区绝对路径
  assert.equal(
    resolveFileEntryPath(fakeBtn({ title: '/home/u/proj/src/a.ts', 'aria-label': '在侧边栏预览 src/a.ts' })),
    '/home/u/proj/src/a.ts',
  );
  // Windows 盘符绝对路径原样透传（协议判定由扩展侧 resolveBridgePath 负责）
  assert.equal(resolveFileEntryPath(fakeBtn({ title: 'C:\\work\\a.ts' })), 'C:\\work\\a.ts');
});

test('resolveFileEntryPath：title 为空时从 aria-label 抽取引号包裹的路径', () => {
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': '打开 `docs/progress.md`' })), 'docs/progress.md');
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': '在侧边栏预览 "src/a.ts"' })), 'src/a.ts');
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': 'Open \u201cREADME.md\u201d' })), 'README.md');
});

test('resolveFileEntryPath：aria-label 无引号路径时判为不可用（不把整串文案当路径）', () => {
  // 旧实现会把「打开 docs/progress.md」整串下发，扩展侧解析不到文件
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': '打开 docs/progress.md' })), null);
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': 'queued a.ts, b.ts' })), null);
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': '在侧边栏打开' })), null);
});

test('resolveFileEntryPath：排除 aria-haspopup 的宿主菜单触发按钮', () => {
  assert.equal(resolveFileEntryPath(fakeBtn({ title: 'docs/a.md', haspopup: true })), null);
});

test('resolveFileEntryPath：无 title/aria-label 时退回纯文本文件名', () => {
  assert.equal(resolveFileEntryPath(fakeBtn({ text: 'src/main.ts' })), 'src/main.ts');
  assert.equal(resolveFileEntryPath(fakeBtn({ text: '   ' })), null);
  assert.equal(resolveFileEntryPath(fakeBtn({})), null);
});

test('resolveFileEntryPath：非法输入不抛错', () => {
  assert.equal(resolveFileEntryPath(null as unknown as never), null);
  assert.equal(resolveFileEntryPath(undefined as unknown as never), null);
  assert.equal(resolveFileEntryPath({} as unknown as never), null);
});

test('isAllowedExternalUrl 仅放行 http/https', () => {
  assert.equal(isAllowedExternalUrl('https://example.com/a'), true);
  assert.equal(isAllowedExternalUrl('http://127.0.0.1:3080/x'), true);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedExternalUrl(''), false);
});

test('buildOpenExternalMessage 构造消息', () => {
  assert.deepEqual(buildOpenExternalMessage('https://a.b/c'), { kind: 'openExternal', url: 'https://a.b/c' });
});

test('buildOpenFileMessage 携带可选 cwd', () => {
  assert.deepEqual(buildOpenFileMessage('src/main.ts', '/proj'), { kind: 'openFile', path: 'src/main.ts', cwd: '/proj' });
  assert.deepEqual(buildOpenFileMessage('/abs/a.ts', undefined), { kind: 'openFile', path: '/abs/a.ts' });
});

test('buildSyncWorkspaceAck 构造回执', () => {
  assert.deepEqual(buildSyncWorkspaceAck(true), { kind: 'bridgeAck', ok: true });
  assert.deepEqual(buildSyncWorkspaceAck(false, '/proj'), { kind: 'bridgeAck', ok: false, path: '/proj' });
});

test('buildCopyTextMessage / buildCopyTextAck 构造剪贴板桥接消息', () => {
  assert.deepEqual(buildCopyTextMessage('hello', 'req-1'), { kind: 'copyText', text: 'hello', requestId: 'req-1' });
  assert.deepEqual(buildCopyTextAck('req-1', true), { kind: 'copyTextAck', requestId: 'req-1', ok: true });
  assert.deepEqual(buildCopyTextAck('req-2', false), { kind: 'copyTextAck', requestId: 'req-2', ok: false });
});

test('isBridgeMessage 校验 token', () => {
  assert.equal(isBridgeMessage({ token: 't1' }, 't1'), true);
  assert.equal(isBridgeMessage({ token: 't2' }, 't1'), false);
  assert.equal(isBridgeMessage(null, 't1'), false);
});

test('常量取值正确', () => {
  assert.equal(HANDSHAKE_TOKEN_KEY, 'token');
});

// —— 标准编辑快捷键仿真（VS Code 吞掉 iframe 内 Cmd+C/V/A/X/Z 的修复） ——

test('getShortcutCommand 识别 mac/win 标准编辑快捷键', () => {
  // mac: metaKey
  assert.equal(getShortcutCommand({ key: 'c', metaKey: true }), 'copy');
  assert.equal(getShortcutCommand({ key: 'v', metaKey: true }), 'paste');
  assert.equal(getShortcutCommand({ key: 'x', metaKey: true }), 'cut');
  assert.equal(getShortcutCommand({ key: 'a', metaKey: true }), 'selectAll');
  assert.equal(getShortcutCommand({ key: 'z', metaKey: true }), 'undo');
  assert.equal(getShortcutCommand({ key: 'z', metaKey: true, shiftKey: true }), 'redo');
  // win/linux: ctrlKey
  assert.equal(getShortcutCommand({ key: 'C', ctrlKey: true }), 'copy');
  assert.equal(getShortcutCommand({ key: 'V', ctrlKey: true }), 'paste');
  // Shift+Insert（Windows 粘贴惯例）
  assert.equal(getShortcutCommand({ key: 'Insert', shiftKey: true }), 'paste');
  // 大小写不敏感
  assert.equal(getShortcutCommand({ key: 'C', metaKey: true }), 'copy');
  // 未命中：无修饰键、非编辑键、非法输入
  assert.equal(getShortcutCommand({ key: 'c' }), null);
  assert.equal(getShortcutCommand({ key: 'Enter', metaKey: true }), null);
  assert.equal(getShortcutCommand({ key: 'k', ctrlKey: true }), null);
  assert.equal(getShortcutCommand(null), null);
  assert.equal(getShortcutCommand(undefined), null);
  assert.equal(getShortcutCommand({}), null);
});

test('isEditableElement 只认可接收文本编辑的元素', () => {
  // textarea / text input / contenteditable 为可编辑
  assert.equal(isEditableElement({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: '' }), true); // type 缺省即 text
  assert.equal(isEditableElement({ tagName: 'DIV', isContentEditable: true }), true);
  // 非文本输入型 input 不可编辑
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'button' }), false);
  // 普通元素 / 空值 / 非对象
  assert.equal(isEditableElement({ tagName: 'DIV' }), false);
  assert.equal(isEditableElement(null), false);
  assert.equal(isEditableElement(undefined), false);
  assert.equal(isEditableElement('textarea'), false);
});

test('computeInsertedValue 在选区插入文本', () => {
  // 正常插入（前不着后不着）
  assert.equal(computeInsertedValue('hello world', 6, 11, 'VS Code'), 'hello VS Code');
  // 全选替换
  assert.equal(computeInsertedValue('hello', 0, 5, 'hi'), 'hi');
  // 空选区 = 光标处插入
  assert.equal(computeInsertedValue('ab', 1, 1, 'X'), 'aXb');
  // 选区顺序/越界归一
  assert.equal(computeInsertedValue('abc', 5, 2, 'X'), 'abcX');
  assert.equal(computeInsertedValue('abc', -1, 2, 'X'), 'Xc');
  // 非字符串值兜底
  assert.equal(computeInsertedValue(undefined, 0, 0, 'x'), 'x');
  assert.equal(computeInsertedValue(null, 0, 0, 'x'), 'x');
});

test('buildReadTextMessage / buildReadTextAck 构造剪贴板读取消息', () => {
  assert.deepEqual(buildReadTextMessage('req-1'), { kind: 'readText', requestId: 'req-1' });
  assert.deepEqual(buildReadTextAck('req-1', true, 'abc'), { kind: 'readTextAck', requestId: 'req-1', ok: true, text: 'abc' });
  // 读取失败：不带 text 字段
  assert.deepEqual(buildReadTextAck('req-2', false), { kind: 'readTextAck', requestId: 'req-2', ok: false });
  assert.deepEqual(buildReadTextAck('req-3', true, ''), { kind: 'readTextAck', requestId: 'req-3', ok: false });
});
