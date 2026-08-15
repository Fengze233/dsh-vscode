// test/bridge/core.test.ts — 桥接纯逻辑单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedExternalUrl,
  buildOpenExternalMessage,
  buildOpenFileMessage,
  buildSyncWorkspaceAck,
  isBridgeMessage,
  WORKSPACE_MESSAGE_KIND,
  HANDSHAKE_TOKEN_KEY,
} from '../../bridge-client/lib/core.js';

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

test('isBridgeMessage 校验 token', () => {
  assert.equal(isBridgeMessage({ token: 't1' }, 't1'), true);
  assert.equal(isBridgeMessage({ token: 't2' }, 't1'), false);
  assert.equal(isBridgeMessage(null, 't1'), false);
});

test('常量取值正确', () => {
  assert.equal(WORKSPACE_MESSAGE_KIND, 'syncWorkspace');
  assert.equal(HANDSHAKE_TOKEN_KEY, 'token');
});
