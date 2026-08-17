// test/manager.test.ts — 服务管理器状态机的单元测试（假探测 + 假子进程）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceManager, type ManagerDeps } from '../src/service/manager';
import type { ProbeResult } from '../src/service/detect';
import type { ChildProcessLike, ProcessRunner } from '../src/service/process';

/** 假子进程（同 process.test.ts 的 FakeChild） */
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

interface Harness {
  manager: ServiceManager;
  probeQueue: ProbeResult[];   // 探测结果队列，取完后循环最后一个
  child: FakeChild | null;
  spawnCount: number;
  probeCount: number;          // 探测调用次数，用于断言定时器已清理
  states: string[];            // 记录状态变化序列
}

function makeHarness(opts?: Partial<Parameters<ServiceManager['reconfigure']>[0]>, depsOpts?: Partial<ManagerDeps>): Harness {
  const h: Harness = {
    manager: null as unknown as ServiceManager,
    probeQueue: [],
    child: null,
    spawnCount: 0,
    probeCount: 0,
    states: [],
  };
  const probeService = async (_host: string, _port: number): Promise<ProbeResult> => {
    h.probeCount += 1;
    return h.probeQueue.length > 1 ? h.probeQueue.shift()! : h.probeQueue[0];
  };
  const processRunner: ProcessRunner = {
    startDsh: () => {
      h.spawnCount += 1;
      h.child = new FakeChild();
      return h.child;
    },
    stopChild: async (c) => {
      c.kill('SIGTERM');
      c.kill('SIGKILL');
    },
    lastChild: null,
  };
  h.manager = new ServiceManager(
    {
      host: '127.0.0.1', port: 3080, extraArgs: [], autoStart: true,
      timeoutMs: 100, pollMs: 5, ...opts,
    },
    { probeService, processRunner, log: () => {}, startTimeoutMs: 50, ...depsOpts },
  );
  h.manager.onChange((s) => h.states.push(s.state));
  return h;
}

test('探测到 dsh：直接复用（owned=false），不启动子进程', async () => {
  const h = makeHarness();
  h.probeQueue = ['dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false);
  assert.equal(s.url, 'http://127.0.0.1:3080/');
  assert.equal(h.spawnCount, 0);
  assert.deepEqual(h.states, ['detecting', 'ready']);
  h.manager.dispose();
});

test('探测到外来服务：failed + err.portOccupied', async () => {
  const h = makeHarness();
  h.probeQueue = ['foreign'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.portOccupied');
  assert.equal(h.spawnCount, 0);
  h.manager.dispose();
});

test('服务未运行且 autoStart=false：failed + err.notRunning', async () => {
  const h = makeHarness({ autoStart: false });
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.notRunning');
  assert.equal(h.spawnCount, 0);
  h.manager.dispose();
});

test('自动启动成功：down,down,dsh → ready(owned=true)，状态序列正确', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.equal(h.spawnCount, 1);
  assert.deepEqual(h.states, ['detecting', 'starting', 'waiting', 'ready']);
  h.manager.dispose();
});

test('启动超时：failed + err.startTimeout', async () => {
  const h = makeHarness();
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.startTimeout');
  assert.equal(s.errorVars?.seconds, 0); // startTimeoutMs=50 → round(50/1000)=0（真实环境为 15 秒）
  h.manager.dispose();
});

test('等待中子进程退出：failed + err.startCrashed', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning();
  // 第一次探测后子进程已 spawn，模拟崩溃
  await new Promise((r) => setTimeout(r, 1));
  h.child?.emitExit(1);
  const s = await p;
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.startCrashed');
  h.manager.dispose();
});

test('等待中子进程退出但端口已有 dsh（残留实例自愈）：复用 → ready(owned=false)', async () => {
  const h = makeHarness();
  // 第一次探测 down → spawn；等待循环首轮轮询 down；子进程崩溃后的自愈探测命中 dsh
  h.probeQueue = ['down', 'down', 'dsh'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  h.child?.emitExit(1); // 模拟新实例因 EADDRINUSE 崩溃退出
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false); // 复用外部（残留）服务，插件不拥有它
  assert.equal(s.error, null);
  h.manager.dispose();
});

