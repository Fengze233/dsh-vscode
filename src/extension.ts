// src/extension.ts — 插件入口：装配各模块、注册命令、监听配置变更
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { initI18n, t } from './i18n';
import { readConfig, type DshConfig } from './config';
import { probeService } from './service/detect';
import { createProcessRunner, findInPath, findInPathPosix, resolveDshPackageJsonPath } from './service/process';
import { ServiceManager, type ManagerOptions } from './service/manager';
import { DshPanelProvider } from './panel/provider';
import { StatusBarController } from './statusbar';
import { resolveWorkspaceRoot } from './workspaceRoot';
import { createUrlResolver, handshakeTimeoutMs, bridgeEvalDelayMs, classifyRemote, toLocalhostUrl } from './remote';
import { createDshProxy, type DshProxy } from './service/proxy';
import {
  exchangeSession,
  getValidSession,
  dropSession,
  parseLaunchTarget,
  type SessionStore,
  type StoredSession,
} from './service/session';
import type { AuthUiState, PanelProviderUiOpts } from './panel/provider';
import {
  installBridge,
  uninstallBridge,
  createNodeFs,
  type BridgeInstallResult,
} from './bridge/installer';
import { cleanupAllImageCaches, cleanupStaleImageCaches } from './bridge/host';
import * as nodeFs from 'node:fs/promises';
import { evaluateBridgeStatus, bridgeWarningText } from './bridge/status';

let manager: ServiceManager | null = null;
let output: vscode.OutputChannel | null = null;
/** 本次会话捕获/提交的 DSH 启动网址（含一次性 token；供自动兑换与「浏览器打开/复制网址」使用） */
let latestLaunchUrl: string | null = null;
/** 用户浏览器可达地址解析器（activate 内装配；copyUrl/openExternal 命令使用） */
let resolveUserDisplayUrlImpl: (() => Promise<string | null>) | null = null;
/** 本地代办代理实例与就绪标志（activate 内装配；deactivate 时停止） */
let authProxy: DshProxy | null = null;
let authProxyStarted = false;

/** 日志缓冲（供「复制日志」命令 dsh.copyLogs 使用；上限行数防内存膨胀） */
const logBuffer: string[] = [];
/** 日志缓冲最大行数（超出后丢弃最早的行） */
const LOG_BUFFER_MAX = 5000;

/** 统一日志出口：加 HH:MM:SS 时间戳 → 写入输出通道 + 日志缓冲（复制日志命令的数据源） */
function appendLog(line: string): void {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const full = `[${ts}] ${line}`;
  logBuffer.push(full);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  output?.appendLine(full);
}

/** globalState 键：用户点击「不再提示」后置 true，持久静默桥接降级警告 */
const BRIDGE_SILENCE_KEY = 'dsh.bridgeWarningSilenced';

/** DshConfig → ManagerOptions（探测 3s、轮询 0.5s，与规格一致） */
function toManagerOptions(config: DshConfig): ManagerOptions {
  return {
    host: config.host,
    port: config.port,
    extraArgs: config.extraArgs,
    autoStart: config.autoStart,
    // 子进程工作目录兜底：按 dsh.workspaceRootIndex 解析工作区根目录，让 dsh web 以工作区为 cwd
    cwd: resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], config.workspaceRootIndex),
    executablePath: config.executablePath,
    openInBrowser: config.openInBrowser,
    timeoutMs: 3000,
    pollMs: 500,
  };
}

/**
 * 计算 npm 全局 node_modules 目录（Windows 且 dsh 可定位时）。
 *
 * 背景：Windows 下 VS Code 扩展宿主 spawn 的 dsh 进程对 profile 插件的 ESM 解析与普通命令行
 * 进程不同，profiles 双位置仍可能解析不到桥接包；而 npm 全局 node_modules
 * （AppData\Roaming\npm\node_modules）是确定可达的位置。本函数据此返回该目录作为第三安装目标。
 *
 * 规则（仅 win32）：
 * - 优先 config.executablePath（非空且不以 .js 结尾）→ dirname；
 * - 否则 findInPath('dsh.cmd', process.env.PATH) → dirname；
 * - 都找不到 → undefined（不传，保持双位置向后兼容）。
 * - 非 win32 → undefined。
 */
function resolveNpmGlobalNodeModules(config: DshConfig): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const exec = config.executablePath;
  if (exec && !exec.endsWith('.js')) {
    return dirname(exec);
  }
  const found = findInPath('dsh.cmd', process.env.PATH ?? '');
  if (found) {
    return dirname(found);
  }
  return undefined;
}

