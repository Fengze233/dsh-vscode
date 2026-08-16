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
 * @param existsImpl 存在性校验（默认 node:fs.existsSync；单测注入假实现以便控制 cwd 校验结果）
 */
export function createProcessRunner(
  spawnImpl: SpawnFn = spawn as unknown as SpawnFn,
  platform: string = process.platform,
  graceMs = 3000,
  existsImpl: (p: string) => boolean = existsSync,
): ProcessRunner {
  let lastChild: ChildProcessLike | null = null;

  return {
    startDsh({ host, port, extraArgs, cwd, executablePath }) {
      // 可执行命令：显式指定 executablePath 时优先；否则按平台默认 dsh.cmd / dsh
      const command = executablePath && executablePath.length > 0
        ? executablePath
        : platform === 'win32' ? 'dsh.cmd' : 'dsh';
      const args = ['web', '--host', host, '--port', String(port), ...extraArgs];
      // 工作目录容错：过滤掉 Windows 上的 UNC / 不存在 / 相对路径，避免 spawn 抛 EINVAL
      const sanitizedCwd = sanitizeCwd(cwd, platform, existsImpl);
      const child = spawnImpl(command, args, {
        // POSIX 下脱离父进程组；Windows 不 detached（由父进程退出钩子负责清理）
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // cwd 仅在显式传入时指定，避免覆盖 spawn 自身对缺省 cwd 的处理
        ...(sanitizedCwd === undefined ? {} : { cwd: sanitizedCwd }),
      });
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