test('ready 后子进程意外退出：回到 idle（面板据此显示已断开）', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  h.child?.emitExit(1);
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.equal(h.manager.getSnapshot().url, null);
  h.manager.dispose();
});

test('spawn 报 ENOENT：failed + err.dshNotFound（不空等超时）', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  // 模拟 dsh 命令不存在
  const err = Object.assign(new Error('spawn dsh ENOENT'), { code: 'ENOENT' });
  for (const cb of h.child!.errorCbs) cb(err);
  const s = await p;
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.dshNotFound');
  h.manager.dispose();
});

test('error 事件报 EINVAL：failed + err.spawnEinval 且带 cwd（不空等超时）', async () => {
  const h = makeHarness({ cwd: '\\\\wsl.localhost\\Ubuntu\\home' });
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  // 模拟 Windows 上非法 spawn 参数（EINVAL 同步异常经 error 事件异步到达）
  const err = Object.assign(new Error('spawn dsh.cmd EINVAL'), { code: 'EINVAL' });
  for (const cb of h.child!.errorCbs) cb(err);
  const s = await p;
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.spawnEinval');
  assert.equal(s.errorVars?.cwd, '\\\\wsl.localhost\\Ubuntu\\home');
  h.manager.dispose();
});

test('startDsh 同步抛 EINVAL：failed + err.spawnEinval（doStart catch 分支）', async () => {
  const logs: string[] = [];
  const h = makeHarness({ cwd: '\\\\wsl.localhost\\Ubuntu\\home' }, {
    processRunner: {
      startDsh: () => {
        throw Object.assign(new Error('spawn dsh.cmd EINVAL'), { code: 'EINVAL' });
      },
      stopChild: async () => {},
      lastChild: null,
    },
    log: (line) => logs.push(line),
  });
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.spawnEinval');
  assert.equal(s.errorVars?.cwd, '\\\\wsl.localhost\\Ubuntu\\home');
  // 日志应记录 code 与 cwd，且不再误报「未找到命令」
  assert.ok(logs.some((l) => l.includes('code=EINVAL') && l.includes('cwd=\\\\wsl.localhost\\Ubuntu\\home')));
  h.manager.dispose();
});

test('startDsh 抛 NODE_NOT_FOUND（Windows 找不到 node.exe）：failed + err.nodeNotFound', async () => {
  const h = makeHarness(undefined, {
    processRunner: {
      startDsh: () => {
        throw Object.assign(new Error('node.exe not found in PATH (dsh shim at C:\\npm\\dsh.cmd)'), { code: 'NODE_NOT_FOUND' });
      },
      stopChild: async () => {},
      lastChild: null,
    },
  });
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.nodeNotFound'); // 与「未找到 dsh」区分，提示安装/加 PATH Node.js
  h.manager.dispose();
});

test('stop() 只停插件自启的子进程', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  await h.manager.stop();
  assert.deepEqual(h.child!.killed, ['SIGTERM', 'SIGKILL']);
  assert.equal(h.manager.getSnapshot().state, 'idle');
  h.manager.dispose();
});

test('复用外部服务时 stop() 不杀任何进程', async () => {
  const h = makeHarness();
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  await h.manager.stop();
  assert.equal(h.spawnCount, 0);
  assert.equal(h.manager.getSnapshot().state, 'idle');
  h.manager.dispose();
});

test('ensureRunning 并发幂等：只 spawn 一次', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  const [a, b] = await Promise.all([h.manager.ensureRunning(), h.manager.ensureRunning()]);
  assert.equal(a.state, 'ready');
  assert.equal(b.state, 'ready');
  assert.equal(h.spawnCount, 1);
  h.manager.dispose();
});

test('reconfigure 换端口：自启服务先停再按新端口启动', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  const oldChild = h.child!; // 捕获旧子进程引用（reconfigure 重启后 h.child 会指向新子进程）
  h.probeQueue = ['down', 'dsh'];
  const s = await h.manager.reconfigure({
    host: '127.0.0.1', port: 4000, extraArgs: [], autoStart: true, timeoutMs: 100, pollMs: 5,
  });
  assert.equal(s.state, 'ready');
  assert.ok(oldChild.killed.length > 0); // 旧服务确实被停止（SIGTERM+SIGKILL）
  assert.equal(h.manager.getTarget().port, 4000);
  h.manager.dispose();
});

