// test/process.test.ts — 子进程封装的单元测试（注入假 spawn）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
import {
  createProcessRunner,
  sanitizeCwd,
  findInPath,
  binJsFromShim,
  windowsDshInvocation,
  type ChildProcessLike,
  type SpawnFn,
} from '../src/service/process';

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

test('Windows：注入 PATH 命中 dsh.cmd 后以 node 直跑 bin.js 启动，detached 为 false', () => {
  const calls: { cmd: string; args: string[]; opts: { detached?: boolean } }[] = [];
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return new FakeChild();
  };
  const runner = createProcessRunner(spawnImpl, 'win32', 3000, () => true, {
    execPath: 'C:\\node\\node.exe',
    path: 'C:\\npm-global',
  });
  runner.startDsh({ host: '127.0.0.1', port: 0, extraArgs: [] });
  // node 解析顺序：shim 目录旁的 node.exe 优先（exists 注入全 true，命中 npm-global 目录旁）
  assert.equal(calls[0].cmd, 'C:\\npm-global\\node.exe');
  assert.deepEqual(calls[0].args, [
    'C:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    'web', '--host', '127.0.0.1', '--port', '0',
  ]);
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

test('lastStart 记录最近一次启动的实际命令与参数（供 manager 写启动命令日志）', () => {
  const runner = createProcessRunner(() => new FakeChild(), 'win32', 3000, () => true, {
    execPath: 'C:\\node\\node.exe',
    path: 'C:\\npm-global',
  });
  runner.startDsh({ host: '127.0.0.1', port: 0, extraArgs: [] });
  assert.ok(runner.lastStart);
  // command 为解析出的 node 可执行文件（shim 目录旁优先），args 首位为 bin.js 路径
  assert.equal(runner.lastStart.command, 'C:\\npm-global\\node.exe');
  assert.deepEqual(runner.lastStart.args.slice(0, 2), [
    'C:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    'web',
  ]);
});

test('startDsh 透传 cwd 到 spawn 选项（注入 exists=true）', () => {
  const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return new FakeChild();
  };
  // 注入 existsImpl 返回 true，避免真实文件系统上 /proj 不存在导致 cwd 被 sanitizeCwd 过滤
  const runner = createProcessRunner(spawnImpl, 'linux', 3000, () => true);
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], cwd: '/proj' });
  assert.equal(calls[0].opts.cwd, '/proj');
});

test('startDsh 未传 cwd 时 spawn 选项不含 cwd 键', () => {
  const calls: unknown[] = [];
  const runner = createProcessRunner(((cmd, args, opts) => { calls.push(opts); return new FakeChild(); }) as SpawnFn, 'linux');
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  const opts = calls[0] as Record<string, unknown>;
  assert.equal('cwd' in opts, false);
});

test('startDsh：win32 + UNC cwd 被 sanitize 过滤为不传 cwd 键（不抛 EINVAL）', () => {
  // 模拟 Windows 上 VS Code 工作区为 UNC 网络路径的场景
  const calls: unknown[] = [];
  const runner = createProcessRunner(
    ((cmd, args, opts) => { calls.push(opts); return new FakeChild(); }) as SpawnFn,
    'win32',
    3000,
    () => true, // exists 注入 true：使 findInPath 命中 dsh.cmd，并让 sanitizeCwd 走到 UNC 判定
    { execPath: 'C:\\node\\node.exe', path: 'C:\\npm-global' },
  );
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], cwd: '\\\\wsl.localhost\\Ubuntu\\home' });
  const opts = calls[0] as Record<string, unknown>;
  assert.equal('cwd' in opts, false); // UNC 被剥除，spawn 走默认 cwd
});

test('startDsh 传 executablePath 指向 dsh.cmd 时以 node 直跑其 bin.js（win32）', () => {
  const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return new FakeChild();
  };
  const runner = createProcessRunner(spawnImpl, 'win32', 3000, () => true, {
    execPath: 'C:\\node\\node.exe',
    path: 'C:\\Windows\\System32',
  });
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], executablePath: 'C:\\tools\\dsh.cmd' });
  // node 解析顺序：shim 目录旁 node.exe 优先（exists 注入全 true → C:\tools\node.exe 命中）
  assert.equal(calls[0].cmd, 'C:\\tools\\node.exe');
  assert.deepEqual(calls[0].args, [
    'C:\\tools\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    'web', '--host', '127.0.0.1', '--port', '3080',
  ]);
});

