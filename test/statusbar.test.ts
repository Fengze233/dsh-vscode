// test/statusbar.test.ts — 状态栏样式与文案随服务状态变化的回归测试
// 视觉口径（v0.5.0）：与 Claude Code 的状态栏项一致——一个符号 + 产品名，运行中不着色，
// 具体状态与错误放进 tooltip，避免常驻的绿色/橙色条目抢占注意力。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscodeStub from './vscode-stub';
import { StatusBarController } from '../src/statusbar';
import { initI18n, t } from '../src/i18n';
import type { ServiceSnapshot } from '../src/service/manager';

type FakeItem = {
  text: string;
  color?: unknown;
  tooltip?: string;
  command?: string;
  show(): void;
  dispose(): void;
};

test('状态栏：运行中不着色、状态进 tooltip，停止中不得显示「启动中」', (t0) => {
  initI18n('en');
  let snapshot: ServiceSnapshot = { state: 'ready', url: null, error: null, owned: true };
  const listeners = new Set<(s: ServiceSnapshot) => void>();
  const manager = {
    getSnapshot: () => snapshot,
    onChange: (cb: (s: ServiceSnapshot) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const item: FakeItem = { text: '', show: () => {}, dispose: () => {} };
  t0.mock.method(vscodeStub.window, 'createStatusBarItem', () => item);

  const controller = new StatusBarController(manager as never);
  const fire = (s: ServiceSnapshot): void => {
    snapshot = s;
    for (const cb of listeners) cb(s);
  };

  // 运行中：静态星号 + 产品名，与 Claude Code 的 `✻ Claude Code` 同构
  assert.equal(item.text, '✻ DSH');
  assert.equal(item.color, undefined, '运行中不应设置颜色');
  assert.equal(item.tooltip, t('status.running'));
  assert.equal(item.command, 'dsh.openPanel');

  // 停止中：转圈图标，状态写进 tooltip，且不能误写成「启动中」
  fire({ state: 'stopping', url: null, error: null, owned: true });
  assert.equal(item.text, '$(sync~spin) DSH');
  assert.equal(item.tooltip, t('status.stopping'));
  assert.notEqual(item.tooltip, t('status.starting'));

  // 已停止：灰点图标（保留弱化色）
  fire({ state: 'idle', url: null, error: null, owned: false });
  assert.equal(item.text, '$(circle-outline) DSH');
  assert.equal((item.color as { id?: string } | undefined)?.id, 'descriptionForeground');

  // 失败：唯一需要抢注意力的状态，保留红色
  fire({ state: 'failed', url: null, error: null, owned: true });
  assert.equal(item.text, '$(error) DSH');
  assert.equal((item.color as { id?: string } | undefined)?.id, 'charts.red');

  controller.dispose();
});
