// src/service/manager.ts — 服务管理器：状态机编排探测/启动/等待/停止
// 纯模块：不依赖 vscode；探测与进程管理均通过依赖注入，便于单测。
import { findFreePort, PORT_FALLBACK_ATTEMPTS, type ProbeResult } from './detect';
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
  /** 是否允许 dsh web 打开浏览器（true=不传 --no-open；默认追加 --no-open） */
  openInBrowser?: boolean;
}

/**
 * 判断子进程崩溃是否因 --no-open 参数不被 dsh 支持（stderr 含 "unknown option" 与 "no-open"）。
 * 纯函数：把"是否走 --no-open 兜底重启"的判定显式化，便于单测与回溯。
 */
export function isNoOpenStderr(stderr: string): boolean {
  return /unknown option/.test(stderr) && /no-open/.test(stderr);
}

/** 注入依赖 */
export interface ManagerDeps {
  probeService: (host: string, port: number, timeoutMs?: number) => Promise<ProbeResult>;
  processRunner: ProcessRunner;
  /** 日志出口（扩展里接到 Output Channel） */
  log: (line: string) => void;
  /** 端口被占用时自动临时替换成功后的通知回调（扩展里弹窗告知用户新端口） */
  onPortFallback?: (requestedPort: number, fallbackPort: number) => void;
  /** 就绪后的健康探测间隔（毫秒，默认 30000；≤0 关闭探测） */
  healthIntervalMs?: number;
  /** 启动总超时（毫秒，默认 15000） */
  startTimeoutMs?: number;
}