test('startDsh 传 executablePath 指向 .js 时直接将其作为 argsPrefix（win32）', () => {
  const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return new FakeChild();
  };
  const runner = createProcessRunner(spawnImpl, 'win32', 3000, () => true, {
    execPath: 'C:\\node\\node.exe',
    path: 'C:\\Windows\\System32',
  });
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], executablePath: 'C:\\repo\\dsh\\lib\\bin.js' });
  // node 解析顺序：bin.js 目录旁 node.exe 优先（exists 注入全 true → lib 目录旁命中）
  assert.equal(calls[0].cmd, 'C:\\repo\\dsh\\lib\\node.exe');
  assert.deepEqual(calls[0].args, [
    'C:\\repo\\dsh\\lib\\bin.js',
    'web', '--host', '127.0.0.1', '--port', '3080',
  ]);
});

test('startDsh 未传 executablePath 时 win32 从 PATH 推导 bin.js（PATH 注入含 dsh.cmd 目录）', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const spawnImpl: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    return new FakeChild();
  };
  const npmDir = 'C:\\Users\\x\\AppData\\Roaming\\npm';
  const runner = createProcessRunner(spawnImpl, 'win32', 3000, (p) => p === `${npmDir}\\dsh.cmd`, {
    execPath: 'C:\\node\\node.exe',
    path: `C:\\Windows\\System32;${npmDir}`,
  });
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  assert.equal(calls[0].cmd, 'C:\\node\\node.exe');
  assert.deepEqual(calls[0].args, [
    `${npmDir}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`,
    'web', '--host', '127.0.0.1', '--port', '3080',
  ]);
});

test('startDsh win32 + 找不到 dsh.cmd（exists 全 false）→ 抛 code ENOENT', () => {
  const runner = createProcessRunner(() => new FakeChild(), 'win32', 3000, () => false, {
    execPath: 'C:\\node\\node.exe',
    path: 'C:\\Windows\\System32',
  });
  assert.throws(
    () => runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] }),
    (err: Error & { code?: string }) => err.code === 'ENOENT',
  );
});

test('startDsh win32 + Electron 环境：绝不使用 execPath（Code.exe），改用 PATH 里的 node.exe', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const spawnImpl: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    return new FakeChild();
  };
  // 模拟 VS Code 扩展宿主：Electron 运行时，execPath 指向 Code.exe（不可当 node 用），
  // PATH 里 node.exe 位于 C:\Program Files\nodejs（exists 仅对该路径返回 true）
  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
  const runner = createProcessRunner(spawnImpl, 'win32', 3000, (p) => p === nodeExe, {
    execPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    path: `C:\\Windows\\System32;C:\\Program Files\\nodejs`,
    electronVersion: '39.2.0',
  });
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], executablePath: 'C:\\npm\\dsh.cmd' });
  // 关键：cmd 必须是系统 node.exe，而不是 Electron 的 Code.exe
  assert.equal(calls[0].cmd, nodeExe);
  assert.deepEqual(calls[0].args, [
    'C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    'web', '--host', '127.0.0.1', '--port', '3080',
  ]);
});

test('startDsh win32 + Electron 环境且 PATH 无 node.exe → 抛 code NODE_NOT_FOUND', () => {
  const runner = createProcessRunner(() => new FakeChild(), 'win32', 3000, () => false, {
    execPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    path: 'C:\\Windows\\System32',
    electronVersion: '39.2.0',
  });
  assert.throws(
    () => runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], executablePath: 'C:\\npm\\dsh.cmd' }),
    (err: Error & { code?: string }) => err.code === 'NODE_NOT_FOUND',
  );
});

