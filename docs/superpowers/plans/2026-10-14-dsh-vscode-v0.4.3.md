# v0.4.3 实现计划：整合 PR #35 并修复 #30–#33

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows 上 npm 装法与 DSH Desktop 装法都能正确启动 DSH（#30/#31），让面板能打开二进制交付物（#33），让相对路径按会话 cwd 解析（#32），并修掉 PR #35 引入的握手时序与卸载钩子符号链接两个隐患。

**Architecture:** 新增纯函数模块 `src/service/launcher.ts` 作为「执行入口」的单一裁决点：按 `显式路径 → 首选来源 → 回退来源 → 平台默认探测` 的固定顺序产出 `LaunchResolution`；`src/service/process.ts` 只负责按裁决结果 spawn（`node bin.js` 或 `cmd.exe /c script.cmd`）。裁决逻辑全部依赖注入（platform/env/exists），因此可在 Linux 上单测 Windows 分支。

**Tech Stack:** TypeScript、VS Code Extension API、Node `node:test` + `t.mock`、`esbuild`（`scripts/build.mjs` 构建 `out/`）、`vsce` 打包。

**Spec:** `docs/superpowers/specs/2026-10-14-dsh-vscode-v0.4.3-design.md`

## Global Constraints

- 开发期版本号 `0.4.3-test1`、`0.4.3-test2`……；正式版 `0.4.3` 仅在用户真机验收通过且明确同意后发布。
- `package.json` 的 `version` 与 `bridge-client/package.json` 的 `version` 必须始终一致（`test/package.test.ts` 守卫），`bridge-client/lib/client.js` 的 `BRIDGE_VERSION` 同步。
- 本 agent 编写或修改的代码必须带**中文注释**，解释「为什么」而非复述代码；改动他人代码时只为自己新增/修改的部分加注释。
- 提交身份：`Fengze233 <ni125803@163.com>`；禁止添加 `Co-authored-by:` 等署名 trailer（PR #35 的 merge 提交已保留原作者身份，不额外署名）。
- 每个任务结束前必须实际运行并在报告里贴出：`npm run typecheck`、`npm test`（必要时 `npm run compile`）。
- 不修改 `src/service/process.ts` 中 POSIX 分支的既有行为（仍 `spawn('dsh')` 或显式路径）。
- 不引入新的运行时依赖（卸载钩子 `src/uninstall.ts` 只能用 Node 内建 API）。
- 安全边界：`cmd` 模式只接受绝对路径；不接受相对路径或未校验拼接。

## Review Focus

- **`dsh.executablePath` 指向 `.cmd`/包装脚本时**：必须直接执行该脚本而不是推导 bin.js，也不得报「端口占用」——这是 #30 用户的实际配置方式，最容易被实现成「仍然推导」。
- **npm 装法且 bin.js 不存在时**：必须判定 npm 不可用并回退桌面端，而不是拼一个不存在的路径去 spawn（现有代码正是如此，是本版要修的核心）。
- **首选来源不存在但另一种存在**：必须自动回退且日志写明实际来源；用户不会去看日志，但排查依赖它。
- **切换 host/port/profile 后**：桥接不得显示「已握手」而实际未握手（PR #35 隐患 1）。
- **`$DSH_HOME/profiles` 下存在符号链接或非目录项时**：卸载钩子不得写入 `$DSH_HOME` 之外的任何文件（PR #35 隐患 2）。
- **会话 cwd 取不到时**（DSH 页面结构变化、会话未就绪）：点击文件不得变成「无反应」，至少退回工作区根并写日志。

---

### Task 1: 新增 `launcher.ts` 的裁决核心（显式路径 + 首选 + 回退）

**Files:**
- Create: `src/service/launcher.ts`
- Test: `test/launcher.test.ts`

**Interfaces:**
- Consumes: 无（本任务自包含，仅依赖 `node:path` 的 `win32`/`posix` 与注入的 `exists`）。
- Produces:
  - `type LaunchPreference = 'auto' | 'npm' | 'desktop'`
  - `type LaunchSource = 'explicit' | 'npm' | 'desktop'`
  - `type LaunchMode = 'node' | 'cmd'`
  - `interface LaunchResolution { source: LaunchSource; mode: LaunchMode; executablePath: string; argsPrefix: string[]; fellBack: boolean; reason: string; candidateLog: string[] }`
  - `interface LaunchInput { platform: string; env: { path?: string; localAppData?: string }; exists: (p: string) => boolean; preference?: string; desktopCommandPath?: string; explicitPath?: string }`
  - `function binJsFromShim(dshCmdPath: string): string`
  - `function findNpmShim(pathEnv: string | undefined, exists: (p: string) => boolean): string | null`
  - `function resolveLaunch(input: LaunchInput): LaunchResolution | null`

- [ ] **Step 1: 写失败测试**

新建 `test/launcher.test.ts`：