/**
 * 定位 dsh 可执行文件并读取其版本（跨平台）。
 * Windows：dsh.cmd → 推导 bin.js → 读包内 package.json；
 * Linux/macOS：PATH 找 dsh shim（或用户显式 executablePath）→ 解析符号链接/向上查找
 * 包内 package.json（resolveDshPackageJsonPath 处理 npm 全局布局）。
 * 用于环境信息头：问题报告据此核对 dsh 安装位置与版本，无需再追问用户环境。
 */
function describeDshExecutable(config: DshConfig): { path: string | null; version: string | null } {
  let shim: string | null = null;
  if (process.platform === 'win32') {
    // Windows：显式 executablePath 优先；否则 PATH 找 dsh.cmd
    shim = config.executablePath && !config.executablePath.endsWith('.js')
      ? config.executablePath
      : findInPath('dsh.cmd', process.env.PATH ?? '');
  } else {
    // 非 Windows：显式路径优先；否则在 PATH（':' 分隔）里找 dsh shim
    shim = config.executablePath && config.executablePath.length > 0
      ? config.executablePath
      : findInPathPosix('dsh', process.env.PATH);
  }
  if (shim !== null) {
    const pkgPath = resolveDshPackageJsonPath(shim, process.platform);
    if (pkgPath !== null) {
      try {
        const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
        if (typeof version === 'string' && version !== '') return { path: shim, version };
      } catch {
        /* 读取失败按版本未知处理 */
      }
    }
  }
  // 未定位到包（或读取失败）：保留可执行文件路径/命令名，版本标记未知
  return { path: shim ?? (process.platform === 'win32' ? null : 'dsh'), version: null };
}

