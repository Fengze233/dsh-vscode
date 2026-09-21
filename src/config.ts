// src/config.ts — dsh.* 设置项读取与规范化
// 纯函数（normalizeConfig / isLoopbackHost）不依赖 vscode，可直接单测；
// readConfig 是 vscode 设置的薄封装，供 extension.ts 使用。
import * as vscode from 'vscode';

/** 用户可配置的原始值（可能缺失/非法） */
export interface RawDshConfig {
  host?: string;
  port?: number;
  autoStart?: boolean;
  stopOnExit?: boolean;
  extraArgs?: string[];
  /** 是否启用桥接（dsh.bridge.enabled） */
  bridgeEnabled?: boolean;
  /** 多根工作区取第几个根目录（dsh.workspaceRootIndex） */
  workspaceRootIndex?: number;
  /** 是否抑制桥接警告（dsh.bridge.silenceWarning） */
  silenceWarning?: boolean;
  /** dsh 可执行文件绝对路径（空串 = 用 PATH 里的 dsh） */
  executablePath?: string;
  /** 是否在启动 dsh web 时允许打开浏览器（默认 false，即默认追加 --no-open） */
  openInBrowser?: boolean;
  /** 是否启用 SSH Remote 等远程场景（在远端运行 dsh 并建立隧道；默认关闭） */
  remoteEnabled?: boolean;
  /** 模型无视觉能力时是否自动把图片降级为文本+路径转发（默认开启） */
  imageFallback?: boolean;
  /** 是否自动跟随当前文件注入上下文（dsh.context.autoFollow） */
  autoFollow?: boolean;
  /** 自动跟随防抖毫秒（dsh.context.followDebounceMs） */
  followDebounceMs?: number;
  /** 等待 dsh web 就绪的总超时毫秒（dsh.startTimeoutMs） */
  startTimeoutMs?: number;
  /** 注入 DSH 子进程的额外环境变量（dsh.env） */
  env?: Record<string, string>;
  /** 是否自动为子进程追加 Node 的 --use-env-proxy（dsh.useEnvProxy） */
  useEnvProxy?: boolean;
  /** 面板内网页缩放档位（dsh.panel.zoomLevel，issue #8） */
  panelZoomLevel?: number;
}

/** 规范化后的配置（均有合法默认值） */
export interface DshConfig {
  host: string;
  port: number;
  autoStart: boolean;
  stopOnExit: boolean;
  extraArgs: string[];
  /** 是否启用桥接（dsh.bridge.enabled） */
  bridgeEnabled: boolean;
  /** 多根工作区取第几个根目录（dsh.workspaceRootIndex） */
  workspaceRootIndex: number;
  /** 是否抑制桥接警告（dsh.bridge.silenceWarning） */
  silenceWarning: boolean;
  /** dsh 可执行文件绝对路径（空串 = 用 PATH 里的 dsh） */
  executablePath: string;
  /** 是否允许 dsh web 启动时打开浏览器（true=不追加 --no-open） */
  openInBrowser: boolean;
  /** 是否启用远程（SSH Remote/WSL/Dev Container/Codespaces）隧道支持 */
  remoteEnabled: boolean;
  /** 非视觉模型下发图自动降级为文本+路径转发 */
  imageFallback: boolean;
  /** 是否自动跟随当前文件注入上下文（dsh.context.autoFollow） */
  autoFollow: boolean;
  /** 自动跟随防抖毫秒（dsh.context.followDebounceMs） */
  followDebounceMs: number;
  /** 等待 dsh web 就绪的总超时毫秒（dsh.startTimeoutMs） */
  startTimeoutMs: number;
  /** 注入 DSH 子进程的额外环境变量（dsh.env；未配置为空对象） */
  env: Record<string, string>;
  /** 是否自动为子进程追加 --use-env-proxy（dsh.useEnvProxy） */
  useEnvProxy: boolean;
  /** 面板内网页缩放档位（dsh.panel.zoomLevel） */
  panelZoomLevel: number;
}