```ts
// test/launcher.test.ts — 执行入口裁决的单元测试（全部依赖注入，可在 Linux 上覆盖 Windows 分支）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binJsFromShim, resolveLaunch, type LaunchInput } from '../src/service/launcher';

/** 构造一份「文件系统里存在这些路径」的 exists 实现 */
function existsOf(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

const NPM_SHIM = 'C:\\Users\\u\\AppData\\Roaming\\npm\\dsh.cmd';
const NPM_BINJS = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const DESKTOP_CMD = 'C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';

function baseInput(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    platform: 'win32',
    env: { path: 'C:\\Windows;C:\\Users\\u\\AppData\\Roaming\\npm', localAppData: 'C:\\Users\\u\\AppData\\Local' },
    exists: () => false,
    ...over,
  };
}

test('binJsFromShim 由 shim 目录推导 npm 布局的 bin.js 路径', () => {
  assert.equal(binJsFromShim(NPM_SHIM), NPM_BINJS);
});

test('显式路径：以 .js 结尾走 node 直跑', () => {
  const r = resolveLaunch(baseInput({ explicitPath: 'D:\\tools\\bin.js', exists: existsOf('D:\\tools\\bin.js') }));
  assert.ok(r);
  assert.equal(r.source, 'explicit');
  assert.equal(r.mode, 'node');
  assert.deepEqual(r.argsPrefix, ['D:\\tools\\bin.js']);
  assert.equal(r.fellBack, false);
});

test('显式路径：.cmd 走 cmd 执行，不再推导 bin.js（issue #30 的配置方式）', () => {
  const r = resolveLaunch(baseInput({ explicitPath: DESKTOP_CMD, exists: existsOf(DESKTOP_CMD) }));
  assert.ok(r);
  assert.equal(r.source, 'explicit');
  assert.equal(r.mode, 'cmd');
  assert.equal(r.executablePath, DESKTOP_CMD);
  assert.deepEqual(r.argsPrefix, ['/d', '/s', '/c', DESKTOP_CMD]);
});

test('显式路径存在性校验失败时不作为候选，继续走首选', () => {
  const r = resolveLaunch(baseInput({
    explicitPath: 'D:\\gone\\dsh.cmd',
    preference: 'npm',
    exists: existsOf(NPM_SHIM, NPM_BINJS),
  }));
  assert.ok(r);
  assert.equal(r.source, 'npm');
  assert.ok(r.candidateLog.some((line) => line.includes('explicit')));
});

test('npm 可行：PATH 命中 dsh.cmd 且 bin.js 真实存在', () => {
  const r = resolveLaunch(baseInput({ preference: 'auto', exists: existsOf(NPM_SHIM, NPM_BINJS) }));
  assert.ok(r);
  assert.equal(r.source, 'npm');
  assert.equal(r.mode, 'node');
  assert.deepEqual(r.argsPrefix, [NPM_BINJS]);
  assert.equal(r.fellBack, false);
});

test('npm 不可行：bin.js 不存在时必须判定 npm 不可用（issue #30 核心）', () => {
  const r = resolveLaunch(baseInput({ preference: 'npm', exists: existsOf(NPM_SHIM, DESKTOP_CMD) }));
  assert.ok(r);
  assert.equal(r.source, 'desktop');
  assert.equal(r.fellBack, true);
  assert.ok(r.reason.includes('npm'));
  assert.ok(r.candidateLog.some((line) => line.includes('bin.js')));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --test-name-pattern="launcher"`（若脚本不支持参数，则先 `npm run compile` 再 `node --test "out/test/launcher.test.js"`）
Expected: FAIL —— `Cannot find module '../src/service/launcher'`

- [ ] **Step 3: 写最小实现**

新建 `src/service/launcher.ts`：