/** 插件激活：VS Code 启动完成后调用 */
export function activate(context: vscode.ExtensionContext): void {
  // 语言规则：vscode.env.language 以 zh- 开头 → 中文，其余一律英文
  initI18n(vscode.env.language);
  output = vscode.window.createOutputChannel('DSH');

  const { config, errors } = readConfig();
  for (const err of errors) appendLog(`[config] ${err}`);

  // —— 环境信息头：版本/平台/可执行文件/关键配置，问题报告排查的第一手依据 ——
  appendLog('=== DSH 扩展环境信息 ===');
  appendLog(`扩展版本: ${context.extension.packageJSON.version}`);
  appendLog(`VS Code 版本: ${vscode.version}`);
  appendLog(`平台: ${process.platform} (${process.arch})`);
  const electronVersion = (process.versions as { electron?: string }).electron;
  appendLog(`宿主 Node: ${process.version}${electronVersion ? ` / Electron ${electronVersion}` : ''}`);
  const dshInfo = describeDshExecutable(config);
  appendLog(`dsh 可执行文件: ${dshInfo.path ?? '未定位'}`);
  appendLog(`dsh 版本: ${dshInfo.version ?? '未知'}`);
  appendLog(
    `配置: host=${config.host} port=${config.port} autoStart=${config.autoStart} stopOnExit=${config.stopOnExit} ` +
    `bridgeEnabled=${config.bridgeEnabled} extraArgs=${JSON.stringify(config.extraArgs)} ` +
    `executablePath=${config.executablePath || '(空)'}`,
  );
  appendLog(`工作区: ${vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join(', ') || '(无)'}`);
  appendLog('=============================');

  // —— 桥接状态（单一状态，两个面板共享，避免多个面板重复触发定时器）——
  // install：桥接安装结果；桥接禁用时为 null（不安装、不评估、不弹警告）。
  // handshakeOk：握手回执（onBridgeAck 写入）；undefined=尚未握手，true/false=握手成败。
  let install: BridgeInstallResult | null = null;
  let handshakeOk: boolean | undefined;
  let handshakeTimer: NodeJS.Timeout | undefined;
  let evalTimer: NodeJS.Timeout | undefined;
  let panelOpened = false; // 是否已有面板打开过（触发握手超时的前提之一）
  let warningShown = false; // 本次会话是否已弹过降级警告（防止重复弹）

  /** 桥接安装参数（dshHome / bridgeSourceDir 全插件共用，避免三处重复拼接；Windows 装配第三安装目标） */
  const installOpts = {
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    bridgeSourceDir: join(__dirname, 'bridge-client'),
    fs: createNodeFs(),
    npmGlobalNodeModules: resolveNpmGlobalNodeModules(config),
  };

  /**
   * 安全安装桥接：installBridge 的 IO 异常会直接抛出（Task 2 已知局限），
   * 此处 try/catch 捕获后按 degraded 处理（原因写入日志），绝不影响面板其它功能。
   */
  function safeInstallBridge(): BridgeInstallResult {
    try {
      return installBridge(installOpts);
    } catch (err) {
      appendLog(`[bridge] install failed: ${String(err)}`);
      return { status: 'degraded', reason: String(err) };
    }
  }

  // 激活时安装桥接：bridge.enabled=false 时不安装、不注入握手脚本、不评估、不弹警告
  if (config.bridgeEnabled) {
    install = safeInstallBridge();
  }

  /** 清除握手超时定时器（收到回执或重试时调用） */
  function clearHandshakeTimer(): void {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    }
  }

  /** 本次会话的握手超时（毫秒）：按远程分类动态取值（tunneled 15s / local·wsl 5s） */
  const handshakeTimeout = handshakeTimeoutMs(vscode.env.remoteName);

  /**
   * 启动握手超时（幂等）：面板已打开且服务已就绪、且尚未回执时，3 秒内无 bridgeAck 视为失败。
   * 服务未就绪时没有 iframe、握手不可能发生，因此不在此刻启动定时器，
   * 避免「服务启动慢」被误判为桥接降级；待 manager 进入 ready 后由 onChange 再触发。
   */
  function startHandshakeTimeout(): void {
    if (install === null) return; // 桥接被禁用：无握手脚本，不启动定时器
    if (handshakeOk !== undefined || handshakeTimer !== undefined) return;
    if (!panelOpened) return;
    if (manager?.getSnapshot().state !== 'ready') return;
    handshakeTimer = setTimeout(() => {
      handshakeTimer = undefined;
      // 超时窗内无任何 bridgeAck → 判定握手失败（degraded）；窗口按远程分类放宽（见 handshakeTimeoutMs）
      if (handshakeOk === undefined) {
        appendLog('[bridge] handshake timeout');
        handshakeOk = false;
        evaluateAndWarn(); // 握手刚失败，立即评估（不必再等固定延迟）
      }
    }, handshakeTimeout);
  }

  /** 面板握手回执回调（两个面板共享）：记录结果并取消超时（握手已发生，无论成败） */
  function onBridgeAck(ok: boolean, version?: string): void {
    // 日志带桥接版本：页面里跑的是哪个版本的桥接代码一目了然（排查“装了新版还在跑旧行为”用）
    appendLog(`[bridge] handshake ${ok ? 'ok' : 'failed'}${version ? ` (bridge v${version})` : ''}`);
    handshakeOk = ok;
    clearHandshakeTimer();
  }

  /** 任一面板首次打开：标记已打开并尝试启动握手超时（幂等，不重复建定时器） */
  function onPanelFirstOpen(): void {
    panelOpened = true;
    startHandshakeTimeout();
  }

  /**
   * 评估桥接状态并在 degraded 时弹警告。
   * 静默条件（任一为真则不弹）：设置项 dsh.bridge.silenceWarning、globalState 静默标志、
   * 或本次会话已弹过；安装/握手成功（ok / pending-restart）也不弹。
   */
  function evaluateAndWarn(): void {
    if (install === null) return; // 桥接被禁用，不评估
    const status = evaluateBridgeStatus(install, handshakeOk);
    if (status !== 'degraded') return;
    if (readConfig().config.silenceWarning) return; // 设置项静默
    if (context.globalState.get<boolean>(BRIDGE_SILENCE_KEY)) return; // 「不再提示」静默
    if (warningShown) return; // 本次会话已弹过
    warningShown = true;
    const text = bridgeWarningText(status);
    if (text === null) return; // 防御性兜底（degraded 必有文案）
    void vscode.window
      .showWarningMessage(t(text), t('bridge.retryNow'), t('bridge.neverAgain'))
      .then((choice) => {
        if (choice === t('bridge.retryNow')) {
          void retryBridge(); // 重试安装：重新 installBridge + 重启服务
        } else if (choice === t('bridge.neverAgain')) {
          void context.globalState.update(BRIDGE_SILENCE_KEY, true); // 不再提示
        }
      });
  }

  /** 调度一次桥接状态评估（可重复调用；重复调用会重置定时器，只保留最后一次） */
  function scheduleEvaluation(): void {
    if (evalTimer) clearTimeout(evalTimer);
    evalTimer = setTimeout(() => {
      evalTimer = undefined;
      evaluateAndWarn();
    }, bridgeEvalDelayMs(vscode.env.remoteName));
  }

  /** 重试安装桥接（命令 dsh.bridge.retry 与警告「重试安装」按钮共用） */
  async function retryBridge(): Promise<void> {
    try {
      if (!readConfig().config.bridgeEnabled) return; // 桥接被禁用：不重试
      // 重新安装（异常降级并记日志，不中断重试流程）
      install = safeInstallBridge();
      // 重置握手状态：重启后 iframe 重载会重新握手，onBridgeAck 会写入新结果
      handshakeOk = undefined;
      clearHandshakeTimer();
      // 清警告静默（globalState 标志），允许后续再次弹出降级警告
      await context.globalState.update(BRIDGE_SILENCE_KEY, false);
      warningShown = false;
      // 重启服务，触发面板 iframe 重载与重新握手
      await manager?.restart();
      // 重启后重新评估一次（留出握手回执时间）
      scheduleEvaluation();
    } catch (err) {
      // 重试失败只记日志：命令入口是 void 调用，异常不能成为未处理拒绝
      appendLog(`[bridge] retry failed: ${String(err)}`);
    }
  }

  /** 卸载桥接（命令 dsh.bridge.uninstall）：删除 profile 条目与目录，提示需重启 DSH 服务生效 */
  async function uninstallBridgeCmd(): Promise<void> {
    try {
      uninstallBridge(installOpts);
      void vscode.window.showInformationMessage(t('bridge.uninstalled'));
    } catch (err) {
      appendLog(`[bridge] uninstall failed: ${String(err)}`);
      void vscode.window.showWarningMessage(t('bridge.uninstallFailed', { message: String(err) }));
    }
  }

  // —— DSH ≥0.1.2 鉴权适配（方案 A）：会话状态 + 本地代办代理 + 面板三态驱动 ——
  // 会话状态机：'pending'（判定/兑换中）→ 'ok'（可进 iframe）/ 'needed'（外部服务需粘贴启动网址）。
  // 自启场景全自动：子进程 stdout 捕获启动网址 → 自动兑换 → 用户无感；
  // 外部启动场景：面板显示「需要登录」引导页，粘贴一次启动网址（30 天一次，见 authRequiredPage）。
  let authSessionState: AuthUiState = 'pending';
  let authBusy = false; // runAuthOnce 防并发
  /** 启动网址宽限已用标记：服务 HTTP 就绪早于 stdout 打印启动网址（dsh 在插件 boot 后才 announce），
   * 首次无网址时先 pending 等待 URL 到达，宽限后再无网址才判定为「外部启动」（避免 needed 闪现） */
  let launchGraceUsed = false;
  const panels: DshPanelProvider[] = [];

  /** 会话存储适配：VS Code globalState（按 authority 分条，支持多 DSH 实例）。
   * 写入为 fire-and-forget，但必须兜底 rejection——Memento 写入失败不应变成未处理拒绝。 */
  const sessionStore: SessionStore = {
    get: (key) => context.globalState.get<StoredSession>(key),
    set: (key, value) => void context.globalState.update(key, value).then(undefined, () => {}),
    delete: (key) => void context.globalState.update(key, undefined).then(undefined, () => {}),
  };

  /** 当前服务 authority（host:port；会话 cookie 与代理 Host 重写都以它为准） */
  function serviceAuthority(): string {
    const { host, port } = manager!.getTarget();
    return `${host}:${port}`;
  }

  /** 让两个面板按最新状态重渲染（会话/代理变化时调用） */
  function refreshPanels(): void {
    for (const p of panels) p.refresh();
  }

  /**
   * 确保本地代办代理已启动（幂等）。代理目标在每次请求时动态求值：
   * - 服务未就绪 → null（代理回 503，页面状态由 manager 驱动）；
   * - 服务就绪且有会话 → 带 cookie 转发（DSH ≥0.1.2）；
   * - 服务就绪但无会话（旧版 ≤0.1.1 无鉴权 / 会话意外丢失）→ 直通转发（不注入 cookie）。
   *   注意：旧版回归防线——无鉴权服务若走 503 会让整个面板不可用（此前直接内嵌可用），
   *   因此「无会话」绝不能 503，只能直通；0.1.2 场景若 cookie 丢失，代理会收到 401
   *   并触发 onAuthFailure 重新判定（见下），而不是让面板卡死。
   */
  function ensureProxyStarted(): void {
    if (authProxyStarted || manager === null) return;
    const proxy = createDshProxy({
      getTarget: () => {
        if (manager!.getSnapshot().state !== 'ready') return null;
        const { host, port } = manager!.getTarget();
        const session = getValidSession(`${host}:${port}`, { fetchImpl: fetch, store: sessionStore });
        return { url: `http://${host}:${port}`, cookie: session?.cookie };
      },
      // 上游 401（会话失效/凭据被重置）：丢弃会话并回到 pending → runAuthOnce 重判
      // （自启且有可用启动网址则自动重兑；外部服务则落到「需要登录」引导页，不永久卡 401）
      onAuthFailure: () => {
        if (authSessionState !== 'ok') return; // 防抖：只在 ok 状态下降级
        appendLog('[auth] 上游返回 401：会话失效，重新判定…');
        const { host, port } = manager!.getTarget();
        dropSession(`${host}:${port}`, { fetchImpl: fetch, store: sessionStore });
        authSessionState = 'pending';
        refreshPanels();
        setTimeout(() => void runAuthOnce(), 500);
      },
      log: (line) => appendLog(line),
    });
    authProxy = proxy;
    void proxy.start().then(() => {
      if (authProxy !== proxy) return; // 启动期间已被停用/替换：不置位、不刷新
      authProxyStarted = true;
      appendLog(`[proxy] 本地代办就绪 http://127.0.0.1:${proxy.port}`);
      refreshPanels();
    }).catch((err) => {
      // 代理启动失败（端口被占等罕见）：记日志并复位，下次会话判定/兑换时重试
      if (authProxy === proxy) authProxy = null;
      appendLog(`[proxy] 本地代办启动失败: ${String(err)}`);
    });
  }

  /**
   * 会话状态判定与（需要时）兑换，幂等（authBusy 防并发）：
   * 1. 存储里有未过期会话 → ok；
   * 2. 有启动网址且带 token（DSH ≥0.1.2）→ 兑换：成功 ok / 失败 needed（网址已随重启失效）；
   * 3. 有启动网址但无 token（≤0.1.1 无鉴权）→ ok（不需要会话）；
   * 4. 都没有（外部启动的 DSH）→ needed（面板显示登录引导页）。
   */
  async function runAuthOnce(): Promise<void> {
    if (authBusy) return;
    authBusy = true;
    try {
      const authority = serviceAuthority();
      if (getValidSession(authority, { fetchImpl: fetch, store: sessionStore }) !== undefined) {
        authSessionState = 'ok';
        ensureProxyStarted();
        refreshPanels();
        return;
      }
      const launch = latestLaunchUrl;
      if (launch !== null && parseLaunchTarget(launch) === null) {
        // 旧版 dsh（≤0.1.1）：启动网址无 token，无鉴权，直接可用
        appendLog('[auth] dsh 无浏览器鉴权（≤0.1.1），无需会话');
        authSessionState = 'ok';
      } else if (launch !== null) {
        const r = await exchangeSession(launch, { fetchImpl: fetch, store: sessionStore });
        if (r.status === 'ok') {
          appendLog(`[auth] 会话兑换成功（${r.authority}，有效期至 ${new Date(r.expiresAt).toLocaleString()}）`);
          authSessionState = 'ok';
        } else if (r.status === 'no-auth') {
          appendLog('[auth] dsh 无浏览器鉴权，无需会话');
          authSessionState = 'ok';
        } else {
          appendLog(`[auth] 启动网址兑换失败：${r.reason}`);
          authSessionState = 'needed'; // 网址已失效：面板引导用户粘贴最新启动网址
        }
      } else {
        if (!launchGraceUsed) {
          // stdout 的启动网址可能晚于 HTTP 就绪到达（dsh 全量插件 boot 后才 announce）：
          // 先保持 pending，宽限 2.5s 后重判——期间 URL 到达则自动兑换，仍未到才是外部启动
          launchGraceUsed = true;
          appendLog('[auth] 服务已就绪但启动网址尚未到达，等待 2.5s 后重判…');
          setTimeout(() => void runAuthOnce(), 2500);
          refreshPanels();
          return;
        }
        // 服务在运行且宽限已过仍无启动网址：外部启动的 DSH ≥0.1.2 → 面板显示登录引导
        appendLog('[auth] DSH 服务在运行但扩展没有会话（由外部启动）：面板将显示登录引导');
        authSessionState = 'needed';
      }
      ensureProxyStarted();
      refreshPanels();
    } catch (err) {
      // 兑换的网络级异常（瞬时断连等）：不能把面板卡在 pending；仅当服务仍就绪时延时重试
      appendLog(`[auth] 会话判定异常（3 秒后自动重试）: ${String(err)}`);
      if (manager?.getSnapshot().state === 'ready') {
        setTimeout(() => void runAuthOnce(), 3000);
      } else {
        refreshPanels(); // 服务已不在 ready：状态页由 manager 驱动，ready 时 onChange 会重触发
      }
    } finally {
      authBusy = false;
    }
  }

  /** 完成「手动登录成功」的统一收尾（no-auth 与裸地址探测共用） */
  function markAuthReady(launch: string, logLine: string): void {
    appendLog(logLine);
    latestLaunchUrl = launch;
    authSessionState = 'ok';
    ensureProxyStarted();
    refreshPanels();
  }

  /**
   * 「需要登录」引导页提交的网址：校验 → 兑换 → 反馈。
   * 接受两种输入：① DSH ≥0.1.2 的完整启动网址（带 ?token=…，兑换会话）；
   * ② ≤0.1.1 外部启动的裸地址（无 token：探测 200 即无鉴权服务，直接可用）。
   */
  async function handleAuthUrlSubmit(rawUrl: string): Promise<void> {
    try {
      // 容错：用户可能粘贴整行（带 dsh web: 前缀/尾部文本），取第一个 http(s) 网址段
      const m = /https?:\/\/[^\s]+/.exec(rawUrl);
      if (m === null) {
        void vscode.window.showErrorMessage(t('msg.authBadUrl'));
        return;
      }
      const launch = m[0];
      const target = serviceAuthority();
      let url: URL;
      try {
        url = new URL(launch);
      } catch {
        void vscode.window.showErrorMessage(t('msg.authBadUrl'));
        return;
      }
      if (url.hostname === '' || url.host === '') {
        void vscode.window.showErrorMessage(t('msg.authBadUrl'));
        return;
      }
      // host:port 必须与正在运行的服务一致（防止粘贴了另一台 DSH 的启动网址）
      if (url.host !== target) {
        void vscode.window.showWarningMessage(t('msg.authMismatch', { urlHost: url.host, targetHost: target }));
        return;
      }
      if (!url.searchParams.has('token')) {
        // 裸地址（≤0.1.1 外部启动的 dsh 打印无 token）：探测 200 = 无鉴权服务，直接可用；
        // 若返回 401 则说明服务带鉴权，必须提供完整启动网址
        try {
          const res = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
          if (res.status === 200) {
            markAuthReady(launch, '[auth] 裸地址探测为无鉴权 DSH（≤0.1.1），无需会话');
            return;
          }
        } catch {
          // 落到下方错误提示
        }
        void vscode.window.showErrorMessage(t('msg.authNeedToken'));
        return;
      }
      const r = await exchangeSession(launch, { fetchImpl: fetch, store: sessionStore });
      if (r.status === 'ok') {
        markAuthReady(launch, `[auth] 手动登录成功（${r.authority}，有效期至 ${new Date(r.expiresAt).toLocaleString()}）`);
        void vscode.window.showInformationMessage(t('msg.authOk'));
      } else if (r.status === 'no-auth') {
        markAuthReady(launch, '[auth] dsh 无浏览器鉴权，无需会话');
      } else {
        void vscode.window.showErrorMessage(t('msg.authRejected', { reason: r.reason }));
        refreshPanels(); // 保持 needed 引导页，用户可重试
      }
    } catch (err) {
      void vscode.window.showErrorMessage(t('msg.authRejected', { reason: String(err) }));
    }
  }

  /** 面板 UI 接线（会话三态 + 代理地址覆盖 + 登录提交回调） */
  const panelUi = (): PanelProviderUiOpts => ({
    authState: () => authSessionState,
    frameBaseOverride: () =>
      authProxyStarted && authSessionState === 'ok' && manager?.getSnapshot().state === 'ready' ? (authProxy?.baseUrl ?? null) : null,
    onAuthUrlSubmit: (url) => void handleAuthUrlSubmit(url),
  });

  /** 用户浏览器可打开的 DSH 地址：优先带 token 的启动网址（0.1.2 起浏览器需要它完成登录） */
  async function resolveUserDisplayUrl(): Promise<string | null> {
    const launch = latestLaunchUrl;
    if (launch === null) return null;
    const kind = classifyRemote(vscode.env.remoteName);
    if (kind === 'wsl') return toLocalhostUrl(launch);
    if (kind === 'tunneled') {
      if (!readConfig().config.remoteEnabled) return launch;
      try {
        return await resolveExternalUrl(launch);
      } catch {
        return launch;
      }
    }
    return launch;
  }
  resolveUserDisplayUrlImpl = resolveUserDisplayUrl;

  manager = new ServiceManager(toManagerOptions(config), {
    probeService,
    processRunner: createProcessRunner(),
    log: (line) => appendLog(line),
    // 端口被占用自动临时替换成功：弹窗告知用户新端口（仅本次会话，配置未变）
    onPortFallback: (requested, fallback) => {
      void vscode.window.showInformationMessage(t('msg.portFallback', { port: requested, fallback }));
    },
    // 捕获子进程 stdout 打印的启动网址（dsh web: http://…/?token=…）→ 自动会话兑换
    onLaunchUrl: (url) => {
      latestLaunchUrl = url;
      appendLog('[auth] 已捕获 DSH 启动网址（含登录 token），将自动完成登录');
      if (manager?.getSnapshot().state === 'ready') void runAuthOnce();
      // 未就绪：ready 的 onChange 里统一执行 runAuthOnce
    },
  });
  manager.setExitBehavior(!config.stopOnExit);

  // 工作区根目录解析：多根工作区按 dsh.workspaceRootIndex 取根（越界回退第一个）。
  // 该 getter 仅用于 provider 的文件相对路径解析（openFile 的 workspaceRoot 兜底基准）。
  const workspaceRootGetter = (): string | undefined =>
    resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], readConfig().config.workspaceRootIndex);
  // 桥接启用 getter：随时读取最新配置，供 readyPage 决定是否注入握手脚本
  const bridgeEnabledGetter = (): boolean => readConfig().config.bridgeEnabled;
  // 远程启用 getter：v0.3.0 由 dsh.remote.enabled 驱动（默认关闭，远程窗口不自动启动远端 dsh）
  const remoteEnabledGetter = (): boolean => readConfig().config.remoteEnabled;
  // 图片降级 getter：dsh.image.fallback 驱动桥接客户端「非视觉模型自动降级」行为
  const imageFallbackGetter = (): boolean => readConfig().config.imageFallback;
  // URL 解析器：远程窗口经 vscode.env.asExternalUri 建立端口隧道，返回本地可达 URL；本地原样返回
  const resolveExternalUrl = createUrlResolver({
    asExternalUri: async (uri) => await vscode.env.asExternalUri(vscode.Uri.parse(uri.toString())),
  });

  // 左右两侧各一个 provider 实例，共享同一 manager（服务状态一致）
  const panelPrimary = new DshPanelProvider(
    manager,
    () => {
      void showSecondaryGuideOnce(context); // 首次打开面板弹一次入口引导
      onPanelFirstOpen(); // 面板打开：标记并尝试启动握手超时
    },
    onBridgeAck, // onBridgeAck：桥接握手回执 → handshakeOk（Task 7 状态评估）
    workspaceRootGetter, // workspaceRoot：文件相对路径解析的兜底基准
    bridgeEnabledGetter, // bridgeEnabled：dsh.bridge.enabled 驱动握手脚本注入
    remoteEnabledGetter, // remoteEnabled：dsh.remote.enabled 驱动远程隧道（开启后才接线）
    resolveExternalUrl, // resolveExternalUrl：远程窗口的 URL 隧道解析
    imageFallbackGetter, // imageFallback：dsh.image.fallback 驱动图片降级
    panelUi(), // 会话三态 / 代理地址覆盖 / 登录提交（DSH ≥0.1.2 鉴权适配）
  );
  const panelSecondary = new DshPanelProvider(
    manager,
    onPanelFirstOpen, // 辅助侧边栏首次打开同样触发握手超时
    onBridgeAck,
    workspaceRootGetter,
    bridgeEnabledGetter,
    remoteEnabledGetter,
    resolveExternalUrl,
    imageFallbackGetter,
    panelUi(),
  );
  panels.push(panelPrimary, panelSecondary);
  new StatusBarController(manager);

  // 服务就绪后启动握手超时（若面板已打开）；并执行会话判定/兑换（自启自动、外部服务→登录引导页）
  manager.onChange((s) => {
    if (s.state === 'ready') {
      launchGraceUsed = false; // 新一轮服务：重置「启动网址宽限」，重新等待本轮 stdout URL
      startHandshakeTimeout(); // 服务就绪：若面板已打开，启动握手超时
      void runAuthOnce(); // 会话状态判定与自动兑换（幂等）
    }
  });

  context.subscriptions.push(
    // 第三参数：隐藏面板时保留 webview（iframe 不销毁、DSH 页面会话不丢）
    vscode.window.registerWebviewViewProvider('dsh.panel', panelPrimary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('dsh.panel.secondary', panelSecondary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.openPanel', () => openPanel()),
    vscode.commands.registerCommand('dsh.openSecondary', () => openSecondary(context)),
    vscode.commands.registerCommand('dsh.openFromTitle', () => openSecondary(context)),
    vscode.commands.registerCommand('dsh.openExternal', () => openExternal()),
    vscode.commands.registerCommand('dsh.restart', () => void manager?.restart()),
    vscode.commands.registerCommand('dsh.stop', () => void manager?.stop()),
    vscode.commands.registerCommand('dsh.copyUrl', () => copyUrl()),
    vscode.commands.registerCommand('dsh.showLogs', () => output?.show()),
    vscode.commands.registerCommand('dsh.copyLogs', () => copyLogs()),
    vscode.commands.registerCommand('dsh.bridge.retry', () => void retryBridge()),
    vscode.commands.registerCommand('dsh.bridge.uninstall', () => void uninstallBridgeCmd()),
    vscode.commands.registerCommand('dsh.cleanupImageCache', () => void cleanupImageCacheCmd()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dsh')) onConfigChanged();
    }),
    { dispose: () => manager?.dispose() },
  );

  // 激活后延迟评估一次桥接状态：degraded 且未静默时弹警告
  scheduleEvaluation();

  // 启动时扫地清理：上次会话（VS Code 已重启/面板已销毁）可能遗留的"孤儿"图片降级临时文件——
  // 它们不在内存注册表里（重启即丢失），只能按工作区目录扫描删除（仅限 dsh-imgcache-* 白名单命名）。
  {
    const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    void cleanupStaleImageCaches((d) => nodeFs.readdir(d), async (p: string) => { await nodeFs.unlink(p); }, roots).catch(() => {});
  }
}

