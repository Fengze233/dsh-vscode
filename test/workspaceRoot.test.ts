// test/workspaceRoot.test.ts — 工作区根目录解析单测
// 覆盖：resolveWorkspaceRoot 的多根索引取根、索引越界回退第一个根目录、空工作区返回 undefined。
// 该函数是 spawn cwd 兜底（dsh web 进程工作目录）的基础能力，纯函数无副作用，直接注入假数据验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspaceRoot } from '../src/workspaceRoot';

test('resolveWorkspaceRoot 按索引取根', () => {
  const folders = [{ uri: { fsPath: '/a' } }, { uri: { fsPath: '/b' } }];
  assert.equal(resolveWorkspaceRoot(folders, 0), '/a');
  assert.equal(resolveWorkspaceRoot(folders, 1), '/b');
  assert.equal(resolveWorkspaceRoot(folders, 5), '/a'); // 越界回退第一个
  assert.equal(resolveWorkspaceRoot([], 0), undefined);
});