```ts
// src/service/launcher.ts — DSH 执行入口的单一裁决点
// 职责：在「用户显式路径 / npm 全局安装 / DSH Desktop 安装」三种来源里挑出一个可执行入口，
// 并给出该用哪种执行方式（node 直跑 js，还是 cmd.exe 执行脚本）。
// 为什么需要独立模块：Windows 上 .cmd 不能被 Node 直接 spawn（v22+ 抛 EINVAL），
// 而两种装法的真实入口布局完全不同——把判定集中在此，才能对每条分支写真测试。
// 纯模块：平台/环境/文件系统全部注入，不依赖 vscode 与 process 全局。
import { win32 as win32Path } from 'node:path';

/** 首选来源：auto = npm 优先，没有再桌面端 */
export type LaunchPreference = 'auto' | 'npm' | 'desktop';
/** 实际采用的来源 */
export type LaunchSource = 'explicit' | 'npm' | 'desktop';
/** 执行方式：node = node 直跑 .js；cmd = cmd.exe 执行 .cmd/包装脚本 */
export type LaunchMode = 'node' | 'cmd';

/** 裁决结果 */
export interface LaunchResolution {
  source: LaunchSource;
  mode: LaunchMode;
  /** node 模式：入口 js 绝对路径；cmd 模式：脚本绝对路径 */
  executablePath: string;
  /** 拼在业务参数之前的参数前缀（node 模式 [js]；cmd 模式 ['/d','/s','/c', script]） */
  argsPrefix: string[];
  /** true = 采用的不是首选来源（供日志与提示使用） */
  fellBack: boolean;
  /** 人类可读的裁决理由（英文短句，进日志） */
  reason: string;
  /** 依次尝试过的候选与失败原因（启动失败或降级时输出，便于远程排查） */
  candidateLog: string[];
}

/** 裁决输入（全部注入，便于单测与跨平台覆盖 Windows 分支） */
export interface LaunchInput {
  platform: string;
  env: { path?: string; localAppData?: string };
  exists: (p: string) => boolean;
  /** dsh.launchPreference 的原始值（可能非法） */
  preference?: string;
  /** dsh.desktopCommandPath 的原始值（空串 = 自动探测） */
  desktopCommandPath?: string;
  /** dsh.executablePath 的原始值（空串 = 未配置） */
  explicitPath?: string;
}

/** 由 dsh.cmd 的绝对路径推导 npm shim 的真实入口 bin.js 路径（Windows 路径语义） */
export function binJsFromShim(dshCmdPath: string): string {
  return win32Path.join(win32Path.dirname(dshCmdPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/** 用 Windows 查找语义在 PATH 里找固定文件名（注意盘符含冒号，不能用 ':' 拆分） */
export function findInPathWin(
  target: string,
  envPath: string | undefined,
  exists: (p: string) => boolean,
): string | null {
  if (envPath === undefined) return null;
  for (const dir of envPath.split(';')) {
    if (dir === '') continue;
    const candidate = win32Path.join(dir, target);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Desktop 装法的默认命令位置：%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd */
export function desktopDefaultCommand(localAppData: string | undefined): string | null {
  if (localAppData === undefined || localAppData === '') return null;
  return win32Path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
}

/** 校验 preference：非法值回退 auto */
function normalizePreference(raw: string | undefined): LaunchPreference {
  return raw === 'npm' || raw === 'desktop' ? raw : 'auto';
}

/** 绝对路径校验（Windows 语义，与运行平台无关） */
function isAbsoluteWin(p: string): boolean {
  return win32Path.isAbsolute(p);
}

/**
 * 裁决执行入口。返回 null 表示三种来源都不可用（调用方据此报「未找到 dsh」）。
 */
export function resolveLaunch(input: LaunchInput): LaunchResolution | null {
  const log: string[] = [];
  const { platform, env, exists } = input;
  const preference = normalizePreference(input.preference);
  const isWin = platform === 'win32';

  // 1) 显式路径优先级最高：用户已经指名道姓，不再推导、不再猜测
  const explicit = input.explicitPath !== undefined && input.explicitPath !== '' ? input.explicitPath : null;
  if (explicit !== null) {
    if (!isWin) {
      // 非 Windows：显式路径直接作为命令使用（保持既有行为）
      return {
        source: 'explicit', mode: 'node', executablePath: explicit, argsPrefix: [],
        fellBack: false, reason: 'explicit executablePath (posix)', candidateLog: log,
      };
    }
    if (exists(explicit)) {
      return explicit.endsWith('.js')
        ? {
            source: 'explicit', mode: 'node', executablePath: explicit, argsPrefix: [explicit],
            fellBack: false, reason: 'explicit bin.js', candidateLog: log,
          }
        : {
            source: 'explicit', mode: 'cmd', executablePath: explicit,
            argsPrefix: ['/d', '/s', '/c', explicit],
            fellBack: false, reason: 'explicit script (no bin.js derivation)', candidateLog: log,
          };
    }
    log.push(`explicit: ${explicit} not found`);
  }

  // 2) 两个来源各自的可用性判定（都做完整判定，便于回退与日志）
  const npmShim = isWin ? findInPathWin('dsh.cmd', env.path, exists) : null;
  const npmBinJs = npmShim === null ? null : binJsFromShim(npmShim);
  // 关键：推导出的 bin.js 必须真实存在才算 npm 可用（issue #30 的根因就在这里）
  const npmOk = npmShim !== null && npmBinJs !== null && exists(npmBinJs);
  if (npmShim !== null && !npmOk) log.push(`npm: ${npmShim} found but bin.js missing at ${npmBinJs}`);

  const desktopConfigured = input.desktopCommandPath !== undefined && input.desktopCommandPath !== ''
    ? input.desktopCommandPath
    : null;
  const desktopDefault = isWin ? desktopDefaultCommand(env.localAppData) : null;
  const desktopCmd = desktopConfigured !== null && exists(desktopConfigured)
    ? desktopConfigured
    : desktopDefault !== null && exists(desktopDefault) ? desktopDefault : null;
  if (desktopConfigured !== null && desktopCmd !== desktopConfigured) {
    // 设置里填了路径但不存在：不弹错，退回自动探测并留痕（设计 D2）
    log.push(`desktop: configured ${desktopConfigured} not found, falling back to default probe`);
  }
  if (desktopCmd === null && desktopDefault !== null) log.push(`desktop: not found at ${desktopDefault}`);

  const makeNpm = (fellBack: boolean): LaunchResolution => ({
    source: 'npm', mode: 'node', executablePath: npmBinJs as string, argsPrefix: [npmBinJs as string],
    fellBack, reason: fellBack ? 'npm (preferred desktop unavailable)' : 'npm', candidateLog: log,
  });
  const makeDesktop = (fellBack: boolean): LaunchResolution => ({
    source: 'desktop', mode: 'cmd', executablePath: desktopCmd as string,
    argsPrefix: ['/d', '/s', '/c', desktopCmd as string],
    fellBack, reason: fellBack ? 'desktop (preferred npm unavailable)' : 'desktop', candidateLog: log,
  });

  // 3) 首选来源：auto 视为先 npm（与用户确认的规则一致）
  if (preference !== 'desktop' && npmOk) return makeNpm(false);
  if (preference === 'desktop' && desktopCmd !== null) return makeDesktop(false);

  // 4) 回退到另一种来源（用户确认：自动回退并在日志写明实际来源）
  if (npmOk) return makeNpm(true);
  if (desktopCmd !== null) return makeDesktop(true);

  // 5) 都不可用
  return null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 新增用例全部 PASS；既有用例不回归

- [ ] **Step 5: 提交**

```bash
git add src/service/launcher.ts test/launcher.test.ts
git commit -m "feat(launcher): 新增执行入口裁决模块（npm/desktop/显式路径 + 自动回退）"
```

---

### Task 2: `process.ts` 消费裁决结果（修 #30/#31 的启动链路）

**Files:**
- Modify: `src/service/process.ts`（`StartOptions` 增字段；`createProcessRunner` 的 Windows 分支；`binJsFromShim` 改为转发到 launcher；`lastStart` 增 `source`）
- Modify: `test/process.test.ts`（Windows 用例改为真正校验 bin.js 存在性，并新增 cmd 模式用例）
- Modify: `test/vscode-stub.ts`（仅当类型检查需要时）

**Interfaces:**
- Consumes: Task 1 的 `resolveLaunch`、`binJsFromShim`、`LaunchResolution`。
- Produces: `StartOptions` 新增 `launchPreference?: string`、`desktopCommandPath?: string`；`ProcessRunner.lastStart` 变为 `{ command: string; args: string[]; source?: LaunchSource } | null`。

- [ ] **Step 1: 写失败测试**

在 `test/process.test.ts` 的 Windows 用例之后新增：

```ts
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
```

同时把既有「Windows：注入 PATH 命中 dsh.cmd 后以 node 直跑 bin.js」用例的 `exists` 注入改为**只认 shim 与 bin.js 两个路径**，让「存在性校验」真正生效：

```ts
    const shim = 'C:\\npm-global\\dsh.cmd';
    const binJs = 'C:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
    const runner = createProcessRunner(spawnImpl, 'win32', 3000, (p) => p === shim || p === binJs || p === 'C:\\npm-global\\node.exe', {
      execPath: 'C:\\node\\node.exe',
      path: 'C:\\npm-global',
    });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: 新用例 FAIL（`cmd.exe` 未出现 / `RunnerEnv` 无 `localAppData` 导致类型错误）

