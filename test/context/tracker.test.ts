// test/context/tracker.test.ts — 当前文件跟踪与路径引用规则
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFileRef, createCurrentFileTracker, type TrackerTimers } from '../../src/context/tracker';

/** 假定时器:手动触发,断言防抖行为 */
function fakeTimers(): TrackerTimers & { pending: Array<{ fn: () => void; ms: number }> } {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    pending,
    setTimeout: (fn, ms) => {
      pending.push({ fn, ms });
      return pending.length - 1;
    },
    clearTimeout: (handle) => {
      pending.splice(handle as number, 1);
    },
  };
}

test('describeFileRef:工作区内文件 → 相对路径(正斜杠)', () => {
  const r = describeFileRef('/proj/src/foo.ts', '/proj');
  assert.equal(r.ref, 'src/foo.ts');
  assert.equal(r.relToWorkspace, true);
});

test('describeFileRef:工作区外文件 → 绝对路径', () => {
  const r = describeFileRef('/elsewhere/bar.ts', '/proj');
  assert.equal(r.ref, '/elsewhere/bar.ts');
  assert.equal(r.relToWorkspace, false);
});

test('describeFileRef:无工作区根 → 绝对路径', () => {
  const r = describeFileRef('/proj/src/foo.ts', undefined);
  assert.equal(r.ref, '/proj/src/foo.ts');
  assert.equal(r.relToWorkspace, false);
});

test('describeFileRef:文件等于根目录本身 → 绝对路径(非 inside)', () => {
  const r = describeFileRef('/proj', '/proj');
  assert.equal(r.ref, '/proj');
});

test('tracker:防抖窗口内多次 setFile 只结算最后一次', () => {
  const timers = fakeTimers();
  const settled: Array<string | undefined> = [];
  const tracker = createCurrentFileTracker({ debounceMs: 800, timers });
  tracker.onSettled((p) => settled.push(p));
  tracker.setFile('/a.ts');
  tracker.setFile('/b.ts');
  tracker.setFile('/c.ts');
  assert.equal(timers.pending.length, 1); // 前两次被取消,只剩一个定时器
  assert.equal(tracker.getCurrent(), undefined); // 结算前仍为旧值
  timers.pending[0].fn(); // 手动触发结算
  assert.equal(tracker.getCurrent(), '/c.ts');
  assert.deepEqual(settled, ['/c.ts']);
});

test('tracker:setFile(undefined) 结算为 undefined(编辑器全部关闭)', () => {
  const timers = fakeTimers();
  const tracker = createCurrentFileTracker({ debounceMs: 800, timers });
  tracker.setFile('/a.ts');
  timers.pending[0].fn();
  tracker.setFile(undefined);
  timers.pending[0].fn();
  assert.equal(tracker.getCurrent(), undefined);
});

test('tracker:dispose 清理定时器与监听器', () => {
  const timers = fakeTimers();
  const tracker = createCurrentFileTracker({ debounceMs: 800, timers });
  tracker.setFile('/a.ts');
  tracker.dispose();
  assert.equal(timers.pending.length, 0); // 定时器已清理
});
