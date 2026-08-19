// test/remote.test.ts — 远程场景检测与 URL 隧道解析的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRemoteName, createUrlResolver } from '../src/remote';

test('isRemoteName：空/undefined 为本地，其余为远程', () => {
  assert.equal(isRemoteName(undefined), false);
  assert.equal(isRemoteName(''), false);
  assert.equal(isRemoteName('ssh-remote'), true);
  assert.equal(isRemoteName('wsl'), true);
  assert.equal(isRemoteName('dev-container'), true);
});

test('createUrlResolver：asExternalUri 成功返回其值，失败回退原 URL', async () => {
  const ok = await createUrlResolver({ asExternalUri: async () => ({ toString: () => 'http://127.0.0.1:56000/' }) })('http://127.0.0.1:3080/');
  assert.equal(ok, 'http://127.0.0.1:56000/');
  const fb = await createUrlResolver({ asExternalUri: async () => { throw new Error('x'); } })('http://127.0.0.1:3080/');
  assert.equal(fb, 'http://127.0.0.1:3080/');
});
