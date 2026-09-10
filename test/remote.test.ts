// test/remote.test.ts — 远程场景检测与 URL 隧道解析的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRemoteName,
  classifyRemote,
  createUrlResolver,
  toLocalhostUrl,
  handshakeTimeoutMs,
  bridgeEvalDelayMs,
} from '../src/remote';

test('isRemoteName：空/undefined 为本地，其余为远程', () => {
  assert.equal(isRemoteName(undefined), false);
  assert.equal(isRemoteName(''), false);
  assert.equal(isRemoteName('ssh-remote'), true);
  assert.equal(isRemoteName('wsl'), true);
  assert.equal(isRemoteName('dev-container'), true);
});

test('classifyRemote：wsl 与 ssh 隧道分开归类（issue #13-3）', () => {
  assert.equal(classifyRemote(undefined), 'local');
  assert.equal(classifyRemote(''), 'local');
  assert.equal(classifyRemote('wsl'), 'wsl'); // WSL：同机直连 + localhost 转发，不需要隧道
  assert.equal(classifyRemote('ssh-remote'), 'tunneled');
  assert.equal(classifyRemote('dev-container'), 'tunneled');
  assert.equal(classifyRemote('codespaces'), 'tunneled');
  assert.equal(classifyRemote('attached-container'), 'tunneled');
});

test('toLocalhostUrl：回环 host 统一替换为 localhost，非回环原样', () => {
  assert.equal(toLocalhostUrl('http://127.0.0.1:3080/'), 'http://localhost:3080/');
  assert.equal(toLocalhostUrl('http://localhost:3080/?a=1'), 'http://localhost:3080/?a=1');
  assert.equal(toLocalhostUrl('http://127.0.0.1:56000/'), 'http://localhost:56000/');
  // 隧道地址不是回环：原样返回
  assert.equal(toLocalhostUrl('http://127.0.0.1:56000/'.replace('127.0.0.1', 'vscode.localhost')), 'http://vscode.localhost:56000/');
  assert.equal(toLocalhostUrl('not a url'), 'not a url');
});

test('handshakeTimeoutMs / bridgeEvalDelayMs：tunneled 15s，local/wsl 5s（issue #13-5）', () => {
  assert.equal(handshakeTimeoutMs('ssh-remote'), 15000);
  assert.equal(bridgeEvalDelayMs('ssh-remote'), 16500);
  assert.equal(handshakeTimeoutMs(undefined), 5000);
  assert.equal(handshakeTimeoutMs('wsl'), 5000);
  assert.equal(bridgeEvalDelayMs('wsl'), 6500);
});

test('createUrlResolver：asExternalUri 成功返回其值，失败回退原 URL', async () => {
  const ok = await createUrlResolver({ asExternalUri: async () => ({ toString: () => 'http://127.0.0.1:56000/' }) })('http://127.0.0.1:3080/');
  assert.equal(ok, 'http://127.0.0.1:56000/');
  const fb = await createUrlResolver({ asExternalUri: async () => { throw new Error('x'); } })('http://127.0.0.1:3080/');
  assert.equal(fb, 'http://127.0.0.1:3080/');
});
