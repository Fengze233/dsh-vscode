// src/service/process.ts — dsh web 子进程封装（跨平台）
// 纯模块：spawn 通过参数注入，便于单测；不依赖 vscode。
import { spawn, type SpawnOptions } from 'node:child_process';

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
 */
export function createProcessRunner(
  spawnImpl: SpawnFn = spawn as unknown as SpawnFn,
  platform: string = process.platform,
  graceMs = 3000,
): ProcessRunner {
  let lastChild: ChildProcessLike | null = null;

  return {
    startDsh({ host, port, extraArgs }) {
      // Windows 的可执行命令是 dsh.cmd；其他平台直接 dsh
      const command = platform === 'win32' ? 'dsh.cmd' : 'dsh';
      const args = ['web', '--host', host, '--port', String(port), ...extraArgs];
      const child = spawnImpl(command, args, {
        // POSIX 下脱离父进程组；Windows 不 detached（由父进程退出钩子负责清理）
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
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