/** 启动总超时默认值（毫秒） */
const DEFAULT_START_TIMEOUT_MS = 15000;
/** 就绪后健康探测间隔默认值（毫秒） */
const DEFAULT_HEALTH_INTERVAL_MS = 30000;
/** 「崩溃后换端口重启」的最大轮数（防死循环；超过后报启动崩溃） */
const PORT_FALLBACK_MAX_ROUNDS = 3;

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
  /** 旧版 dsh 不支持 --no-open：本次会话检测到后置 true，后续启动一律去掉该参数 */
  private noOpenDisabled = false;
  /** 最近一次启动子进程的 stderr 缓冲（有界，用于识别 "unknown option '--no-open'" 崩溃根因） */
  private childStderr = '';
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
    this.stopRequested = false; // 新一轮启动流程重置停止标志
    this.op = this.doStart().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 重启：停掉自己启动的服务后重新走启动流程 */
  restart(): Promise<ServiceSnapshot> {
    if (this.op) return this.op;
    this.stopRequested = false; // 新一轮启动流程重置停止标志
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

  /**
   * 完整启动流程：探测 → 复用 / 启动 → 等待就绪。
   *
   * @param portFallbackRounds 已发生的「崩溃后换端口重启」轮数（递归调用时递增；
   *                            达到上限后不再换端口，直接报启动崩溃，防止死循环）
   */
  private async doStart(portFallbackRounds = 0): Promise<ServiceSnapshot> {
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
      // 端口被其他程序占用：自动临时替换为第一个空闲端口（仅本次会话生效，不写配置）。
      // 不自动启动时替换端口没有意义，保持原「端口被占用」提示。
      if (this.opts.autoStart) {
        const fallback = await findFreePort(
          this.opts.host, this.opts.port, PORT_FALLBACK_ATTEMPTS, this.deps.probeService, this.opts.timeoutMs,
        );
        if (fallback !== null) {
          if (this.stopRequested) return this.getSnapshot(); // 探测候选期间被叫停，不覆盖用户的停止意图
          this.deps.log(`[process] 端口 ${this.opts.port} 被其他程序占用，本次会话临时改用端口 ${fallback}`);
          this.deps.onPortFallback?.(this.opts.port, fallback);
          // 运行时替换端口：本次会话内 URL/探测/重启均使用新端口；
          // 不写回 VS Code 配置，重启 VS Code 后恢复用户配置的端口。
          this.opts.port = fallback;
          // 不 return：落入下方启动流程（autoStart 为 true）
        } else {
          // 连续 50 个候选端口都被占用：保持原「端口被占用」错误
          this.set({ state: 'failed', error: 'err.portOccupied', errorVars: { port: this.opts.port } });
          return this.getSnapshot();
        }
      } else {
        this.set({ state: 'failed', error: 'err.portOccupied', errorVars: { port: this.opts.port } });
        return this.getSnapshot();
      }
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
          // noOpenDisabled 后视为"用户要求弹浏览器"（即不追加 --no-open），兼容旧版 dsh
          openInBrowser: this.noOpenDisabled ? true : this.opts.openInBrowser,
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
        // 区分错误类型：EINVAL 是 spawn 参数无效（Windows 上 cwd 非法等，重试后仍无效）；
        // NODE_NOT_FOUND 是 Windows 下找不到可用的 node.exe（Electron 环境不能把 Code.exe 当 node）；
        // ENOENT 才是命令缺失；其余保守地归为「未找到命令」。
        if (code === 'EINVAL') {
          this.set({
            state: 'failed',
            error: 'err.spawnEinval',
            errorVars: { cwd: String(this.opts.cwd ?? '') },
          });
        } else if (code === 'NODE_NOT_FOUND') {
          this.set({ state: 'failed', error: 'err.nodeNotFound' });
        } else {
          this.set({ state: 'failed', error: 'err.dshNotFound' });
        }
        return this.getSnapshot();
      }
    }
    this.child = child;
    this.childStderr = ''; // 新一轮启动重置 stderr 缓冲（供 --no-open 崩溃识别）
    // 记录实际执行的启动命令（含解析出的 node 路径与全部参数），供问题排查对照环境差异
    const lastStart = this.deps.processRunner.lastStart;
    if (lastStart) {
      this.deps.log(`[process] 启动命令: ${lastStart.command} ${lastStart.args.join(' ')}`);
    }

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
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      // 有界缓冲最近一次启动的 stderr（用于识别 --no-open 不支持导致的启动崩溃）
      if (this.childStderr.length < 4096) {
        this.childStderr += text;
        if (this.childStderr.length > 8192) this.childStderr = this.childStderr.slice(-4096);
      }
      this.deps.log(`[stderr] ${text.trimEnd()}`);
    });

    // 等待就绪：轮询探测直到 ready / 子进程退出 / 超时
    this.set({ state: 'waiting' });
    const startTimeoutMs = this.deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      if (spawnFailed) return this.getSnapshot(); // 已置为 failed（err.dshNotFound）
      if (this.stopRequested) return this.getSnapshot(); // 等待阶段被叫停（先于 childExited 判定）
      if (childExited) {
        // 兼容旧版 dsh：不支持 --no-open 时 commander 报 "unknown option '--no-open'" 后退出。
        // 这是参数问题而非端口占用，必须识别出来并去掉该参数**原端口**重启，
        // 否则会被当成"启动期间端口被抢占"而陷入换端口级联（实测踩坑）。
        if (!this.opts.openInBrowser && !this.noOpenDisabled) {
          // 给 stderr 一点冲刷时间，避免 'exit' 早于 'data' 的竞态导致漏判
          await new Promise((resolve) => setTimeout(resolve, 60));
          if (isNoOpenStderr(this.childStderr)) {
            this.deps.log('[process] 当前 dsh 版本不支持 --no-open，本次会话自动去掉该参数后原端口重启');
            this.noOpenDisabled = true;
            this.child = null;
            return this.doStart(portFallbackRounds); // 原端口重试（不递增换端口轮数）
          }
        }
        // 子进程没撑到就绪就退出：两类场景——
        // 1) 残留 dsh 实例占着端口，新实例因 EADDRINUSE 崩溃；
        // 2) 启动期间端口被其他程序抢占（如 WSL 与 Windows 共享 localhost 端口，
        //    WSL 侧 dsh 慢启动导致探测时端口空闲、启动后却被其占用）。
        // 自愈策略：探测一次端口——
        //   a. 已有 dsh 在跑 → 直接复用（owned=false，不误杀他人进程）；
        //   b. 端口被非 dsh 抢占（含 WSL 转发代理占端口但页面不可达）→ 自动换端口重启；
        //   c. 其余 → 启动崩溃。
        this.child = null;
        const reuse = await this.deps.probeService(this.opts.host, this.opts.port, this.opts.timeoutMs);
        // 自愈探测期间被叫停：保留 stop() 已设置的状态（idle），绝不覆盖为 failed
        if (this.stopRequested) return this.getSnapshot();
        if (reuse === 'dsh') {
          this.deps.log('[process] 子进程退出，但端口已有 dsh 服务在运行（残留实例占端口自愈），改为复用');
          this.set({ state: 'ready', url: this.url(), owned: false });
          this.startHealthWatch();
          return this.getSnapshot();
        }
        // 换端口重启：端口在启动期间被抢占，自动改用第一个空闲端口（仅本次会话，
        // 弹窗告知）；带轮数上限防死循环（每次崩溃都换新端口重启，最多 3 轮）。
        if (this.opts.autoStart && portFallbackRounds < PORT_FALLBACK_MAX_ROUNDS) {
          const fallback = await findFreePort(
            this.opts.host, this.opts.port, PORT_FALLBACK_ATTEMPTS, this.deps.probeService, this.opts.timeoutMs,
          );
          if (fallback !== null && !this.stopRequested) {
            this.deps.log(`[process] 子进程退出（端口 ${this.opts.port} 启动期间被抢占），本次会话临时改用端口 ${fallback} 重启`);
            this.deps.onPortFallback?.(this.opts.port, fallback);
            this.opts.port = fallback; // 运行时替换：本次会话内 URL/探测/重启均使用新端口
            return this.doStart(portFallbackRounds + 1); // 递归重启（新端口重新探测 + 启动）
          }
        }
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
