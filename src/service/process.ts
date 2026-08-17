// src/service/process.ts — dsh web 子进程封装（跨平台）
// 纯模块：spawn 通过参数注入，便于单测；不依赖 vscode。
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 as win32Path } from 'node:path';

/** 最小子进程接口（真实 ChildProcess 结构上兼容，测试可注入假实现） */
export interface ChildProcessLike {
  pid?: number;
  stdout?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** spawn 函数签名（便于注入假实现） */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;

/** 启动参数 */
export interface StartOptions {
  host: string;
  port: number;
  extraArgs: string[];
  /** 子进程工作目录（兜底：让 dsh web 以 VS Code 工作区为 cwd，缺省则不指定） */
  cwd?: string;
  /** dsh 可执行文件绝对路径（非空时优先于平台默认命令名 dsh.cmd / dsh 使用） */
  executablePath?: string;
}

/**
 * 进程运行环境注入（便于单测；默认取生产运行值）。
 * 用于 Windows 分支推导"node 直跑 bin.js"所用的 node 路径与 PATH 查找目录。
 */
export interface RunnerEnv {
  /** node 可执行文件绝对路径（生产为 process.execPath） */
  execPath?: string;
  /** 环境变量 PATH 字符串值（生产为 process.env.PATH） */
  path?: string;
  /** Electron 运行时版本（仅 Electron 环境有值；真实 Node 下为 undefined）。
   *  扩展宿主是 Electron，process.execPath 指向 Code.exe，绝不能当作 node 使用。 */
  electronVersion?: string;
}

/**
 * 校验可传给 spawn 的工作目录：仅接受存在且非 UNC 网络路径的绝对路径。
 *
 * 背景：Windows 的 CreateProcess 对无效工作目录（UNC 网络路径、不存在的路径等）
 * 抛出 EINVAL（spawn 的同步异常），会把「参数错误」伪装成「命令缺失」。此函数在
 * spawn 前把这类 cwd 过滤为 undefined，让 spawn 走自身默认 cwd 的路径。
 *
 * @param cwd        候选工作目录（来自 VS Code 工作区路径）
 * @param platform   平台名（process.platform）
 * @param existsImpl 存在性校验（默认 node:fs.existsSync；单测可注入假实现）
 */
export function sanitizeCwd(
  cwd: string | undefined,
  platform: string,
  existsImpl: (p: string) => boolean = existsSync,
): string | undefined {
  if (cwd === undefined) return undefined;
  // 非 Windows 平台：无 UNC 限制，仅做存在性校验，不存在则返回 undefined
  if (platform !== 'win32') {
    return existsImpl(cwd) ? cwd : undefined;
  }
  // Windows：必须是绝对路径、不是 UNC 网络路径（以 \\ 开头）、且真实存在。
  // 注意：用 path.win32.isAbsolute 判断，因为 cwd 是 Windows 风格路径，与运行平台无关。
  if (!win32Path.isAbsolute(cwd)) return undefined;
  if (cwd.startsWith('\\\\')) return undefined; // UNC：\\server\share
  return existsImpl(cwd) ? cwd : undefined;
}

/**
 * 在 PATH 的目录列表中查找可执行文件（Windows 查找语义的简化版，只找固定文件名）。
 *
 * 真实 Windows 会依次试探 PATH 各目录（含 `.com` / `.exe` / `.bat` / `.cmd` 等扩展名），
 * 这里简化为：按分隔符拆分 envPath，对每个目录拼上固定文件名，用 existsImpl 判断是否存在，
 * 命中即返回该候选路径；全部未命中返回 null。
 *
 * @param target     待查找的固定文件名（如 'dsh.cmd'）
 * @param envPath    环境变量 PATH 的字符串值（分隔符 ':' 或 ';'，Windows 为 ';'）
 * @param existsImpl 存在性校验（默认 node:fs.existsSync；单测可注入假实现）
 * @returns 命中的完整路径，未命中返回 null
 */
export function findInPath(
  target: string,
  envPath: string | undefined,
  existsImpl: (p: string) => boolean = existsSync,
): string | null {
  if (envPath === undefined) return null;
  // Windows PATH 用 ';' 分隔；本函数即 Windows 查找语义，固定 ';'（注意盘符 'C:' 含冒号，
  // 不可用 ':' 判定/拆分，否则会把 'C:\x' 误拆成 ['C', '\x']）
  for (const dir of envPath.split(';')) {
    if (dir === '') continue; // 跳过空条目（PATH 首尾分隔符产生）
    // 用 path.win32.join：须始终产出反斜杠路径（与运行平台无关）
    const candidate = win32Path.join(dir, target);
    if (existsImpl(candidate)) return candidate;
  }
  return null;
}

/**
 * 由 dsh.cmd 的绝对路径推导 npm shim 的真实入口 bin.js 路径。
 *
 * npm 在 Windows 上生成的 shim（如 `dsh.cmd`）实际是把调用转发到同目录下的
 * `node_modules/<scope>/<pkg>/lib/bin.js`。本函数把 shim 所在目录替换为该真实入口
 * 的绝对路径，供后续"用 node 直接执行 bin.js"启动服务时使用。
 *
 * @param dshCmdPath dsh.cmd 的绝对路径（或 shim 所在任意文件路径，取 dirname）
 * @returns 推导出的 bin.js 绝对路径
 */
export function binJsFromShim(dshCmdPath: string): string {
  // 用 path.win32：shim 是 Windows 路径，须始终以反斜杠拼接（与运行平台无关）
  return win32Path.join(win32Path.dirname(dshCmdPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/** Windows 下"node 直跑 bin.js"的启动参数 */
export interface WindowsDshInvocation {
  /** 实际 spawn 的命令（node 可执行文件绝对路径） */
  command: string;
  /** 需排在 'web ...' 之前的参数前缀（即 bin.js 绝对路径） */
  argsPrefix: string[];
}

/**
 * 构造 Windows 下"node 直跑 bin.js"的启动参数。
 *
 * 背景：Windows 上 `spawn('dsh.cmd')` 会因 .cmd 是批处理 shim 而在 Node v24 下同步抛
 * EINVAL，改用 `node <bin.js>` 直跑真实入口即可绕过。本函数返回 { command: execPath,
 * argsPrefix: [binJsPath] }，调用方将其作为 spawn(command, [...argsPrefix, 'web', ...])。
 *
 * @param dshCmdPath dsh.cmd（或直接 bin.js）的绝对路径；bin.js 路径由其 dirname 推导
 * @param execPath   node 可执行文件绝对路径（生产为 process.execPath）
 * @returns Windows 下 node 直跑 bin.js 的启动参数
 */
export function windowsDshInvocation(dshCmdPath: string, execPath: string): WindowsDshInvocation {
  return { command: execPath, argsPrefix: [binJsFromShim(dshCmdPath)] };
}

/**
 * 解析 Windows 下执行 bin.js 所用的 node 可执行文件绝对路径。
 *
 * 背景（Windows 实测根因，HMR 崩溃 `--expose-internals is required for HMR service`）：
 * VS Code 扩展宿主是 Electron 进程，process.execPath 指向 Code.exe——用它 spawn 时
 * bin.js 会跑在 Electron 运行时里：webserver 等纯 JS 部分能起来，但 dsh 的
 * loader/HMR 依赖系统 Node 的内部特性（--expose-internals 或 node-addon-require-builtin
 * 原生模块，其二进制按系统 Node ABI 编译），Electron 运行时里两者都不可用 →
 * HMR 插件启动失败 → 整个 boot 崩溃 → 面板显示「服务已断开」。
 * 因此 Electron 环境绝不使用 execPath，必须解析系统 PATH 里的 node.exe。
 *
 * 解析顺序（与 npm 生成的 dsh.cmd shim 语义对齐）：
 * 1. shim 目录旁的 node.exe（部分安装布局把 node 放在 npm bin 目录旁边）；
 * 2. 系统 PATH 里的 node.exe（常规安装：C:\Program Files\nodejs）；
 * 3. 非 Electron 环境：execPath 本身就是真实 node（直接 node 运行/单测场景）兜底；
 * 4. 全部失败：抛 code=NODE_NOT_FOUND（Electron 环境绝不能把 Code.exe 当 node 用）。
 *
 * @param shimPath   dsh.cmd（或用户配置的 bin.js）的绝对路径
 * @param env        运行环境注入（execPath / path / electronVersion）
 * @param existsImpl 存在性校验（默认 node:fs.existsSync；单测可注入假实现）
 * @returns node.exe 绝对路径
 * @throws code=NODE_NOT_FOUND 所有候选都不可用时
 */
export function resolveWindowsNodeExecutable(
  shimPath: string,
  env: RunnerEnv,
  existsImpl: (p: string) => boolean = existsSync,
): string {
  // Electron 判定：注入值优先；未注入时读真实 process.versions（扩展宿主里是 Electron 版本号）。
  // 双保险：execPath 的文件名以 code 开头（Code.exe/code.exe，VS Code 主程序）也视为 Electron——
  // 即使 versions.electron 检测意外失效，也绝不把 Code.exe 当 node 用。
  const isElectron =
    (typeof env.electronVersion === 'string' && env.electronVersion !== '') ||
    (typeof (process.versions as { electron?: string }).electron === 'string' &&
      (process.versions as { electron?: string }).electron !== '') ||
    /^code(\.exe)?$/i.test(win32Path.basename(env.execPath ?? process.execPath ?? ''));
  const pathEnv = env.path ?? process.env.PATH ?? '';

  // 1) shim 目录旁的 node.exe（npm shim 的 %dp0%\node.exe 语义；仅绝对路径才有可靠 dirname）
  if (win32Path.isAbsolute(shimPath)) {
    const besideShim = win32Path.join(win32Path.dirname(shimPath), 'node.exe');
    if (existsImpl(besideShim)) return besideShim;
  }

  // 2) 系统 PATH 里的 node.exe（常规安装布局）
  const inPath = findInPath('node.exe', pathEnv, existsImpl);
  if (inPath) return inPath;

  // 3) 非 Electron 环境：execPath 本身就是真实 node，兜底使用
  const execPath = env.execPath ?? process.execPath;
  if (!isElectron && execPath) return execPath;

  // 4) 全部失败：明确报「未找到 node.exe」，绝不把 Electron 的 Code.exe 当 node 用
  throw Object.assign(
    new Error(`node.exe not found in PATH (dsh shim at ${shimPath})`),
    { code: 'NODE_NOT_FOUND' },
  );
}

/** 进程管理接口 */
export interface ProcessRunner {
  /** 启动 dsh web 子进程（命令名按平台选择） */
  startDsh(opts: StartOptions): ChildProcessLike;
  /** 优雅停止：先 SIGTERM，宽限期后 SIGKILL */
  stopChild(child: ChildProcessLike): Promise<void>;
  /** 最近一次启动的子进程（测试钩子；生产代码可忽略） */
  lastChild: ChildProcessLike | null;
}

/**
 * 创建进程管理器。
 * @param spawnImpl 注入的 spawn（默认 node:child_process.spawn）
 * @param platform  平台名（默认 process.platform）
 * @param graceMs   SIGTERM 到 SIGKILL 的宽限期（默认 3000）
 * @param existsImpl 存在性校验（默认 node:fs.existsSync；单测注入假实现以便控制 cwd / bin.js 查找结果）
 * @param env       运行环境注入（execPath / path；默认 process.execPath / process.env.PATH，工厂内取，保持既有调用不破）
 */
export function createProcessRunner(
  spawnImpl: SpawnFn = spawn as unknown as SpawnFn,
  platform: string = process.platform,
  graceMs = 3000,
  existsImpl: (p: string) => boolean = existsSync,
  env: RunnerEnv = { execPath: process.execPath, path: process.env.PATH ?? '' },
): ProcessRunner {
  let lastChild: ChildProcessLike | null = null;

  return {
    startDsh({ host, port, extraArgs, cwd, executablePath }) {
      // 基础参数（web 子命令 + host/port + 用户额外参数），两种平台共用
      const webArgs = ['web', '--host', host, '--port', String(port), ...extraArgs];
      // 工作目录容错：过滤掉 Windows 上的 UNC / 不存在 / 相对路径，避免 spawn 抛 EINVAL
      const sanitizedCwd = sanitizeCwd(cwd, platform, existsImpl);
      const spawnOptions: SpawnOptions = {
        // POSIX 下脱离父进程组；Windows 不 detached（由父进程退出钩子负责清理）
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // cwd 仅在显式传入时指定，避免覆盖 spawn 自身对缺省 cwd 的处理
        ...(sanitizedCwd === undefined ? {} : { cwd: sanitizedCwd }),
      };

      let child: ChildProcessLike;
      if (platform === 'win32') {
        // Windows：.cmd 是批处理 shim，Node v24 直接 spawn 会同步抛 EINVAL，
        // 故改为用 node 直接执行 shim 指向的真实入口 bin.js，绕过 .cmd shim。
        const pathEnv = env.path ?? process.env.PATH ?? '';

        // 1) 确定 dsh.cmd 的绝对路径：显式 executablePath 优先；否则在 PATH 里找 dsh.cmd
        let shimPath: string | null;
        if (executablePath && executablePath.length > 0) {
          shimPath = executablePath;
        } else {
          shimPath = findInPath('dsh.cmd', pathEnv, existsImpl);
          // 找不到 dsh.cmd → 保持"未找到 dsh"语义（code ENOENT），manager 的 ENOENT 分支照常工作
          if (shimPath === null) {
            throw Object.assign(new Error('dsh.cmd not found in PATH'), { code: 'ENOENT' });
          }
        }

        // 2) 若 executablePath 直接指向 bin.js（以 .js 结尾），则 argsPrefix 就用该 js 本身；
        //    否则由 shim 的 dirname 推导 bin.js 绝对路径。
        const argsPrefix = shimPath.endsWith('.js')
          ? [shimPath]
          : [binJsFromShim(shimPath)];

        // 3) 解析执行 bin.js 所用的 node.exe：Electron 环境下 execPath 是 Code.exe 不可用，
        //    必须解析系统 PATH 里的 node.exe（详见 resolveWindowsNodeExecutable 注释）。
        const nodeExecutable = resolveWindowsNodeExecutable(shimPath, env, existsImpl);

        // 4) spawn(node, [binJs, 'web', --host, --port, ...extraArgs], options)
        child = spawnImpl(nodeExecutable, [...argsPrefix, ...webArgs], spawnOptions);
      } else {
        // 非 Windows 分支完全不变：仍 spawn 'dsh'（或显式 executablePath）
        const command = executablePath && executablePath.length > 0 ? executablePath : 'dsh';
        child = spawnImpl(command, webArgs, spawnOptions);
      }

      lastChild = child;
      return child;
    },

    async stopChild(child) {
      if (child.pid === undefined) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, graceMs));
      child.kill('SIGKILL');
    },

    get lastChild() {
      return lastChild;
    },
  };
}