- [ ] **Step 3: 实现**

改动 `src/service/process.ts`：

1. `RunnerEnv` 增加 `localAppData?: string`（生产默认 `process.env.LOCALAPPDATA`）。
2. `StartOptions` 增加 `launchPreference?: string`、`desktopCommandPath?: string`。
3. `binJsFromShim` 的实现改为 `export { binJsFromShim } from './launcher';`（保持既有导出与测试不变），本文件内的推导逻辑删除。
4. Windows 分支改为：

```ts
      if (platform === 'win32') {
        // Windows：.cmd 不能被 Node 直接 spawn（v22+ 抛 EINVAL），
        // 由 launcher 裁决「node 直跑 bin.js」还是「cmd.exe 执行脚本」。
        const resolution = resolveLaunch({
          platform,
          env: { path: env.path ?? process.env.PATH ?? '', localAppData: env.localAppData ?? process.env.LOCALAPPDATA },
          exists: existsImpl,
          preference: launchPreference,
          desktopCommandPath,
          explicitPath: executablePath,
        });
        if (resolution === null) {
          // 两种装法都不可用：保持「未找到 dsh」语义（manager 的 ENOENT 分支照常工作）
          throw Object.assign(new Error('dsh not found (npm dsh.cmd and DSH Desktop command both unavailable)'), { code: 'ENOENT' });
        }
        command = resolution.mode === 'node'
          ? resolveWindowsNodeExecutable(resolution.executablePath, env, existsImpl)
          : 'cmd.exe';
        spawnArgs = [...resolution.argsPrefix, ...webArgs];
        resolutionUsed = resolution;
        child = spawnImpl(command, spawnArgs, spawnOptions);
      }
```

5. `lastStart` 记录 `source: resolutionUsed?.source`，供 manager 写日志。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run typecheck && npm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/service/process.ts test/process.test.ts
git commit -m "fix(#30,#31): Windows 按 launcher 裁决启动，bin.js 不存在时降级执行 .cmd"
```

---

### Task 3: 配置项 `dsh.launchPreference` 与 `dsh.desktopCommandPath`

**Files:**
- Modify: `src/config.ts`（`RawDshConfig`、`DshConfig`、`DEFAULTS`、`normalizeConfig`、`readConfig`）
- Modify: `package.json`（两个设置项）、`package.nls.json`、`package.nls.zh-cn.json`、`package.nls.zh-hans.json`
- Modify: `src/extension.ts`（`toManagerOptions` 透传）、`src/service/manager.ts`（`ManagerOptions` 透传）
- Test: `test/config.test.ts`、`test/package.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LaunchPreference` 类型。
- Produces: `DshConfig.launchPreference: LaunchPreference`（默认 `'auto'`）、`DshConfig.desktopCommandPath: string`（默认 `''`）；`ManagerOptions` 同名可选字段。

- [ ] **Step 1: 写失败测试**

`test/config.test.ts` 新增：

```ts
test('launchPreference：默认 auto，非法值回退 auto 并记错误', () => {
  assert.equal(normalizeConfig({}).config.launchPreference, 'auto');
  assert.equal(normalizeConfig({ launchPreference: 'desktop' }).config.launchPreference, 'desktop');
  const bad = normalizeConfig({ launchPreference: 'nope' });
  assert.equal(bad.config.launchPreference, 'auto');
  assert.ok(bad.errors.some((e) => e.includes('dsh.launchPreference')));
});

test('desktopCommandPath：默认空串；非字符串静默回退；相对路径记错误并视为空', () => {
  assert.equal(normalizeConfig({}).config.desktopCommandPath, '');
  assert.equal(normalizeConfig({ desktopCommandPath: 'C:\\x\\dsh.cmd' }).config.desktopCommandPath, 'C:\\x\\dsh.cmd');
  assert.equal(normalizeConfig({ desktopCommandPath: 42 as never }).config.desktopCommandPath, '');
  const rel = normalizeConfig({ desktopCommandPath: 'tools\\dsh.cmd' });
  assert.equal(rel.config.desktopCommandPath, '');
  assert.ok(rel.errors.some((e) => e.includes('dsh.desktopCommandPath')));
});
```

`test/package.test.ts` 的设置项用例追加断言：

```ts
  assert.equal(props['dsh.launchPreference'].default, 'auto');
  assert.deepEqual(props['dsh.launchPreference'].enum, ['auto', 'npm', 'desktop']);
  assert.equal(props['dsh.launchPreference'].markdownDescription, '%dsh.config.launchPreference%');
  assert.equal(props['dsh.desktopCommandPath'].default, '');
  assert.equal(props['dsh.desktopCommandPath'].markdownDescription, '%dsh.config.desktopCommandPath%');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `props['dsh.launchPreference']` 为 undefined

- [ ] **Step 3: 实现**

