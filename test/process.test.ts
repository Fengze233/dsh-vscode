// test/process.test.ts — 子进程封装的单元测试（注入假 spawn）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
import {
  createProcessRunner,
  sanitizeCwd,
  findInPath,
  findInPathPosix,
  resolveDshPackageJsonPath,
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
  for (const profile of [undefined, 'web', 'custom-profile']) {
    const calls: { cmd: string; args: string[]; opts: { detached?: boolean } }[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return new FakeChild();
    };
    const runner = createProcessRunner(spawnImpl, 'linux');
    runner.startDsh({ profile, host: '127.0.0.1', port: 3081, extraArgs: ['--trusted-host', 'x:1'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'dsh');
    assert.deepEqual(calls[0].args, ['--profile', profile ?? 'web', '--host', '127.0.0.1', '--port', '3081', '--trusted-host', 'x:1', '--no-open']);
    assert.equal(calls[0].opts.detached, true);
  }
});

test('Windows：注入 PATH 命中 dsh.cmd 后以 node 直跑 bin.js 启动，detached 为 false', () => {
  for (const profile of [undefined, 'web', 'custom-profile']) {
    const calls: { cmd: string; args: string[]; opts: { detached?: boolean } }[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return new FakeChild();
    };
    // exists 只认这三个真实存在的路径：shim、其推导出的 bin.js、shim 目录旁的 node.exe。
    // （全 true 的假实现会让「bin.js 存在性校验」形同虚设，无法覆盖 issue #30 的场景）
    const shim = 'C:\\npm-global\\dsh.cmd';
    const binJs = 'C:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
    const runner = createProcessRunner(
      spawnImpl, 'win32', 3000,
      (p) => p === shim || p === binJs || p === 'C:\\npm-global\\node.exe',
      { execPath: 'C:\\node\\node.exe', path: 'C:\\npm-global' },
    );
    runner.startDsh({ profile, host: '127.0.0.1', port: 0, extraArgs: [] });
    // node 解析顺序：shim 目录旁的 node.exe 优先（shim 与 bin.js 均存在 → npm 来源可用）
    assert.equal(calls[0].cmd, 'C:\\npm-global\\node.exe');
    assert.deepEqual(calls[0].args, [
      'C:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      '--profile', profile ?? 'web', '--host', '127.0.0.1', '--port', '0', '--no-open',
    ]);
    assert.equal(calls[0].opts.detached, false);
  }
});

test('Windows：bin.js 不存在时回退执行桌面端 dsh.cmd（cmd.exe /d /s /c）', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const spawnImpl: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    return new FakeChild();
  };
  const desktopLap = 'C:\\Users\\u\\AppData\\Local';
  const desktopCmd = 'C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
  const runner = createProcessRunner(spawnImpl, 'win32', 3000, (p) => p === desktopCmd, {
    execPath: 'C:\\node\\node.exe',
    path: 'C:\\npm-global',
    localAppData: desktopLap,
  });
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  assert.equal(calls[0].cmd, 'cmd.exe');
  assert.deepEqual(calls[0].args, [
    '/d', '/s', '/c', desktopCmd,
    '--profile', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open',
  ]);
  assert.equal(runner.lastStart?.source, 'desktop');
});

test('Windows：npm 与桌面端都不可用时抛 ENOENT（保持既有「未找到 dsh」语义）', () => {
  const runner = createProcessRunner((() => new FakeChild()) as SpawnFn, 'win32', 3000, () => false, {
    execPath: 'C:\\node\\node.exe',
    path: 'C:\\npm-global',
    localAppData: 'C:\\Users\\u\\AppData\\Local',
  });
  assert.throws(() => runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] }), (err: Error & { code?: string }) => {
    assert.equal(err.code, 'ENOENT');
    return true;
  });
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
  const shim = 'C:\\npm-global\\dsh.cmd';
  const binJs = 'C:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
  const runner = createProcessRunner(
    () => new FakeChild(), 'win32', 3000,
    (p) => p === shim || p === binJs || p === 'C:\\npm-global\\node.exe',
    { execPath: 'C:\\node\\node.exe', path: 'C:\\npm-global' },
  );
  runner.startDsh({ host: '127.0.0.1', port: 0, extraArgs: [] });
  assert.ok(runner.lastStart);
  // command 为解析出的 node 可执行文件（shim 目录旁优先），args 首位为 bin.js 路径
  assert.equal(runner.lastStart.command, 'C:\\npm-global\\node.exe');
  assert.deepEqual(runner.lastStart.args.slice(0, 3), [
    'C:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    '--profile', 'web',
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
  // exists 只认 shim/bin.js/node.exe：让 launcher 判定 npm 来源可用，
  // 同时 sanitizeCwd 走到 UNC 判定（UNC 分支在 exists 之前就返回 undefined）
  const shim = 'C:\\npm-global\\dsh.cmd';
  const binJs = 'C:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
  const runner = createProcessRunner(
    ((cmd, args, opts) => { calls.push(opts); return new FakeChild(); }) as SpawnFn,
    'win32',
    3000,
    (p) => p === shim || p === binJs || p === 'C:\\npm-global\\node.exe',
    { execPath: 'C:\\node\\node.exe', path: 'C:\\npm-global' },
  );
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], cwd: '\\\\wsl.localhost\\Ubuntu\\home' });
  const opts = calls[0] as Record<string, unknown>;
  assert.equal('cwd' in opts, false); // UNC 被剥除，spawn 走默认 cwd
});