test('启动等待阶段 stop()：立即停掉子进程、流程以 idle 结束（不误报崩溃）', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1)); // 子进程已 spawn，进入 waiting
  await h.manager.stop();
  h.child?.emitExit(1); // 模拟真实 kill 触发的 exit 事件竞态
  const s = await p;
  assert.equal(s.state, 'idle'); // stopRequested 判定先于 childExited，不误报 startCrashed
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.ok(h.child!.killed.length > 0); // 子进程被停掉，无孤儿
  h.manager.dispose();
});

test('复用外部服务失联：健康探测发现后回到 idle（面板显示已断开）', async () => {
  const h = makeHarness({}, { healthIntervalMs: 30 });
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  h.probeQueue = ['down']; // 外部服务失联
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(h.manager.getSnapshot().state, 'idle');
  h.manager.dispose();
});

test('Windows spawn 带 cwd 同步抛 EINVAL 时自动去掉 cwd 重试一次并成功', async () => {
  const logs: string[] = [];
  const receivedCwds: (string | undefined)[] = []; // 记录每次 startDsh 收到的 cwd
  const h = makeHarness({ cwd: 'D:\\work\\项目' }, {
    processRunner: {
      startDsh: (opts) => {
        h.spawnCount += 1;
        receivedCwds.push(opts.cwd);
        if (opts.cwd !== undefined) {
          // 第一次（带 cwd）同步抛 EINVAL，模拟 Windows 上 .cmd 带 cwd 的已知问题
          throw Object.assign(new Error('spawn dsh.cmd EINVAL'), { code: 'EINVAL' });
        }
        // 第二次（去掉 cwd）成功返回子进程
        h.child = new FakeChild();
        return h.child;
      },
      stopChild: async (c) => {
        c.kill('SIGTERM');
        c.kill('SIGKILL');
      },
      lastChild: null,
    },
    log: (line) => logs.push(line),
  });
  h.probeQueue = ['down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.equal(h.spawnCount, 2); // 第一次抛、第二次成功
  assert.deepEqual(receivedCwds, ['D:\\work\\项目', undefined]); // 第二次 cwd 为 undefined
  assert.ok(logs.some((l) => l.includes('回退'))); // 日志应含「回退」相关字样
  h.manager.dispose();
});

test('去掉 cwd 重试仍抛 EINVAL 时置 err.spawnEinval', async () => {
  const logs: string[] = [];
  const receivedCwds: (string | undefined)[] = [];
  const h = makeHarness({ cwd: '\\\\wsl.localhost\\Ubuntu\\home' }, {
    processRunner: {
      startDsh: (opts) => {
        receivedCwds.push(opts.cwd);
        // 无论是否带 cwd 都抛 EINVAL → 降级重试后仍然失败，最终 err.spawnEinval
        throw Object.assign(new Error('spawn dsh.cmd EINVAL'), { code: 'EINVAL' });
      },
      stopChild: async () => {},
      lastChild: null,
    },
    log: (line) => logs.push(line),
  });
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.spawnEinval');
  assert.equal(s.errorVars?.cwd, '\\\\wsl.localhost\\Ubuntu\\home');
  assert.deepEqual(receivedCwds, ['\\\\wsl.localhost\\Ubuntu\\home', undefined]); // 重试时 cwd 为 undefined
  h.manager.dispose();
});

test('复用外部服务 stop()：清理健康定时器并回到 idle', async () => {
  const h = makeHarness({}, { healthIntervalMs: 30 });
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  await h.manager.stop();
  assert.equal(h.manager.getSnapshot().state, 'idle');
  // 停止后不应再有探测发生：若定时器泄漏，30ms 间隔会在 90ms 内触发约 3 次探测
  const probesBefore = h.probeCount;
  h.probeQueue = ['foreign'];
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(h.probeCount, probesBefore); // 无新增探测 = 定时器已清理
  h.manager.dispose();
});