test('startDsh win32 + execPath 为 Code.exe（electronVersion 未注入）：文件名检测兜底，改用 PATH 里的 node.exe', () => {
  const calls: { cmd: string }[] = [];
  const spawnImpl: SpawnFn = (cmd) => {
    calls.push({ cmd });
    return new FakeChild();
  };
  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
  const runner = createProcessRunner(spawnImpl, 'win32', 3000, (p) => p === nodeExe, {
    execPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    path: 'C:\\Program Files\\nodejs',
    // 关键：不注入 electronVersion——模拟 versions.electron 检测意外失效，靠文件名兜底
  });
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], executablePath: 'C:\\npm\\dsh.cmd' });
  assert.equal(calls[0].cmd, nodeExe);
});

// —— sanitizeCwd 纯函数 ——

test('sanitizeCwd(undefined) → undefined', () => {
  assert.equal(sanitizeCwd(undefined, 'win32'), undefined);
  assert.equal(sanitizeCwd(undefined, 'linux'), undefined);
});

test('sanitizeCwd：win32 + 合法路径（exists 注入 true）→ 原样返回', () => {
  const cwd = 'C:\\Users\\me\\proj';
  assert.equal(sanitizeCwd(cwd, 'win32', () => true), cwd);
});

test('sanitizeCwd：win32 + UNC 路径 → undefined（exists 不被调用）', () => {
  let called = false;
  const exists = () => { called = true; return true; };
  assert.equal(sanitizeCwd('\\\\wsl.localhost\\Ubuntu\\home', 'win32', exists), undefined);
  assert.equal(called, false); // UNC 在 exists 前即被否决
});

test('sanitizeCwd：win32 + 相对路径 → undefined', () => {
  assert.equal(sanitizeCwd('proj\\sub', 'win32', () => true), undefined);
  assert.equal(sanitizeCwd('proj', 'win32', () => true), undefined);
});

test('sanitizeCwd：win32 + 不存在路径（exists 注入 false）→ undefined', () => {
  assert.equal(sanitizeCwd('C:\\nope', 'win32', () => false), undefined);
});

test('sanitizeCwd：linux + 任意路径（exists true）→ 原样返回（不查 UNC）', () => {
  // Linux 上即使以反斜杠开头也原样返回（无 UNC 概念）
  const unc = '\\\\server\\share';
  assert.equal(sanitizeCwd(unc, 'linux', () => true), unc);
  assert.equal(sanitizeCwd('/home/me', 'linux', () => true), '/home/me');
});

test('sanitizeCwd：linux + 不存在路径（exists false）→ undefined', () => {
  assert.equal(sanitizeCwd('/nope', 'linux', () => false), undefined);
});

// —— findInPath / binJsFromShim / windowsDshInvocation 纯函数 ——

test('findInPath：PATH 多个条目命中第二项返回正确路径', () => {
  // 模拟 Windows PATH 分隔符（;），第一个目录无目标文件，第二个目录命中
  const envPath = 'C:\\Windows\\System32;C:\\npm-global;C:\\tools';
  const exists = (p: string) => p === 'C:\\npm-global\\dsh.cmd';
  assert.equal(findInPath('dsh.cmd', envPath, exists), 'C:\\npm-global\\dsh.cmd');
});

test('findInPath：无命中返回 null', () => {
  const envPath = 'C:\\Windows\\System32;C:\\npm-global';
  assert.equal(findInPath('dsh.cmd', envPath, () => false), null);
});

test('findInPath：envPath 为 undefined 返回 null', () => {
  assert.equal(findInPath('dsh.cmd', undefined, () => true), null);
});

test('binJsFromShim：由 dsh.cmd 绝对路径推导 npm shim 真实入口 bin.js', () => {
  const shim = 'C:\\Users\\x\\AppData\\Roaming\\npm\\dsh.cmd';
  const expected = 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
  assert.equal(binJsFromShim(shim), expected);
});

test('windowsDshInvocation：command 为传入 execPath，argsPrefix[0] 为 bin.js 路径', () => {
  const inv = windowsDshInvocation('C:\\npm-global\\dsh.cmd', 'C:\\node\\node.exe');
  assert.equal(inv.command, 'C:\\node\\node.exe');
  assert.deepEqual(inv.argsPrefix, [
    'C:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  ]);
});