- `src/config.ts`：`RawDshConfig`/`DshConfig` 加两个字段；`DEFAULTS` 加 `launchPreference: 'auto'`、`desktopCommandPath: ''`；`normalizeConfig` 里按既有「非法值记错误并回退默认」模式处理（`launchPreference` 只接受三个枚举值；`desktopCommandPath` 非字符串静默回退，字符串但非绝对路径 → 记错误并视为空串）；`readConfig` 读 `launchPreference` 与 `desktopCommandPath`。
- `package.json` 的 `contributes.configuration.properties` 加：

```jsonc
"dsh.launchPreference": {
  "type": "string",
  "enum": ["auto", "npm", "desktop"],
  "default": "auto",
  "markdownDescription": "%dsh.config.launchPreference%"
},
"dsh.desktopCommandPath": {
  "type": "string",
  "default": "",
  "markdownDescription": "%dsh.config.desktopCommandPath%"
}
```

- 三个 nls 文件各加两条文案（英文/简体/简体），英文示例：

```json
"dsh.config.launchPreference": "Which `dsh` installation to prefer: `auto` (npm first, then DSH Desktop), `npm`, or `desktop`. Missing preferred installs fall back to the other one automatically; the log records which source was actually used.",
"dsh.config.desktopCommandPath": "Absolute path of the DSH Desktop command (`...\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd`). Leave empty to detect the default location automatically. Invalid paths are ignored and fall back to auto-detection.",
```

- `src/extension.ts` 的 `toManagerOptions` 与 `src/service/manager.ts` 的 `ManagerOptions`/`startDsh` 调用透传这两个字段。
- `src/extension.ts` 的环境信息头（`=== DSH 扩展环境信息 ===` 那段 `appendLog`）追加五行，供问题报告直接核对来源（spec 5.2）：

```ts
  appendLog(`dsh 启动来源: ${lastLaunchSource ?? '未启动'}`);
  appendLog(`dsh 实际入口: ${lastLaunchPath ?? '未定位'}`);
  appendLog(`dsh.launchPreference: ${config.launchPreference}`);
  appendLog(`dsh.desktopCommandPath: ${config.desktopCommandPath === '' ? '(空，自动探测)' : config.desktopCommandPath}`);
  appendLog(`dsh.profile: ${config.profile}`);
```

其中 `lastLaunchSource`/`lastLaunchPath` 取自 `manager` 最近一次启动的实际结果（Task 2 已让 `lastStart` 携带 `source`），未启动时分别打印 `未启动`/`未定位`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run typecheck && npm test`
Expected: 全绿（含 `test/l10n.test.ts` 的中英一致性守卫）

- [ ] **Step 5: 提交**

```bash
git add src/config.ts src/extension.ts src/service/manager.ts package.json package.nls.json package.nls.zh-cn.json package.nls.zh-hans.json test/config.test.ts test/package.test.ts
git commit -m "feat(config): 新增 dsh.launchPreference 与 dsh.desktopCommandPath"
```

---

### Task 4: #33 —— 用 `vscode.open` 打开交付物（图片/PDF/未知二进制）

**Files:**
- Modify: `src/panel/provider.ts`（`bridgeDeps()` 的 `openTextDocument` 实现，约 176-182 行）
- Modify: `test/panel/provider.test.ts`
- Modify: `test/vscode-stub.ts`（`window.showTextDocument` 保留；`commands.executeCommand` 已存在，无需新增）

**Interfaces:**
- Consumes: 既有的 `handleBridgeMessage` 依赖契约 `openTextDocument(path: string): Thenable<void>`（不改签名，避免动 host 层与既有测试）。
- Produces: 依赖实现改为调用 `vscode.commands.executeCommand('vscode.open', Uri.file(path), { preview: false })`。

- [ ] **Step 1: 写失败测试**

在 `test/panel/provider.test.ts` 末尾新增：

```ts
test('bridgeOpenFile 用 vscode.open 打开（支持图片/PDF 等二进制），而不调用 showTextDocument', async (t) => {
  const opened: unknown[][] = [];
  const shownText: string[] = [];
  t.mock.method(vscodeStub.commands, 'executeCommand', async (...args: unknown[]) => {
    opened.push(args);
    return undefined;
  });
  t.mock.method(vscodeStub.window, 'showTextDocument', async () => {
    shownText.push('called');
    return undefined;
  });

  // 直接构造与 provider 相同形状的依赖，断言「依赖内部用的是 vscode.open」
  const deps = {
    openExternal: async () => true,
    openTextDocument: async (p: string) => {
      await vscodeStub.commands.executeCommand('vscode.open', vscodeStub.Uri.file(p), { preview: false });
    },
    showWarning: () => {},
    workspaceRoot: '/ws',
  };
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: '/ws/a.png' } as never, deps as never);
  assert.deepEqual(opened[0], ['vscode.open', { fsPath: '/ws/a.png' }, { preview: false }]);
  assert.equal(shownText.length, 0, '不应再用 showTextDocument');
});
```

> 说明：本用例锁定的是「打开方式」这一契约；provider 的私有 `bridgeDeps()` 由 `test/extension.test.ts` 的激活路径间接覆盖。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `opened[0]` 为 undefined（依赖里仍是 showTextDocument）

- [ ] **Step 3: 实现**

`src/panel/provider.ts` 的 `bridgeDeps()` 内替换为：

```ts
      openTextDocument: async (p) => {
        // 用 vscode.open 而不是 window.showTextDocument：后者只能开文本编辑器，
        // 点图片/PDF 会抛「File seems to be binary and cannot be opened as text」（issue #33）。
        // vscode.open 由 VS Code 自选编辑器：文本→文本编辑器、图片→图片预览、PDF→内建 PDF 预览、
        // 未知二进制→占位页（提示而非报错）。
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p), { preview: false });
      },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run typecheck && npm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/panel/provider.ts test/panel/provider.test.ts
