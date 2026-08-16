// src/service/manager.ts — 服务管理器：状态机编排探测/启动/等待/停止
// 纯模块：不依赖 vscode；探测与进程管理均通过依赖注入，便于单测。
import type { ProbeResult } from './detect';
import type { ChildProcessLike, ProcessRunner } from './process';
import type { MsgKey } from '../i18n';

/** 服务状态 */
export type ServiceState = 'idle' | 'detecting' | 'starting' | 'waiting' | 'ready' | 'failed' | 'stopping';

/** 对外发布的状态快照（不可变副本） */
export interface ServiceSnapshot {
  state: ServiceState;
  /** 就绪后的网页地址（http://host:port/） */
  url: string | null;
  /** 失败原因（i18n 键，由面板/状态栏负责翻译） */
  error: MsgKey | null;
  /** 错误文案的 {变量} 值 */
  errorVars?: Record<string, string | number>;
  /** 当前就绪的服务是否由插件启动（决定 stop 时是否可杀） */
  owned: boolean;
}

/** 管理器配置 */
export interface ManagerOptions {
  host: string;
  port: number;
  extraArgs: string[];
  autoStart: boolean;
  /** 子进程工作目录（兜底：让 dsh web 以 VS Code 工作区为 cwd，缺省则不指定） */
  cwd?: string;
  /** 单次探测超时（毫秒） */
  timeoutMs: number;
  /** 等待就绪的轮询间隔（毫秒） */
  pollMs: number;
  /** dsh 可执行文件绝对路径（非空时优先于平台默认命令名使用） */
  executablePath?: string;
}

/** 注入依赖 */
export interface ManagerDeps {
  probeService: (host: string, port: number, timeoutMs?: number) => Promise<ProbeResult>;
  processRunner: ProcessRunner;
  /** 日志出口（扩展里接到 Output Channel） */
  log: (line: string) => void;
  /** 就绪后的健康探测间隔（毫秒，默认 30000；≤0 关闭探测） */
  healthIntervalMs?: number;
  /** 启动总超时（毫秒，默认 15000） */
  startTimeoutMs?: number;
}

/** 启动总超时默认值（毫秒） */
const DEFAULT_START_TIMEOUT_MS = 15000;
/** 就绪后健康探测间隔默认值（毫秒） */
const DEFAULT_HEALTH_INTERVAL_MS = 30000;

export class ServiceManager {
  private snapshot: ServiceSnapshot = { state: 'idle', url: null, error: null, owned: false };
  private listeners = new Set<(s: ServiceSnapshot) => void>();
  /** 进行中的启动/重启流程（防并发，幂等复用） */
  private op: Promise<ServiceSnapshot> | null = null;
  /** 就绪后的健康探测定时器（兜底外部服务失联/子进程活着但服务已死） */
  private healthTimer: NodeJS.Timeout | null = null;
  /** 停止请求标志：启动流程进行中也要立即停掉已 spawn 的子进程 */
  private stopRequested = false;
  /** 插件自己启动的子进程（复用外部服务时为 null） */
  private child: ChildProcessLike | null = null;
  private disposed = false;
  /** 父进程退出时杀掉子进程，防止僵尸（stopOnExit=false 时移除） */
  private parentExitHook = (): void => {
    try {
      this.child?.kill('SIGKILL');
    } catch {
      /* 进程可能已退出，忽略 */
    }
  };

  constructor(private opts: ManagerOptions, private deps: ManagerDeps) {
    process.once('exit', this.parentExitHook);
  }

  /** 当前状态快照（副本，防外部篡改） */
  getSnapshot(): ServiceSnapshot {
    return { ...this.snapshot };
  }

  /** 当前目标地址（面板生成 CSP frame-src 用） */
  getTarget(): { host: string; port: number } {
    return { host: this.opts.host, port: this.opts.port };
  }

