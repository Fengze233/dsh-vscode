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
  /** cmd 模式且脚本路径已被引号包裹时置真：调用方须用 windowsVerbatimArguments spawn，
   *  否则 Node 会再转义一层引号，cmd 收到字面引号并报「文件名、目录名或卷标语法不正确」。 */
  verbatimCommandLine?: boolean;
  /** 命中的 DSH Desktop 安装根（仅 desktop 来源有值），供版本探测使用 */
  desktopRoot?: string;
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

/**
 * 构造 `cmd.exe` 执行脚本的参数前缀。
 *
 * 为什么路径要写成 `""…""`（双层引号）：`cmd /d /s /c` 的引号规则是——
 * 若 `/c` 之后的第一个字符是引号，`/s` 会剥掉**最外层**那一对，剩下的内容才当命令解析。
 * 因此含空格的脚本路径必须写成 `cmd /d /s /c ""C:\Program Files\x\dsh.cmd" 参数…"`；
 * 只写一层引号（或完全不写）时，cmd 会在空格处截断，报「'C:\Program Files\DeepSeek' 不是内部或外部命令」。
 * 参数本身由 Node 按 Windows 命令行规则转义，无需再加引号。
 */
export function cmdScriptArgs(scriptPath: string): string[] {
  return ['/d', '/s', '/c', `""${scriptPath}""`];
}

/**
 * Desktop 装法里与 `dsh.cmd` 同目录的真实入口 bin.js 候选路径。
 *
 * 若它存在，就能像 npm 装法一样「node 直跑 bin.js」——完全不需要 cmd 引号这一层，
 * 也就不会有「路径含空格被截断 / 引号被二次转义」这类平台差异问题。
 */
export function desktopBinJsCandidate(desktopCmdPath: string): string {
  return win32Path.join(win32Path.dirname(desktopCmdPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/**
 * 判断 target 是否位于 parent 之内（跨平台：Windows 的 `\` 与 POSIX 的 `/` 同等对待）。
 *
 * 为什么不用 startsWith(parent + '/')：Windows 路径用反斜杠拼接，拼 '/' 后恒不成立，
 * 结果是「所有 profile 都被判为越界而跳过」——卸载钩子在 Windows 上会整体失效（回归）。
 */
export function containsPath(parent: string, target: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = norm(parent);
  const t = norm(target);
  // 盘符绝对路径（如 C:/…）按不区分大小写比较：Windows 文件系统本身不区分大小写
  const caseInsensitive = /^[A-Za-z]:\//.test(p);
  const [pp, tt] = caseInsensitive ? [p.toLowerCase(), t.toLowerCase()] : [p, t];
  if (tt === pp) return true;
  return tt.startsWith(`${pp}/`);
}

/**
 * 从 Desktop 的 `dsh.cmd` 路径反推 Desktop 安装根（`…\DeepSeek Harness`）。
 * 用途：① 让「npm 装法探测」不把 Desktop 的命令误当成 npm 全局 shim（否则每次启动都报
 * 「bin.js missing」并多算一次候选）；② 供版本探测定位 `resources\runtime\cli` 下的包清单。
 * 返回 null 表示不像 Desktop 的标准布局（此时不做任何特殊处理）。
 */
export function desktopRootFromShim(dshCmdPath: string): string | null {
  const m = /^(.*[\\/]DeepSeek Harness)[\\/]resources[\\/]runtime[\\/]/i.exec(dshCmdPath);
  return m === null ? null : m[1];
}

/** 该路径是否位于 DSH Desktop 安装目录内（用于把 npm 探测限定在真正的 npm 全局目录） */
export function isDesktopInstallPath(candidate: string): boolean {
  return desktopRootFromShim(candidate) !== null;
}

/** 校验 preference：非法值回退 auto（与 config.ts 的规范化保持同一语义） */
function normalizePreference(raw: string | undefined): LaunchPreference {
  return raw === 'npm' || raw === 'desktop' ? raw : 'auto';
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
      // 非 Windows：显式路径直接作为 spawn 的命令使用（保持既有行为），
      // 因此不设参数前缀、mode 仅作标记（调用方在该平台不消费 mode）
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
        : (exists(desktopBinJsCandidate(explicit))
            ? {
                // 与 npm 装法同构：同目录存在 bin.js 时直接 node 直跑，绕开 cmd 引号层
                source: 'explicit', mode: 'node', executablePath: desktopBinJsCandidate(explicit),
                argsPrefix: [desktopBinJsCandidate(explicit)],
                fellBack: false, reason: 'explicit script dir ships bin.js (node direct)', candidateLog: log,
              }
            : {
                source: 'explicit', mode: 'cmd', executablePath: explicit,
                argsPrefix: cmdScriptArgs(explicit), verbatimCommandLine: true,
                fellBack: false, reason: 'explicit script (cmd, verbatim command line)', candidateLog: log,
              });
    }
    log.push(`explicit: ${explicit} not found`);
  }

  // 2) 两个来源各自的可用性判定（都做完整判定，便于回退与日志）
  const npmShimRaw = isWin ? findInPathWin('dsh.cmd', env.path, exists) : null;
  // PATH 里若只有 DSH Desktop 的命令，它并不是 npm 全局 shim：直接判 npm 不可用，
  // 不再去推导 npm 布局的 bin.js（真机日志里那一长串「bin.js missing」即由此而来）。
  const npmShim = npmShimRaw !== null && isDesktopInstallPath(npmShimRaw) ? null : npmShimRaw;
  if (npmShimRaw !== null && npmShim === null) {
    log.push(`npm: skipped ${npmShimRaw} (DSH Desktop install, not an npm global shim)`);
  }
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
  // 桌面端优先「node 直跑 bin.js」（同目录布局允许时）；否则才用 cmd + verbatim 命令行
  const desktopBinJs = desktopCmd === null ? null : desktopBinJsCandidate(desktopCmd);
  const desktopDirect = desktopBinJs !== null && exists(desktopBinJs);
  if (desktopBinJs !== null && !desktopDirect) log.push(`desktop: bin.js not found at ${desktopBinJs}, will use cmd wrapper`);

  const makeDesktop = (fellBack: boolean): LaunchResolution => desktopDirect
    ? {
        source: 'desktop', mode: 'node', executablePath: desktopBinJs as string,
        argsPrefix: [desktopBinJs as string],
        fellBack, reason: fellBack ? 'desktop via node bin.js (preferred npm unavailable)' : 'desktop via node bin.js',
        candidateLog: log, desktopRoot: desktopRootFromShim(desktopCmd as string) ?? undefined,
      }
    : {
        source: 'desktop', mode: 'cmd', executablePath: desktopCmd as string,
        argsPrefix: cmdScriptArgs(desktopCmd as string), verbatimCommandLine: true,
        fellBack, reason: fellBack ? 'desktop (preferred npm unavailable)' : 'desktop', candidateLog: log,
        desktopRoot: desktopRootFromShim(desktopCmd as string) ?? undefined,
      };

  // 3) 首选来源：auto 视为先 npm（与用户确认的规则一致）
  if (preference !== 'desktop' && npmOk) return makeNpm(false);
  if (preference === 'desktop' && desktopCmd !== null) return makeDesktop(false);

  // 4) 回退到另一种来源（用户确认：自动回退并在日志写明实际来源）
  if (npmOk) return makeNpm(true);
  if (desktopCmd !== null) return makeDesktop(true);

  // 5) 都不可用
  return null;
}