git commit -m "fix(#33): 交付物改用 vscode.open 打开，支持图片/PDF/未知二进制"
```

---

### Task 5: #32 —— 桥接携带会话 cwd（含一次限时调查，失败即上报）

**Files:**
- Modify: `bridge-client/lib/client.js`（`bindLinkInterception` 内的 `parent.postMessage(buildOpenFileMessage(path), "*")`）
- Modify: `bridge-client/lib/core.js`（若需要新增取 cwd 的纯逻辑与单测）
- Test: `test/bridge/core.test.ts`、`test/bridge/client-build.test.ts`

**Interfaces:**
- Consumes: `buildOpenFileMessage(path, cwd)`（已存在，第二参可选）。
- Produces: 转发 `openFile` 时携带 `cwd`（拿不到则省略）。

> **先做 Step 0 的调查，不要直接写实现。** 桥接 bundle 的 factory 只有 `require`，文件里目前没有 `ctx`（`grep -n "ctx\b" bridge-client/lib/client.js` 为空）。DSH 页面把会话 cwd 暴露在哪条通道需要先查清：可能是 `require('@deepseek-ai/dsh-…')` 可取到会话列表，也可能是页面内可见的 RPC 响应（本 bundle 已包裹 `window.fetch`，那里能看到 `session.prompt` 等方法名与 `payload.sessionId`）。
> 产出：把「能否拿到 cwd、通过哪条通道、拿到的是什么字段」写成三行结论贴进对话。**若 15 分钟内查不出稳定可用的通道：停止本任务，如实上报「拿不到 cwd」，并请用户决定**（选项：先做「宿主侧绝对路径兜底 + 明确日志」/ 改为请 DSH 侧在 title 里渲染绝对路径 / 本版先不修 #32）。**不得**凭猜测写入未经证实的取法。

- [ ] **Step 0: 调查并上报通道（见上）**

- [ ] **Step 1: 写失败测试**（在 Step 0 得到确定通道后）

`test/bridge/core.test.ts` 新增纯逻辑用例：

```ts
test('resolveSessionCwd：从会话快照安全取 cwd，取不到返回 undefined', () => {
  assert.equal(resolveSessionCwd({ sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: '/proj' } } }) } } }, 's1'), '/proj');
  assert.equal(resolveSessionCwd({ sessions: { list: { getSnapshot: () => ({ byId: {} }) } } }, 's1'), undefined);
  assert.equal(resolveSessionCwd(undefined, 's1'), undefined);
  assert.equal(resolveSessionCwd({ sessions: {} } as never, ''), undefined);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `resolveSessionCwd is not a function`

- [ ] **Step 3: 实现**

`bridge-client/lib/core.js` 新增防御式取值（任何一层缺失都返回 undefined，绝不抛错）：

```js
// 从 DSH 会话上下文安全取当前会话的工作目录。
// 防御式实现：DSH 页面内部结构可能随版本变化，任何一层缺失都返回 undefined，
// 由调用方退回「不带 cwd」的旧行为（不能用 try/catch 兜住一个不存在的 API 路径拼接）。
export function resolveSessionCwd(ctx, sessionId) {
  if (!ctx || typeof sessionId !== "string" || sessionId === "") return undefined;
  const byId = ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.getSnapshot === "function"
    ? ctx.sessions.list.getSnapshot().byId
    : undefined;
  const cwd = byId && byId[sessionId] ? byId[sessionId].cwd : undefined;
  return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}
```

`bridge-client/lib/client.js` 的转发处改为：

```js
            const cwd = resolveSessionCwd(getDshContext(), lastSeenSessionId);
            if (cwd === undefined) {
              console.log("[dsh-vscode-bridge] openFile without session cwd; host falls back to workspace root");
            }
            parent.postMessage(buildOpenFileMessage(path, cwd), "*");
```