test('startDsh 传 executablePath 指向 dsh.cmd 时直接执行该脚本，不再推导 bin.js（win32，issue #30）', () => {
  const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return new FakeChild();
  };
  const desktopCmd = 'C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
  // 只认用户配置的那一个脚本：其目录下没有 node_modules 布局（正是 DSH Desktop 的真实情况）
  const runner = createProcessRunner(spawnImpl, 'win32', 3000, (p) => p === desktopCmd, {
    execPath: 'C:\\node\\node.exe',
    path: 'C:\\Windows\\System32',
  });
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], executablePath: desktopCmd });
  assert.equal(calls[0].cmd, 'cmd.exe');
  assert.deepEqual(calls[0].args, [
    '/d', '/s', '/c', desktopCmd,
    '--profile', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open',
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
    '--profile', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open',
  ]);
});

test('startDsh 未传 executablePath 时 win32 从 PATH 推导 bin.js（PATH 注入含 dsh.cmd 目录）', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const spawnImpl: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    return new FakeChild();
  };
  const npmDir = 'C:\\Users\\x\\AppData\\Roaming\\npm';
  // 只认 shim 与它推导出的 bin.js：两者都在 → npm 来源可用（存在性校验生效）
  const runner = createProcessRunner(
    spawnImpl, 'win32', 3000,
    (p) => p === `${npmDir}\\dsh.cmd` || p === `${npmDir}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`,
    {
      execPath: 'C:\\node\\node.exe',
      path: `C:\\Windows\\System32;${npmDir}`,
    },
  );
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  assert.equal(calls[0].cmd, 'C:\\node\\node.exe');
  assert.deepEqual(calls[0].args, [
    `${npmDir}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`,
    '--profile', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open',
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
  // PATH 里 node.exe 位于 C:\Program Files\nodejs；显式路径指向 bin.js（node 模式）
  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
  const binJs = 'C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
  const runner = createProcessRunner(spawnImpl, 'win32', 3000, (p) => p === nodeExe || p === binJs, {
    execPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    path: `C:\\Windows\\System32;C:\\Program Files\\nodejs`,
    electronVersion: '39.2.0',
  });
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], executablePath: binJs });
  // 关键：cmd 必须是系统 node.exe，而不是 Electron 的 Code.exe
  assert.equal(calls[0].cmd, nodeExe);
  assert.deepEqual(calls[0].args, [
    'C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    '--profile', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open',
  ]);
});

test('startDsh win32 + Electron 环境且 PATH 无 node.exe → 抛 code NODE_NOT_FOUND', () => {
  // 显式路径指向 .js（node 模式）且该 js 存在，但 PATH 里没有 node.exe：
  // Electron 环境绝不能拿 Code.exe 顶替，必须抛 NODE_NOT_FOUND
  const explicitJs = 'C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
  const runner = createProcessRunner(() => new FakeChild(), 'win32', 3000, (p) => p === explicitJs, {
    execPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    path: 'C:\\Windows\\System32',
    electronVersion: '39.2.0',
  });
  assert.throws(
    () => runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], executablePath: explicitJs }),
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
  const explicitJs = 'C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
  // 显式路径指向 bin.js（node 模式）→ 必须解析系统 node；只认该 js 与 PATH 里的 node.exe
  const runner = createProcessRunner(spawnImpl, 'win32', 3000, (p) => p === nodeExe || p === explicitJs, {
    execPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    path: 'C:\\Program Files\\nodejs',
    // 关键：不注入 electronVersion——模拟 versions.electron 检测意外失效，靠文件名兜底
  });
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], executablePath: explicitJs });
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
test('startDsh 默认追加 --no-open，openInBrowser=true 时不追加（v0.3.0）', () => {
  const calls: { args: string[] }[] = [];
  const spawnImpl: SpawnFn = (_cmd, args, _opts) => {
    calls.push({ args });
    return new FakeChild();
  };
  const runner = createProcessRunner(spawnImpl, 'linux');
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  assert.equal(calls[0].args.at(-1), '--no-open');
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], openInBrowser: true });
  assert.equal(calls[1].args.includes('--no-open'), false);
});