/** 打开面板：聚焦视图（VS Code 自动打开视图所在的侧边栏，左/右皆可） */
async function openPanel(): Promise<void> {
  await vscode.commands.executeCommand('dsh.panel.focus');
}

/** 在外部浏览器打开 DSH 页面：DSH ≥0.1.2 时打开带一次性 token 的启动网址（浏览器首次访问完成登录） */
async function openExternal(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  const userUrl = (await resolveUserDisplayUrlImpl?.()) ?? s.url;
  await vscode.env.openExternal(vscode.Uri.parse(userUrl));
}

/** 复制 DSH 页面地址到剪贴板（优先带 token 的启动网址：外部浏览器打开即可完成登录） */
async function copyUrl(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  // 用户浏览器可访问地址：带 token 启动网址（经远程分类解析）优先；旧版回退原地址
  const display = (await resolveUserDisplayUrlImpl?.()) ?? s.url;
  await vscode.env.clipboard.writeText(display);
  void vscode.window.showInformationMessage(t('info.urlCopied', { url: display }));
}

/** 复制完整 DSH 日志（含环境信息头）到剪贴板：问题报告的提交内容 */
async function copyLogs(): Promise<void> {
  await vscode.env.clipboard.writeText(logBuffer.join('\n'));
  void vscode.window.showInformationMessage(t('msg.logsCopied'));
}

