// test/chatMentions.test.ts — 「添加到对话」的 @ 引用格式回归
//
// 真机反馈（v0.5.1 图四）：右键文件夹 `test` 插入的是 `@test`，DSH 按文件引用解析，
// 打不开、也应用不上。DSH 的语法（dsh-file-reference/grammar + ui-reference/user-text-rules）：
// 文件夹必须以 '/' 结尾、含空白用成对引号。这里把这些口径固化，防止再退回 `@路径` 拼串。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMention, formatMentions, relativeToRoot, toPosixPath,
} from '../src/chatMentions';

test('toPosixPath：Windows 反斜杠统一成正斜杠', () => {
  assert.equal(toPosixPath('C:\\proj\\src\\a.ts'), 'C:/proj/src/a.ts');
  assert.equal(toPosixPath('/home/u/proj/a.ts'), '/home/u/proj/a.ts');
});

test('relativeToRoot：工作区内取相对路径，工作区外保留绝对路径', () => {
  assert.equal(relativeToRoot('/proj/src/a.ts', '/proj'), 'src/a.ts');
  assert.equal(relativeToRoot('/proj2/src/a.ts', '/proj'), '/proj2/src/a.ts');
  // Windows：分隔符与根尾斜杠都要归一
  assert.equal(relativeToRoot('D:\\work\\proj\\src\\a.ts', 'D:\\work\\proj\\'), 'src/a.ts');
  // 工作区根自身没有有意义的相对写法：保留绝对路径（与 DSH 的 relativizeToCwd 口径一致）
  assert.equal(relativeToRoot('/proj', '/proj'), '/proj');
  // 根未知：原样返回（只做分隔符归一）
  assert.equal(relativeToRoot('D:\\proj\\a.ts', undefined), 'D:/proj/a.ts');
});

test('formatMention：文件保持 @路径，文件夹补尾斜杠（修图四文件夹被当成文件）', () => {
  assert.equal(formatMention({ path: '/proj/src/a.ts', isDirectory: false }, '/proj'), '@src/a.ts');
  assert.equal(formatMention({ path: '/proj/test', isDirectory: true }, '/proj'), '@test/');
  // 已经带尾斜杠时不重复补
  assert.equal(formatMention({ path: '/proj/test/', isDirectory: true }, '/proj'), '@test/');
});

test('formatMention：含空白用成对引号（文件夹也闭合，否则 user-text-rules 解析不到）', () => {
  assert.equal(
    formatMention({ path: '/proj/my dir/a.ts', isDirectory: false }, '/proj'),
    '@"my dir/a.ts"',
  );
  assert.equal(
    formatMention({ path: '/proj/my dir', isDirectory: true }, '/proj'),
    '@"my dir/"',
  );
});

test('formatMention：含双引号/控制字符时放弃（DSH 无法表示，不生成假成功）', () => {
  assert.equal(formatMention({ path: '/proj/a"b.ts', isDirectory: false }, '/proj'), null);
  assert.equal(formatMention({ path: '/proj/a\nb.ts', isDirectory: false }, '/proj'), null);
});

test('formatMentions：批量生成并跳过无法表示的路径', () => {
  assert.deepEqual(formatMentions([
    { path: '/proj/src/a.ts', isDirectory: false },
    { path: '/proj/test', isDirectory: true },
    { path: '/proj/bad"name', isDirectory: false },
  ], '/proj'), ['@src/a.ts', '@test/']);
});