/** 默认配置 */
export const DEFAULTS: DshConfig = {
  host: '127.0.0.1',
  port: 3080,
  autoStart: true,
  stopOnExit: true,
  extraArgs: [],
  bridgeEnabled: true,
  workspaceRootIndex: 0,
  silenceWarning: false,
  executablePath: '',
  openInBrowser: false,
  remoteEnabled: false,
  imageFallback: true,
  autoFollow: false,
  followDebounceMs: 800,
  // 启动总超时：默认 45s。Windows 冷启动（插件多、磁盘慢）实测可达 17–23s，
  // 旧的 15s 硬编码会让服务其实已起来却报「未就绪」（issue #23）。
  startTimeoutMs: 45000,
  // 子进程额外环境变量：默认空（保持原有的"直接继承父进程环境"行为）
  env: {},
  // 是否自动追加 --use-env-proxy：默认关，避免改变任何现有用户的行为（issue #18）
  useEnvProxy: false,
  // 面板缩放：默认 1（= 当前行为，零变化）
  panelZoomLevel: 1,
};

/** 面板缩放允许的档位（issue #8）：只提供"缩小"方向。
 *  原因（真机几何实测）：放大方向（zoom > 1）时 iframe 的逻辑视口会大于面板物理尺寸，
 *  内容右/下必然留白；而该 issue 的真实诉求是"侧边栏里字太大"，缩小方向可做到
 *  完美铺满、无滚动条、点击命中正常。 */