  /** 订阅状态变化，返回退订函数 */
  onChange(cb: (s: ServiceSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 更新内部状态并广播 */
  private set(partial: Partial<ServiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const cb of this.listeners) cb(this.getSnapshot());
  }

  /** 网页地址 */
  private url(): string {
    return `http://${this.opts.host}:${this.opts.port}/`;
  }

  /** 确保服务就绪：复用已有 / 自动启动（幂等：并发调用共享同一次流程） */
  ensureRunning(): Promise<ServiceSnapshot> {
    if (this.op) return this.op;
    if (this.snapshot.state === 'ready') return Promise.resolve(this.getSnapshot());
    this.op = this.doStart().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 重启：停掉自己启动的服务后重新走启动流程 */
  restart(): Promise<ServiceSnapshot> {
    if (this.op) return this.op;
    this.op = (async () => {
      await this.stopOwned();
      return this.doStart();
    })().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 停止：仅停止插件自己启动的服务；启动流程进行中也会立即停掉已 spawn 的子进程 */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearHealthWatch(); // 复用外部服务时也要清掉健康探测定时器
    if (this.child) {
      await this.stopOwned();
    } else {
      this.set({ state: 'idle', url: null, owned: false, error: null });
    }
  }

  /** 停掉自启子进程并回到 idle */
  private async stopOwned(): Promise<void> {
    this.clearHealthWatch();
    if (!this.child) {
      this.set({ state: 'idle', url: null, owned: false, error: null });
      return;
    }
    this.set({ state: 'stopping' });
    const child = this.child;
    this.child = null;
    try {
      await this.deps.processRunner.stopChild(child);
    } catch (err) {
      this.deps.log(`[process] 停止子进程失败: ${String(err)}`);
    }
    this.set({ state: 'idle', url: null, owned: false, error: null });
  }

  /** 完整启动流程：探测 → 复用 / 启动 → 等待就绪 */
  private async doStart(): Promise<ServiceSnapshot> {
    this.stopRequested = false; // 新一轮启动流程重置停止标志
    this.set({ state: 'detecting', error: null });
    const probe = await this.deps.probeService(this.opts.host, this.opts.port, this.opts.timeoutMs);
    if (probe === 'dsh') {
      // 已有服务在跑：直接复用
      if (this.stopRequested) return this.getSnapshot(); // 探测期间被叫停，不覆盖用户的停止意图
      this.set({ state: 'ready', url: this.url(), owned: false });
      this.startHealthWatch(); // 复用外部服务也要周期探测，失联时回 idle
      return this.getSnapshot();
    }
    if (probe === 'foreign') {
      // 端口被其他程序占用：提示换端口，绝不杀他人进程
      this.set({ state: 'failed', error: 'err.portOccupied', errorVars: { port: this.opts.port } });
      return this.getSnapshot();
    }
    if (!this.opts.autoStart) {
      this.set({ state: 'failed', error: 'err.notRunning' });
      return this.getSnapshot();
    }

    // 启动子进程
    if (this.stopRequested) return this.getSnapshot(); // 启动前被叫停
    this.set({ state: 'starting' });
    // Node 在 Windows 上对 .cmd 批处理文件带 cwd 参数 spawn 存在已知的同步抛 EINVAL
    // （参数无效）问题：只要传入 cwd（无论英文/中文路径）就会抛 EINVAL，与路径内容无关。
    // 因此这里做一次「去掉 cwd 重试」的降级：第一次失败若为 EINVAL 且带了 cwd，
    // 则以 cwd=undefined 再 spawn 一次（args/主机/端口/可执行路径照旧）；重试仍失败才报错。
    let child: ChildProcessLike;
    let cwdForSpawn: string | undefined = this.opts.cwd;
    let retried = false; // 是否已执行过去掉 cwd 的降级重试（最多重试一次）
    for (;;) {
      try {
        child = this.deps.processRunner.startDsh({
          host: this.opts.host,
          port: this.opts.port,
          extraArgs: this.opts.extraArgs,
          cwd: cwdForSpawn,
          executablePath: this.opts.executablePath,
        });
        break; // spawn 成功（未同步抛异常），跳出重试循环继续等待就绪
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        this.deps.log(`[process] 启动失败: ${String(err)} (code=${code}, cwd=${cwdForSpawn ?? ''})`);
        // EINVAL + 带 cwd 且尚未重试过：这是 Node/Windows 上 .cmd 带 cwd 的已知兼容问题，
        // 去掉 cwd 重试一次，而不是直接报失败（直接报错会把参数问题误报成启动失败）。
        if (code === 'EINVAL' && cwdForSpawn !== undefined && !retried) {
          this.deps.log(`[process] spawn EINVAL（工作目录参数在 Windows 上不可用），已自动回退为不带 cwd 重试: ${String(err)}`);
          cwdForSpawn = undefined; // 去掉 cwd 降级重试
          retried = true;
          continue;
        }
        // 区分错误类型：EINVAL 是 spawn 参数无效（Windows 上 cwd 非法等，重试后仍无效），
        // ENOENT 才是命令缺失；其余保守地归为「未找到命令」。
        if (code === 'EINVAL') {
          this.set({
            state: 'failed',
            error: 'err.spawnEinval',
            errorVars: { cwd: String(this.opts.cwd ?? '') },
          });
        } else {
          this.set({ state: 'failed', error: 'err.dshNotFound' });
        }
        return this.getSnapshot();
      }
    }
    this.child = child;

    // spawn 的 ENOENT 通过 'error' 事件异步到达，用标志位让等待循环立即失败
    let spawnFailed = false;
    // 等待阶段子进程退出的标志（等待循环据此判定 err.startCrashed）
    let childExited = false;
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      this.deps.log(`[process] ${err.message} (code=${code}, cwd=${this.opts.cwd ?? ''})`);
      // EINVAL（Windows 上非法的 spawn 参数，如 UNC/无效 cwd）与 ENOENT（命令缺失）
      // 同等对待：立即置为 failed，避免走「等待超时」路径误导用户。
      if (code === 'EINVAL') {
        spawnFailed = true;
        this.set({
          state: 'failed',
          error: 'err.spawnEinval',
          errorVars: { cwd: String(this.opts.cwd ?? '') },
        });
      } else if (code === 'ENOENT') {
        spawnFailed = true;
        this.set({ state: 'failed', error: 'err.dshNotFound' });
      }
    });
    child.on('exit', () => {
      childExited = true;
      this.handleUnexpectedExit(child);
    });
    child.stdout?.on('data', (chunk) => this.deps.log(`[stdout] ${chunk.toString().trimEnd()}`));
    child.stderr?.on('data', (chunk) => this.deps.log(`[stderr] ${chunk.toString().trimEnd()}`));

    // 等待就绪：轮询探测直到 ready / 子进程退出 / 超时
    this.set({ state: 'waiting' });
    const startTimeoutMs = this.deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      if (spawnFailed) return this.getSnapshot(); // 已置为 failed（err.dshNotFound）
      if (this.stopRequested) return this.getSnapshot(); // 等待阶段被叫停（先于 childExited 判定）
      if (childExited) {
        // 子进程没撑到就绪就退出：判定为启动崩溃
        this.child = null;
        this.set({ state: 'failed', error: 'err.startCrashed' });
        return this.getSnapshot();
      }
      const result = await this.deps.probeService(this.opts.host, this.opts.port, this.opts.timeoutMs);
      if (result === 'dsh') {
        this.set({ state: 'ready', url: this.url(), owned: true });
        this.startHealthWatch();
        return this.getSnapshot();
      }
      // 'foreign' 表示子进程没能绑定端口（被占）——继续等待会让用户困惑，
      // 但可能只是服务尚未就绪的瞬间，保守起见继续轮询直到超时。
      if (Date.now() >= deadline) {
        this.set({
          state: 'failed',
          error: 'err.startTimeout',
          errorVars: { seconds: Math.round(startTimeoutMs / 1000) },
        });
        return this.getSnapshot();
      }
      await new Promise((r) => setTimeout(r, this.opts.pollMs));
    }
  }

  /** 就绪状态下子进程意外退出：回到 idle（面板据此显示"已断开"） */
  private handleUnexpectedExit(child: ChildProcessLike): void {
    if (this.child !== child) return; // 已被 stopOwned 接管或已替换
    this.child = null;
    if (this.snapshot.state === 'ready') {
      this.clearHealthWatch();
      this.set({ state: 'idle', url: null, owned: false, error: null });
    }
  }

  /** 就绪后周期探测：发现服务不再是 DSH 时回到 idle（面板据此显示"已断开"） */
  private startHealthWatch(): void {
    this.clearHealthWatch();
    const interval = this.deps.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    if (interval <= 0) return;
    this.healthTimer = setInterval(() => {
      void this.deps.probeService(this.opts.host, this.opts.port, this.opts.timeoutMs).then((result) => {
        if (result !== 'dsh' && this.snapshot.state === 'ready') {
          this.clearHealthWatch(); // 已回 idle，定时器自清理，不空转
          this.set({ state: 'idle', url: null, owned: false, error: null });
        }
      });
    }, interval);
  }

  /** 清除健康探测定时器 */
  private clearHealthWatch(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** 应用新配置；仅 host/port 变化且自启服务在跑时自动重启（其余项原地生效） */
  reconfigure(opts: ManagerOptions): Promise<ServiceSnapshot> {
    const targetChanged = this.opts.host !== opts.host || this.opts.port !== opts.port;
    this.opts = opts;
    if (targetChanged) {
      if (this.child) return this.restart();
      // 复用外部服务时只更新地址展示，实际可达性由下次 ensureRunning 重新探测
      if (this.snapshot.state === 'ready') this.set({ url: this.url() });
    }
    return Promise.resolve(this.getSnapshot());
  }

  /** stopOnExit=false 时保持服务运行：移除父进程退出杀子钩子 */
  setExitBehavior(keepAlive: boolean): void {
    if (keepAlive) {
      process.removeListener('exit', this.parentExitHook);
    } else if (!process.listeners('exit').includes(this.parentExitHook)) {
      process.once('exit', this.parentExitHook);
    }
  }

  /** 清理：移除钩子与监听器（不杀子进程，停止由 stop() 决定）；
   * 仍有活跃子进程时保留父进程退出钩子，防止启动流程中被 dispose 后成孤儿 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHealthWatch();
    if (!this.child) process.removeListener('exit', this.parentExitHook);
    this.listeners.clear();
  }
}
