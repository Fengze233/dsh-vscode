// test/bridge/sync.test.ts — 工作区同步编排单测
// 覆盖：resolveWorkspaceRoot 的多根索引/越界回退/空工作区；syncWorkspace 的
// 幂等复用（list 命中不 create）与未命中时 create 两个分支。
// 生产侧接真实 DSH API 客户端，这里注入假 DshApiClient 验证纯编排逻辑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspaceRoot, syncWorkspace } from '../../src/bridge/sync';
import type { DshApiClient } from '../../src/bridge/api';

test('resolveWorkspaceRoot 按索引取根', () => {
  const folders = [{ uri: { fsPath: '/a' } }, { uri: { fsPath: '/b' } }];
  assert.equal(resolveWorkspaceRoot(folders, 0), '/a');
  assert.equal(resolveWorkspaceRoot(folders, 1), '/b');
  assert.equal(resolveWorkspaceRoot(folders, 5), '/a'); // 越界回退第一个
  assert.equal(resolveWorkspaceRoot([], 0), undefined);
});

test('syncWorkspace 命中已有 workspace 时复用不创建', async () => {
  const calls: string[] = [];
  const api: DshApiClient = {
    workspaceList: async () => [{ workspaceId: 'w1', path: '/proj' }],
    workspaceCreate: async (p) => { calls.push(p); return { workspaceId: 'w2', path: p }; },
  };
  const ws = await syncWorkspace(api, '/proj');
  assert.equal(ws.workspaceId, 'w1');
  assert.deepEqual(calls, []);
});

test('syncWorkspace 未命中时创建', async () => {
  const api: DshApiClient = {
    workspaceList: async () => [],
    workspaceCreate: async (p) => ({ workspaceId: 'w2', path: p }),
  };
  const ws = await syncWorkspace(api, '/proj');
  assert.equal(ws.workspaceId, 'w2');
});