export const PANEL_ZOOM_LEVELS = [0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;

/** 启动超时允许的下限（毫秒）：低于 5s 对真实 DSH 冷启动没有意义 */
export const MIN_START_TIMEOUT_MS = 5000;
/** 启动超时允许的上限（毫秒）：超过 10 分钟视为配置错误 */
export const MAX_START_TIMEOUT_MS = 600000;

/** 安全边界：仅允许回环地址 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 判断是否为回环地址 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * 规范化原始配置：非法值回退默认并记录错误描述
 * （安全规则：host 只允许回环地址，端口必须为 0..65535 的整数）
 */
export function normalizeConfig(raw: RawDshConfig): { config: DshConfig; errors: string[] } {
  const errors: string[] = [];

  // 缺失与非法需区分：字段未配置时静默回退默认（不算错误），
  // 只有提供了非法值才记录错误并回退默认。
  let host: string;
  if (typeof raw.host !== 'string') {
    host = DEFAULTS.host;
  } else {
    host = raw.host.trim();
    if (!isLoopbackHost(host)) {
      errors.push(`dsh.host must be a loopback address, got ${JSON.stringify(raw.host)}`);
      host = DEFAULTS.host;
    }
  }

  let port = raw.port;
  if (port === undefined) {
    port = DEFAULTS.port;
  } else if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push(`dsh.port must be an integer in 0..65535, got ${JSON.stringify(raw.port)}`);
    port = DEFAULTS.port;
  }

  const autoStart = typeof raw.autoStart === 'boolean' ? raw.autoStart : DEFAULTS.autoStart;
  const stopOnExit = typeof raw.stopOnExit === 'boolean' ? raw.stopOnExit : DEFAULTS.stopOnExit;
  const extraArgs = Array.isArray(raw.extraArgs)
    ? raw.extraArgs.filter((a): a is string => typeof a === 'string')
    : DEFAULTS.extraArgs;

  // 布尔设置沿用 autoStart 的缺省处理模式：仅接受布尔值，否则回退默认（不记错误）
  const bridgeEnabled = typeof raw.bridgeEnabled === 'boolean' ? raw.bridgeEnabled : DEFAULTS.bridgeEnabled;
  const silenceWarning = typeof raw.silenceWarning === 'boolean' ? raw.silenceWarning : DEFAULTS.silenceWarning;

  // workspaceRootIndex：必须为非负整数，非法值回退默认并记录错误
  let workspaceRootIndex: number;
  if (raw.workspaceRootIndex === undefined) {
    workspaceRootIndex = DEFAULTS.workspaceRootIndex;
  } else if (
    typeof raw.workspaceRootIndex !== 'number' ||
    !Number.isInteger(raw.workspaceRootIndex) ||
    raw.workspaceRootIndex < 0
  ) {
    errors.push(`dsh.workspaceRootIndex must be a non-negative integer, got ${JSON.stringify(raw.workspaceRootIndex)}`);
    workspaceRootIndex = DEFAULTS.workspaceRootIndex;
  } else {
    workspaceRootIndex = raw.workspaceRootIndex;
  }

  // executablePath：非字符串静默回退默认 ''；空字符串合法（表示用 PATH 里的 dsh）
  const executablePath = typeof raw.executablePath === 'string' ? raw.executablePath : DEFAULTS.executablePath;

  // v0.3.0 新布尔设置：沿用 bridgeEnabled 的缺省处理——仅接受布尔，否则回退默认（不记错误）
  const openInBrowser = typeof raw.openInBrowser === 'boolean' ? raw.openInBrowser : DEFAULTS.openInBrowser;
  const remoteEnabled = typeof raw.remoteEnabled === 'boolean' ? raw.remoteEnabled : DEFAULTS.remoteEnabled;
  const imageFallback = typeof raw.imageFallback === 'boolean' ? raw.imageFallback : DEFAULTS.imageFallback;

  // 自动跟随开关：布尔设置沿用 autoStart 的缺省处理（非法静默回退）
  const autoFollow = typeof raw.autoFollow === 'boolean' ? raw.autoFollow : DEFAULTS.autoFollow;

  // followDebounceMs：300..5000 整数，非法回退默认并记录错误
  let followDebounceMs: number;
  if (raw.followDebounceMs === undefined) {
    followDebounceMs = DEFAULTS.followDebounceMs;
  } else if (
    typeof raw.followDebounceMs !== 'number' ||
    !Number.isInteger(raw.followDebounceMs) ||
    raw.followDebounceMs < 300 ||
    raw.followDebounceMs > 5000
  ) {
    errors.push(`dsh.context.followDebounceMs must be an integer in 300..5000, got ${JSON.stringify(raw.followDebounceMs)}`);
    followDebounceMs = DEFAULTS.followDebounceMs;
  } else {
    followDebounceMs = raw.followDebounceMs;
  }

  // startTimeoutMs：5000..600000 整数，非法回退默认并记录错误（issue #23）
  let startTimeoutMs: number;
  if (raw.startTimeoutMs === undefined) {
    startTimeoutMs = DEFAULTS.startTimeoutMs;
  } else if (
    typeof raw.startTimeoutMs !== 'number' ||
    !Number.isInteger(raw.startTimeoutMs) ||
    raw.startTimeoutMs < MIN_START_TIMEOUT_MS ||
    raw.startTimeoutMs > MAX_START_TIMEOUT_MS
  ) {
    errors.push(
      `dsh.startTimeoutMs must be an integer in ${MIN_START_TIMEOUT_MS}..${MAX_START_TIMEOUT_MS}, got ${JSON.stringify(raw.startTimeoutMs)}`,
    );
    startTimeoutMs = DEFAULTS.startTimeoutMs;
  } else {
    startTimeoutMs = raw.startTimeoutMs;
  }

  // env（dsh.env）：只接受「键与值都是非空字符串」的条目；非法条目跳过并记录错误。
  // 键名不得含 '=' 或 NUL（Node 对 env 键的要求），否则 spawn 行为未定义。
  const env: Record<string, string> = {};
  if (raw.env !== undefined) {
    if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
      errors.push(`dsh.env must be an object of string values, got ${JSON.stringify(raw.env)}`);
    } else {
      for (const [k, v] of Object.entries(raw.env)) {
        if (k === '' || k.includes('=') || k.includes('\0') || typeof v !== 'string') {
          errors.push(`dsh.env entry ignored (key/value must be non-empty strings): ${JSON.stringify(k)}`);
          continue;
        }
        env[k] = v;
      }
    }
  }

  // useEnvProxy（dsh.useEnvProxy）：布尔设置沿用既有缺省处理（非法静默回退）
  const useEnvProxy = typeof raw.useEnvProxy === 'boolean' ? raw.useEnvProxy : DEFAULTS.useEnvProxy;

  // panelZoomLevel（dsh.panel.zoomLevel）：只接受预设档位，非档位值回退默认并记录错误
  // （手改 settings.json 可能写入任意数字，故此处做白名单校验）
  let panelZoomLevel: number;
  if (raw.panelZoomLevel === undefined) {
    panelZoomLevel = DEFAULTS.panelZoomLevel;
  } else if (!(PANEL_ZOOM_LEVELS as readonly number[]).includes(raw.panelZoomLevel)) {
    errors.push(
      `dsh.panel.zoomLevel must be one of ${PANEL_ZOOM_LEVELS.join(', ')}, got ${JSON.stringify(raw.panelZoomLevel)}`,
    );
    panelZoomLevel = DEFAULTS.panelZoomLevel;
  } else {
    panelZoomLevel = raw.panelZoomLevel;
  }

  return {
    config: {
      host, port, autoStart, stopOnExit, extraArgs, bridgeEnabled, workspaceRootIndex,
      silenceWarning, executablePath, openInBrowser, remoteEnabled, imageFallback,
      autoFollow, followDebounceMs, startTimeoutMs, env, useEnvProxy, panelZoomLevel,
    },
    errors,
  };
}

