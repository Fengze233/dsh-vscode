// src/extension.ts — 插件入口：装配各模块、注册命令、监听配置变更
import * as vscode from 'vscode';
import { initI18n, t } from './i18n';
import { readConfig, type DshConfig } from './config';
import { probeService } from './service/detect';
import { createProcessRunner } from './service/process';
import { ServiceManager, type ManagerOptions } from './service/manager';
import { DshPanelProvider } from './panel/provider';
import { StatusBarController } from './statusbar';
import { createDshApiClient } from './bridge/api';
import { resolveWorkspaceRoot, syncWorkspace } from './bridge/sync';

let manager: ServiceManager | null = null;
let output: vscode.OutputChannel | null = null;
/** 最近一次工作区同步成功的根目录（供服务就绪先于面板创建时补发下行同步） */
let lastSyncedRoot: string | undefined;

/** DshConfig → ManagerOptions（探测 3s、轮询 0.5s，与规格一致） */
function toManagerOptions(config: DshConfig): ManagerOptions {
  return {
    host: config.host,
    port: config.port,
    extraArgs: config.extraArgs,
    autoStart: config.autoStart,
    // 子进程工作目录兜底：按 dsh.workspaceRootIndex 解析工作区根目录，让 dsh web 以工作区为 cwd
    cwd: resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], config.workspaceRootIndex),
    timeoutMs: 3000,
    pollMs: 500,
  };
}

/** 插件激活：VS Code 启动完成后调用 */
export function activate(context: vscode.ExtensionContext): void {
  // 语言规则：vscode.env.language 以 zh- 开头 → 中文，其余一律英文
  initI18n(vscode.env.language);
  output = vscode.window.createOutputChannel('DSH');
  lastSyncedRoot = undefined; // 重置上次同步记录（activate 理论上只调用一次，此处防御性初始化）

  const { config, errors } = readConfig();
  for (const err of errors) output?.appendLine(`[config] ${err}`);

  manager = new ServiceManager(toManagerOptions(config), {
    probeService,
    processRunner: createProcessRunner(),
    log: (line) => output?.appendLine(line),
  });
  manager.setExitBehavior(!config.stopOnExit);

  // 工作区根目录解析：多根工作区按 dsh.workspaceRootIndex 取根（越界回退第一个）。
  const workspaceRootGetter = (): string | undefined =>
    resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], readConfig().config.workspaceRootIndex);
  // 待补发路径 getter：syncOnce 成功后更新 lastSyncedRoot，面板晚于服务就绪创建时据此补发下行同步
  const pendingSyncPath = (): string | undefined => lastSyncedRoot;

  // 左右两侧各一个 provider 实例，共享同一 manager（服务状态一致）
  const panelPrimary = new DshPanelProvider(
    manager,
    () => {
      void showSecondaryGuideOnce(context); // 首次打开面板弹一次入口引导
    },
    undefined, // onBridgeAck：Task 7 注入桥接状态评估回调
    workspaceRootGetter, // workspaceRoot：文件相对路径解析的兜底基准
    pendingSyncPath, // pendingSyncPath：服务就绪先于面板创建时补发同步
  );
  const panelSecondary = new DshPanelProvider(
    manager,
    undefined,
    undefined,
    workspaceRootGetter,
    pendingSyncPath,
  );
  new StatusBarController(manager);

  // 服务就绪后首次触发一次工作区同步（幂等：list 命中复用，否则 create）
  let syncedOnce = false;
  manager.onChange((s) => {
    if (s.state === 'ready' && !syncedOnce) {
      syncedOnce = true;
      void syncOnce();
    }
  });

  /** 工作区同步主流程：解析根目录 → 幂等 syncWorkspace → 通知两个面板下发 */
  async function syncOnce(): Promise<void> {
    const root = workspaceRootGetter();
    if (root === undefined) return; // 无工作区（空窗口）不同步
    try {
      const snap = manager?.getSnapshot();
      if (!snap?.url) return; // ready 状态必有 url，此处防御性兜底
      // 幂等同步：list 命中复用，否则 create（Task 3 的 DSH API 信封客户端）
      await syncWorkspace(createDshApiClient(snap.url), root);
      lastSyncedRoot = root; // 成功后记录，供后续创建的面板补发
      // 通知两个面板下发 syncWorkspace（view 未创建时 postMessage 静默忽略，由 resolveWebviewView 补发）
      panelPrimary.notifySyncWorkspace(root);
      panelSecondary.notifySyncWorkspace(root);
    } catch (err) {
      // 同步失败只记日志，不打断面板与桥接其余功能
      output?.appendLine(`[bridge] sync workspace failed: ${String(err)}`);
    }
  }

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
    vscode.commands.registerCommand('dsh.openExternal', () => openExternal()),
    vscode.commands.registerCommand('dsh.restart', () => void manager?.restart()),
    vscode.commands.registerCommand('dsh.stop', () => void manager?.stop()),
    vscode.commands.registerCommand('dsh.copyUrl', () => copyUrl()),
    vscode.commands.registerCommand('dsh.showLogs', () => output?.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dsh')) onConfigChanged();
    }),
    { dispose: () => manager?.dispose() },
  );
}

/** 打开面板：聚焦视图（VS Code 自动打开视图所在的侧边栏，左/右皆可） */
async function openPanel(): Promise<void> {
  await vscode.commands.executeCommand('dsh.panel.focus');
}

/** 在外部浏览器打开 DSH 页面 */
async function openExternal(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(s.url));
}

/** 复制 DSH 页面地址到剪贴板 */
async function copyUrl(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  await vscode.env.clipboard.writeText(s.url);
  void vscode.window.showInformationMessage(t('info.urlCopied', { url: s.url }));
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
  const config = readConfig().config;
  if (config.stopOnExit) await manager?.stop();
  manager?.dispose();
}
