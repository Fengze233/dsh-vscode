// test/bridge/status.test.ts — 桥接状态评估单测
// 覆盖 evaluateBridgeStatus 的四条判定规则与 bridgeWarningText 的文案键选择。
// 纯函数测试：不依赖 vscode、不触碰磁盘，直接注入安装结果与握手结果。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBridgeStatus, bridgeWarningText } from '../../src/bridge/status';

test('安装失败即 degraded', () => {
  assert.equal(evaluateBridgeStatus({ status: 'degraded', reason: 'x' }, undefined), 'degraded');
});

test('握手成功为 ok', () => {
  assert.equal(evaluateBridgeStatus({ status: 'ok' }, true), 'ok');
});

test('安装成功但握手未发生为 pending-restart', () => {
  assert.equal(evaluateBridgeStatus({ status: 'ok' }, undefined), 'pending-restart');
});

test('握手失败为 degraded', () => {
  assert.equal(evaluateBridgeStatus({ status: 'ok' }, false), 'degraded');
});

test('degraded 给出警告文案键，其余状态为 null', () => {
  assert.equal(bridgeWarningText('degraded'), 'bridge.warnDegraded');
  assert.equal(bridgeWarningText('ok'), null);
  assert.equal(bridgeWarningText('pending-restart'), null);
});