/**
 * 计算注入 DSH 子进程的最终环境变量（纯函数，便于单测）。
 *
 * 语义（issue #18）：
 * - 以 dsh.env 为基础；
 * - useEnvProxy=true 时确保 NODE_OPTIONS 含 `--use-env-proxy`（Node 原生 fetch 才会读
 *   HTTP(S)_PROXY；实测不带该参数时环境变量被完全忽略），已存在则不重复追加、也不覆盖
 *   用户原有的其它 NODE_OPTIONS 选项。
 */
export function buildChildEnv(
  env: Record<string, string>,
  useEnvProxy: boolean,
): Record<string, string> {
  const out: Record<string, string> = { ...env };
  if (!useEnvProxy) return out;
  const flag = '--use-env-proxy';
  const existing = (out.NODE_OPTIONS ?? '').trim();
  if (existing.split(/\s+/).includes(flag)) return out;
  out.NODE_OPTIONS = existing === '' ? flag : `${existing} ${flag}`;
  return out;
}

/** 从 VS Code 设置读取（薄封装，供 extension.ts 使用） */
export function readConfig(): { config: DshConfig; errors: string[] } {
  const ws = vscode.workspace.getConfiguration('dsh');
  return normalizeConfig({
    host: ws.get<string>('host'),
    port: ws.get<number>('port'),
    autoStart: ws.get<boolean>('autoStart'),
    stopOnExit: ws.get<boolean>('stopOnExit'),
    extraArgs: ws.get<string[]>('extraArgs'),
    bridgeEnabled: ws.get<boolean>('bridge.enabled'),
    workspaceRootIndex: ws.get<number>('workspaceRootIndex'),
    silenceWarning: ws.get<boolean>('bridge.silenceWarning'),
    executablePath: ws.get<string>('executablePath'),
    openInBrowser: ws.get<boolean>('openInBrowser'),
    remoteEnabled: ws.get<boolean>('remote.enabled'),
    imageFallback: ws.get<boolean>('image.fallback'),
    autoFollow: ws.get<boolean>('context.autoFollow'),
    followDebounceMs: ws.get<number>('context.followDebounceMs'),
    startTimeoutMs: ws.get<number>('startTimeoutMs'),
    env: ws.get<Record<string, string>>('env'),
    useEnvProxy: ws.get<boolean>('useEnvProxy'),
    panelZoomLevel: ws.get<number>('panel.zoomLevel'),
  });
}
