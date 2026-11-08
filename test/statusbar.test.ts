// test/statusbar.test.ts — 状态栏文案随服务状态变化的回归测试
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

test('停止中状态栏显示「正在停止」而不是「启动中」', (t0) => {
  initI18n('en');
  let snapshot: ServiceSnapshot = { state: 'stopping', url: null, error: null, owned: true };
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
  assert.ok(item.text.includes(t('status.stopping')));
  assert.ok(!item.text.includes(t('status.starting')));
  // 颜色与 starting（charts.yellow）区分：停止中为 charts.orange
  assert.equal((item.color as { id?: string } | undefined)?.id, 'charts.orange');

  // 停止完成回到 idle：状态栏应切到「已停止」
  snapshot = { state: 'idle', url: null, error: null, owned: false };
  for (const cb of listeners) cb(snapshot);
  assert.ok(item.text.includes(t('status.stopped')));

  controller.dispose();
});