/** 一次性引导：告知 DSH 面板可通过左侧活动栏与右侧辅助侧边栏的图标打开 */
async function showSecondaryGuideOnce(context: vscode.ExtensionContext): Promise<void> {
  const KEY = 'dsh.secondaryGuideShown';
  if (context.globalState.get(KEY)) return;
  await vscode.window.showInformationMessage(t('guide.secondaryText'), t('guide.gotIt'));
  void context.globalState.update(KEY, true);
}

/** 在辅助侧边栏打开：新版 VS Code（≥1.91）直接聚焦右侧视图；旧版回退聚焦+引导 */
async function openSecondary(context: vscode.ExtensionContext): Promise<void> {
  const cmds = await vscode.commands.getCommands(true);
  // 视图声明在 package.json 里，VS Code 会自动生成 <viewId>.focus 命令；
  // 存在即说明当前版本支持辅助侧边栏容器（≥1.91）
  if (cmds.includes('dsh.panel.secondary.focus')) {
    await vscode.commands.executeCommand('dsh.panel.secondary.focus');
    return;
  }
  // 旧版回退：聚焦辅助侧边栏（命令 ID 因版本而异，取存在者）+ 一次性移动引导
  const focusId = cmds.includes('workbench.action.focusSecondarySideBar')
    ? 'workbench.action.focusSecondarySideBar'
    : 'workbench.action.focusAuxiliaryBar';
  await vscode.commands.executeCommand(focusId);
  await vscode.commands.executeCommand('dsh.panel.focus');
  await showSecondaryGuideOnce(context);
}

