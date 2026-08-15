// test/process.test.ts — 子进程封装的单元测试（注入假 spawn）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessRunner, type ChildProcessLike, type SpawnFn } from '../src/service/process';

/** 假子进程：记录 kill 调用、可手动触发 exit/error 事件 */
class FakeChild implements ChildProcessLike {
  pid = 1234;
  killed: string[] = [];
  exitCbs: ((code: number | null) => void)[] = [];
  errorCbs: ((err: Error) => void)[] = [];
  stdout = { on: (_e: 'data', _cb: (chunk: Buffer) => void) => {} };
  stderr = { on: (_e: 'data', _cb: (chunk: Buffer) => void) => {} };
  on(event: 'exit' | 'error', cb: (...args: never[]) => void): void {
    if (event === 'exit') this.exitCbs.push(cb as (code: number | null) => void);
    else this.errorCbs.push(cb as (err: Error) => void);
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
  emitExit(code: number | null = null): void {
    for (const cb of [...this.exitCbs]) cb(code);
  }
}

test('Linux/macOS：命令为 dsh，detached 为 true，参数顺序正确', () => {
  const calls: { cmd: string; args: string[]; opts: { detached?: boolean } }[] = [];
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return new FakeChild();
  };
  const runner = createProcessRunner(spawnImpl, 'linux');
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: ['--trusted-host', 'x:1'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'dsh');
  assert.deepEqual(calls[0].args, ['web', '--host', '127.0.0.1', '--port', '3080', '--trusted-host', 'x:1']);
  assert.equal(calls[0].opts.detached, true);
});

test('Windows：命令为 dsh.cmd，detached 为 false', () => {
  const calls: { cmd: string; args: string[]; opts: { detached?: boolean } }[] = [];
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return new FakeChild();
  };
  const runner = createProcessRunner(spawnImpl, 'win32');
  runner.startDsh({ host: '127.0.0.1', port: 0, extraArgs: [] });
  assert.equal(calls[0].cmd, 'dsh.cmd');
  assert.equal(calls[0].opts.detached, false);
});

test('stopChild 先发 SIGTERM，graceMs 后补 SIGKILL', async () => {
  const child = new FakeChild();
  const runner = createProcessRunner(undefined, 'linux', 20); // 缩短宽限期便于测试
  await runner.stopChild(child);
  assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL']);
});

test('lastChild 记录最近一次启动的子进程（测试钩子）', () => {
  const runner = createProcessRunner(() => new FakeChild(), 'linux');
  const child = runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  assert.equal(runner.lastChild, child);
});