其中 `getDshContext()` 按 Step 0 查到的通道实现；拿不到时返回 `undefined`。**取不到 cwd 时必须照常发送消息**（不得丢弃点击）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run compile && npm test`
Expected: 全绿；`test/bridge/client-build.test.ts` 的内联产物校验通过

- [ ] **Step 5: 提交**

```bash
git add bridge-client/lib/client.js bridge-client/lib/core.js test/bridge/core.test.ts
git commit -m "fix(#32): 桥接转发文件时携带会话 cwd，取不到时不阻塞点击"
```

---

### Task 6: PR #35 隐患 1 —— 握手时序（host/port/profile 变化都要清握手）

**Files:**
- Modify: `src/extension.ts`（`onDidChangeConfiguration` 内的 `dsh.profile` 分支）
- Modify: `test/extension.test.ts`

**Interfaces:**
- Consumes: `readConfig()`（返回 `{ config, errors }`）、`manager.getSnapshot()`、`ServiceSnapshot`。
- Produces: 无新导出；行为约束「目标变化 + 非（就绪且非自启）→ 清握手」。

- [ ] **Step 1: 写失败测试**

在 `test/extension.test.ts` 现有用例之后新增一个独立用例：

```ts
test('端口+profile 同时变更且新端口已有外部服务时，握手不得被旧结果保留', async (t) => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-handshake-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const settings: Record<string, unknown> = { profile: 'web', port: 3080 };
    const logs: string[] = [];
    let handler: ((event: ConfigurationChangeEvent) => void) | undefined;
    const snapshot: ServiceSnapshot = { state: 'ready', url: 'http://127.0.0.1:3080/', error: null, owned: false };
    const providers = new Map<string, WebviewViewProvider>();
    t.mock.method(vscodeStub.workspace, 'getConfiguration', () => ({ get: (k: string) => settings[k] }));
    t.mock.method(vscodeStub.workspace, 'onDidChangeConfiguration', (cb: typeof handler) => {
      handler = cb;
      return { dispose: () => {} };
    });
    t.mock.method(vscodeStub.window, 'createOutputChannel', () => ({
      appendLine: (line: string) => logs.push(line), dispose: () => {},
    }));
    t.mock.method(vscodeStub.window, 'registerWebviewViewProvider', (id: string, p: WebviewViewProvider) => {
      providers.set(id, p);
      return { dispose: () => {} };
    });
    t.mock.method(ServiceManager.prototype, 'getSnapshot', () => snapshot);
    const context = {
      subscriptions: [] as { dispose(): void }[],
      extension: { packageJSON: { version: 'test' } },
      globalState: { get: () => undefined, update: async () => {} },
    };
    activate(context as never);
    const panel = providers.get('dsh.panel.secondary')!;
    Reflect.get(panel, 'onBridgeAck')(true); // 旧目标握手成功
    // 端口与 profile 同时改：目标变了，旧握手不得沿用
    settings.port = 3081;
    settings.profile = 'custom-profile';
    handler!({ affectsConfiguration: (k: string) => k === 'dsh' } as ConfigurationChangeEvent);
    Reflect.get(panel, 'onFirstOpen')();
    t.mock.timers.tick(60000);
    assert.ok(logs.some((line) => line.includes('[bridge] handshake timeout')),
      '目标变化后必须等新握手，不能被旧的 handshakeOk 短路');
  } finally {
    await deactivate();
    for (const s of [t.mock]) void s;
    t.mock.restoreAll();
    t.mock.timers.reset();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    rmSync(dshHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— 断言 `handshake timeout` 未出现（旧 `handshakeOk=true` 被保留）

- [ ] **Step 3: 实现**

`src/extension.ts` 中把 profile 分支与 host/port 变化统一处理：

```ts
    vscode.workspace.onDidChangeConfiguration((e) => {
      // 目标变化（profile / host / port 任一）都必须作废旧握手：
      // 快照在这里反映的仍是 reconfigure 之前的目标，只有「就绪的外部服务」才继续复用会话。
      const targetChanged = e.affectsConfiguration('dsh.profile') ||
        e.affectsConfiguration('dsh.host') || e.affectsConfiguration('dsh.port');
      if (targetChanged) {
        const next = readConfig().config;
        if (installOpts.profile !== next.profile) {
          installOpts.profile = next.profile;
          install = next.bridgeEnabled ? safeInstallBridge() : null;
        }
        const snapshot = manager?.getSnapshot();
        const reuseExternal = snapshot?.state === 'ready' && !snapshot.owned;
        if (!reuseExternal) {
          clearHandshakeTimer();
          handshakeOk = undefined;
        }
      }
      if (e.affectsConfiguration('dsh')) onConfigChanged();
    }),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run typecheck && npm test`
Expected: 全绿（含既有 profile 用例）

- [ ] **Step 5: 提交**

```bash
git add src/extension.ts test/extension.test.ts
git commit -m "fix(bridge): 目标变化（profile/host/port）时作废旧握手结果"
```

---

### Task 7: PR #35 隐患 2 —— 卸载钩子符号链接防护

**Files:**
- Modify: `src/uninstall.ts`
- Modify: `test/bridge/installer.test.ts`（或新增 `test/uninstall.test.ts`，视现有测试组织而定）
- Modify: `src/bridge/installer.ts`（仅在需要导出校验函数时）

**Interfaces:**
- Consumes: `PROFILE_NAME_PATTERN`（`src/config.ts` 导出，但 `uninstall.ts` 不能 import vscode —— 因此把正则复制为 `src/bridge/profile-name.ts` 的常量，或从 `installer.ts` 再导出；实现时择一并保持 `test/package.test.ts` 的正则一致性断言通过）。
- Produces: `uninstallBridge` 仅在「名字合法 + 非符号链接 + realpath 落在 profiles 目录内」时改写该 profile 的 `cordis.patch.yml`。

- [ ] **Step 1: 写失败测试**

```ts
test('卸载钩子不使用符号链接 profile：外部 cordis.patch.yml 不被改写', () => {
  // profiles/linked -> /outside （符号链接指向 $DSH_HOME 之外）
  // 期待：/outside/cordis.patch.yml 内容保持原样，且不抛错
  const patch = '# 用户内容\n- id: dsh-vscode-bridge\n';
  const fs = makeMemFs({ '/outside/cordis.patch.yml': patch });
  fs.mkdir('/home/u/.dsh/profiles');
  fs.symlink('/home/u/.dsh/profiles/linked', '/outside');
  runUninstallHook({ dshHome: '/home/u/.dsh', fs });
  assert.equal(fs.readFile('/outside/cordis.patch.yml'), patch);
});

test('卸载钩子跳过非法 profile 名', () => {
  const fs = makeMemFs({ '/home/u/.dsh/profiles/../evil/cordis.patch.yml': '# x\n' });
  runUninstallHook({ dshHome: '/home/u/.dsh', fs });
  assert.equal(fs.readFile('/home/u/.dsh/profiles/../evil/cordis.patch.yml'), '# x\n');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— 外部文件被改写成 `[]`

- [ ] **Step 3: 实现**

`src/uninstall.ts` 的遍历改为：

```ts
      for (const entry of fs.readdir(profilesDir)) {
        // 三道校验：名字必须是合法 profile 名、条目不得是符号链接、realpath 必须仍在 profiles 内。
        // 根因（PR #35 引入）：原先把 profiles/ 下任意条目当 profile，且 existsSync 跟随符号链接，
        // 会把 $DSH_HOME 之外的 cordis.patch.yml 改写掉。
        if (!PROFILE_NAME_PATTERN.test(entry)) continue;
        if (fs.isSymlink(join(profilesDir, entry))) continue;
        try {
          uninstallBridge({ dshHome, profile: entry, bridgeSourceDir, fs, npmGlobalNodeModules });
        } catch (err) {
          console.error(`[dsh-uninstall] ${entry}: ${String(err)}`);
        }
      }
```

`InstallerFs` 增加 `isSymlink(p: string): boolean`（生产实现 `lstatSync(p).isSymbolicLink()`），并在 `uninstallBridge` 内对 `profilesDir` 的 realpath 做一次兜底校验。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run typecheck && npm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/uninstall.ts src/bridge/installer.ts test/bridge/installer.test.ts test/bridge/profile-name.ts
git commit -m "fix(uninstall): profile 名校验 + 符号链接防护，避免改写 DSH_HOME 之外的文件"
```

---

### Task 8: 版本号与文档（0.4.3-test1）

**Files:**
- Modify: `package.json`、`package-lock.json`、`bridge-client/package.json`、`bridge-client/lib/client.js`（`BRIDGE_VERSION`）
- Modify: `README.md`、`README.zh.md`、`CHANGELOG.md`

**Interfaces:**
- Consumes: 无。
- Produces: 三处版本号一致为 `0.4.3-test1`；README 中英与 CHANGELOG 未发布节的测试数等于静态计数。

- [ ] **Step 1: 改版本号**

```bash
npm version 0.4.3-test1 --no-git-tag-version
# bridge-client/package.json 的 version 与 client.js 的 BRIDGE_VERSION 同步改为 0.4.3-test1
```

- [ ] **Step 2: 取真实测试数并同步文档**

Run: `npm test`
从输出读取 `# tests N`，然后把 README 中英的 `npm run test` 注释与 CHANGELOG 未发布节的数字改为同一个 N，并在 CHANGELOG 写明通过数与被门控跳过的集成测试数。

- [ ] **Step 3: 运行守卫确认一致**

Run: `npm test`
Expected: PASS —— `README 中英与 CHANGELOG 未发布测试数等于实际测试数`

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json bridge-client/package.json bridge-client/lib/client.js README.md README.zh.md CHANGELOG.md
git commit -m "chore(release): 0.4.3-test1——新增设置项、Desktop 启动支持与 #30–#33 修复"
```

---

### Task 9: 打包试产包并交真机验收

**Files:** 无源码改动（产物 `dsh-vscode.vsix`）

- [ ] **Step 1: 全量门禁**

Run: `npm run typecheck && npm test && npm run compile`
Expected: 三者 EXIT=0，记录真实输出

- [ ] **Step 2: 打包**

Run: `npm run package`
Expected: 生成 `dsh-vscode.vsix`，`vsce` 输出包含 `0.4.3-test1`

- [ ] **Step 3: 交用户真机验收（Windows）**

按 spec 6.2 的六项顺序，请用户逐项反馈；每项都要用户的实际结果，不得由我推断。

- [ ] **Step 4: 按反馈修复并出 `0.4.3-test2`**（重复 Task 9）

- [ ] **Step 5: 用户明确同意后合并 main、置 0.4.3 并发布**（发布动作需用户再次确认）

---

## Self-Review

**1. Spec coverage（spec 小节 → 任务）**

| spec 小节 | 覆盖任务 |
|---|---|
| 4.1 launcher 裁决 | Task 1 |
| 4.2 process 消费裁决 | Task 2 |
| 5.1 两个新配置项 | Task 3 |
| 5.2 日志与提示（来源/候选/环境信息头） | Task 2（`lastStart.source`）+ Task 3（环境信息头字段）→ **补：** Task 3 的 Step 3 必须同时给 `src/extension.ts` 的环境信息头加 `dsh 启动来源`、`dsh 实际入口`、`dsh.launchPreference`、`dsh.desktopCommandPath`、`dsh.profile` 五项 |
| 5.3 #32 会话 cwd | Task 4（#33）之后的 Task 5 |
| 5.4 隐患 1 握手 | Task 6 |
| 5.4 隐患 2 符号链接 | Task 7 |
| 6.1 自动化测试 | 各任务 Step 1/4 + Task 8 Step 3 |
| 6.2 真机验收 | Task 9 Step 3 |
| 7 发布流程 | Task 8 + Task 9 |

**2. Placeholder scan**：无 TBD/TODO；Task 5 的 `getDshContext()` 是**显式的调查产出**，已写明拿不到时的处理与上报要求，不是占位符。

**3. Type consistency**：`LaunchResolution`/`LaunchSource`/`LaunchMode` 在 Task 1 定义，Task 2 消费；`StartOptions.launchPreference`/`desktopCommandPath` 在 Task 2 定义、Task 3 透传；`InstallerFs.isSymlink` 在 Task 7 定义并使用。

**4. Review Focus 对应测试**：显式 `.cmd` 路径 → Task 1 用例；npm bin.js 不存在 → Task 1 用例；自动回退 → Task 1 用例 + Task 2 日志断言；目标变化作废旧握手 → Task 6 用例；符号链接/非法名 profile → Task 7 用例；cwd 取不到不阻塞点击 → Task 5 Step 3 的行为约束 + 用例。

**5. 已知未覆盖项（交付时须如实告知用户）**

- `node.exe` 解析（`resolveWindowsNodeExecutable`）仍可能命中 `WindowsApps` 下的应用执行别名存根；本版不处理，记录为已知限制。
- Windows 真机行为（`cmd.exe /c` 拼接、Desktop 默认目录、PATH 命中）只能由用户验收。
- #32 若 Task 5 Step 0 调查失败，本版将不含该修复，需用户重新决定。