test('findInPathPosix：按 ":" 分隔查找，命中返回完整路径，未命中返回 null', () => {
  const fsSet = new Set(['/usr/local/bin/dsh', '/opt/node/bin/node']);
  const exists = (p: string) => fsSet.has(p);
  assert.equal(findInPathPosix('dsh', '/usr/bin:/usr/local/bin', exists), '/usr/local/bin/dsh');
  assert.equal(findInPathPosix('dsh', '/usr/bin:/opt/bin', exists), null);
  assert.equal(findInPathPosix('dsh', undefined, exists), null);
  // 空条目（PATH 首尾/连续分隔符产生）应跳过而不报错
  assert.equal(findInPathPosix('dsh', '::/usr/local/bin:', exists), '/usr/local/bin/dsh');
});

test('resolveDshPackageJsonPath：bin.js 直配 / 符号链接解析 / 向上查找 三种布局', () => {
  // ① 显式 executablePath 指向 bin.js
  const binJs = '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const pkg = '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json';
  const exists1 = (p: string) => p === pkg;
  assert.equal(resolveDshPackageJsonPath(binJs, 'linux', () => binJs, exists1), pkg);

  // ② npm 全局 shim 是符号链接 → realpath 指向 bin.js
  const shim = '/usr/local/bin/dsh';
  assert.equal(resolveDshPackageJsonPath(shim, 'linux', () => binJs, exists1), pkg);

  // ③ 无符号链接信息（realpath 抛错）→ 从 shim 目录向上找 node_modules
  const exists3 = (p: string) => p === '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json';
  assert.equal(
    resolveDshPackageJsonPath('/usr/local/bin/dsh', 'linux', () => { throw new Error('no link'); }, exists3),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  );

  // ④ 裸命令名/空串无法定位
  assert.equal(resolveDshPackageJsonPath('dsh', 'linux', () => '', () => true), null);
  assert.equal(resolveDshPackageJsonPath('', 'linux', () => '', () => true), null);

  // ⑤ 全部探测失败 → null（调用方按版本未知处理，不猜测）
  assert.equal(resolveDshPackageJsonPath('/usr/local/bin/dsh', 'linux', () => { throw new Error('x'); }, () => false), null);
});

// ——— issue #18：向 DSH 子进程注入额外环境变量 ———
test('startDsh 传 env：与父进程环境合并（父进程变量保留），而不是替换', () => {
  const calls: SpawnOptions[] = [];
  const spawnImpl: SpawnFn = (_cmd, _args, opts) => {
    calls.push(opts as SpawnOptions);
    return new FakeChild();
  };
  const runner = createProcessRunner(spawnImpl, 'linux');
  runner.startDsh({
    host: '127.0.0.1', port: 3080, extraArgs: [],
    env: { NODE_OPTIONS: '--use-env-proxy' },
  });
  const env = calls[0].env as Record<string, string> | undefined;
  assert.ok(env, '传了 env 时应给 spawn 提供 env');
  assert.equal(env.NODE_OPTIONS, '--use-env-proxy');
  // 父进程原有变量必须保留（生产里 process.env.PATH 尤其关键）
  assert.equal(env.PATH, process.env.PATH);
});

test('startDsh 未传 env 或传空对象：不给 spawn 提供 env 键（保持完全继承的既有行为）', () => {
  const calls: SpawnOptions[] = [];
  const spawnImpl: SpawnFn = (_cmd, _args, opts) => {
    calls.push(opts as SpawnOptions);
    return new FakeChild();
  };
  const runner = createProcessRunner(spawnImpl, 'linux');
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  assert.equal('env' in calls[0], false, '未配置时不应出现 env 键');
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], env: {} });
  assert.equal('env' in calls[1], false, '空对象等同未配置');
});

test('stopChild：cmd 模式的 Windows 子进程按进程树结束（taskkill /T），避免孤儿 dsh 占端口', async () => {
  const desktopCmd = 'C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
  const child = new FakeChild();
  const killed: number[] = [];
  const runner = createProcessRunner(
    (() => child) as SpawnFn, 'win32', 5, (p) => p === desktopCmd,
    { execPath: 'C:\\node\\node.exe', path: 'C:\\Windows', localAppData: 'C:\\Users\\u\\AppData\\Local' },
    (pid) => killed.push(pid),
  );
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  await runner.stopChild(child);
  assert.deepEqual(killed, [1234], 'cmd 外壳必须走 taskkill /T 结束整棵树');
  assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL'], '常规 kill 仍作为兜底执行');
});

test('stopChild：node 模式（npm 装法）不调用 taskkill，保持既有停止行为', async () => {
  const shim = 'C:\\npm-global\\dsh.cmd';
  const binJs = 'C:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
  const child = new FakeChild();
  const killed: number[] = [];
  const runner = createProcessRunner(
    (() => child) as SpawnFn, 'win32', 5,
    (p) => p === shim || p === binJs || p === 'C:\\npm-global\\node.exe',
    { execPath: 'C:\\node\\node.exe', path: 'C:\\npm-global' },
    (pid) => killed.push(pid),
  );
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  await runner.stopChild(child);
  assert.deepEqual(killed, [], 'node 直跑模式没有 cmd 外壳，不需要 taskkill');
  assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL']);
});