/** 手动清理命令：删除图片降级临时缓存（先按注册表删全部，再扫工作区根清理孤儿） */
async function cleanupImageCacheCmd(): Promise<void> {
  const fsDeps = { writeFile: async () => {}, rmFile: async (p: string) => { await nodeFs.unlink(p); } };
  try {
    await cleanupAllImageCaches(fsDeps);
  } catch {
    // 注册表清理失败不中断后续扫描
  }
  const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  let removed = 0;
  try {
    removed = await cleanupStaleImageCaches((d) => nodeFs.readdir(d), async (p: string) => { await nodeFs.unlink(p); }, roots);
  } catch {
    removed = 0;
  }
  void vscode.window.showInformationMessage(t('msg.imageCacheCleaned', { count: removed }));
}

/** 配置变更：host/port 变化时自动重启自启服务，退出策略实时生效 */
function onConfigChanged(): void {
  const m = manager;
  if (!m) return;
  const { config } = readConfig();
  void m.reconfigure(toManagerOptions(config));
  m.setExitBehavior(!config.stopOnExit);
}

/** 插件停用：按 stopOnExit 决定是否停止自启服务（只杀插件自启的） */
export async function deactivate(): Promise<void> {
  // v0.3.0：图片缓存兜底清理（关闭 VS Code/停用扩展时，页面 pagehide 不必然触发）
  try {
    await cleanupAllImageCaches({ writeFile: async () => {}, rmFile: async (p) => { await nodeFs.unlink(p); } });
  } catch {
    // 清理失败不影响停用流程
  }
  // 停用本地代办代理（无条件：覆盖 start() 仍在进行中的停用窗口；会话 cookie 保留在
  // globalState，下次激活继续有效）
  if (authProxy !== null) {
    const proxy = authProxy;
    authProxy = null;
    authProxyStarted = false;
    try {
      await proxy.stop();
    } catch {
      // 停用清理失败不影响扩展退出
    }
  }
  const config = readConfig().config;
  if (config.stopOnExit) await manager?.stop();
  manager?.dispose();
}
