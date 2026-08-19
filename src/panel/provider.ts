// src/panel/provider.ts — 侧边栏面板：iframe 与占位页切换
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ServiceManager } from '../service/manager';
import { handleBridgeMessage } from '../bridge/host';
import { t } from '../i18n';
import {
  loadingPage,
  errorPage,
  disconnectedPage,
  stoppedPage,
  readyPage,
  type PanelMessage,
  type PageCtx,
} from './html';

export class DshPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  /** 曾处于 ready：用于区分"服务断开"与"手动停止"两种占位页 */
  private wasConnected = false;
  /** 面板是否已首次打开过（用于一次性回调） */
  private openedOnce = false;
  /** 桥接握手 token：一次性防伪凭据，用密码学随机数（不可预测） */
  private readonly bridgeToken = randomUUID();

  /**
   * @param manager 服务管理器（面板与服务状态联动）
   * @param onFirstOpen 面板首次打开时调用一次的回调（用于引导提示，由入口注入）
   * @param onBridgeAck 桥接握手回执回调（Task 7 评估桥接状态时注入；可选）
   * @param workspaceRoot 工作区根目录注入函数（openFile 相对路径解析的兜底基准；可选，默认无根）
   * @param bridgeEnabled 桥接是否启用的 getter（Task 7 由 dsh.bridge.enabled 配置驱动；默认启用，
   *   disabled 时不注入握手脚本，避免向未安装桥接的 DSH 页面发送无意义的握手）
   */
  constructor(
    private manager: ServiceManager,
    private onFirstOpen?: () => void,
    private onBridgeAck?: (ok: boolean) => void,
    private workspaceRoot: () => string | undefined = () => undefined,
    private bridgeEnabled: () => boolean = () => true,
  ) {
    // 订阅状态变化，重绘面板（iframe 与占位页由状态驱动，无白屏路径）
    manager.onChange(() => this.render());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // enableScripts 允许占位页的内联按钮脚本（nonce 放行）运行。
    // 注意：retainContextWhenHidden 不在这里设置——它不是 WebviewOptions 字段，
    // 由 Task 10 注册视图时通过第三参数传入（隐藏面板时保留 iframe 会话）。
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: PanelMessage) => this.onMessage(msg));
    if (!this.openedOnce) {
      this.openedOnce = true;
      this.onFirstOpen?.(); // 首次打开：触发一次性引导（如"移到右侧栏"提示）
    }
    this.render();
    // 面板打开即确保服务运行：复用已有或自动启动。
    void this.manager.ensureRunning();
  }

  /** 处理面板内按钮消息（全部转交给 manager 或对应命令） */
  private onMessage(msg: PanelMessage): void {
    switch (msg.type) {
      case 'retry':
      case 'reconnect':
        void this.manager.ensureRunning();
        break;
      case 'restart':
        void this.manager.restart();
        break;
      case 'stop':
        this.wasConnected = false;
        void this.manager.stop();
        break;
      case 'openExternal':
        void vscode.commands.executeCommand('dsh.openExternal');
        break;
      case 'copyUrl':
        void vscode.commands.executeCommand('dsh.copyUrl');
        break;
      case 'showLogs':
        void vscode.commands.executeCommand('dsh.showLogs');
        break;
      case 'bridgeCopyText':
        // 桥接剪贴板消息：VS Code 会拦截跨源 iframe 的原生 clipboard API，
        // 这里由扩展宿主写系统剪贴板，并回执给 iframe 收尾其 writeText Promise。
        void this.copyTextToClipboard(msg);
        break;
      case 'bridgeReadText':
        // 剪贴板读取：扩展宿主读系统剪贴板（无 webview 权限限制），
        // 回执给 iframe 供其 Cmd+V 粘贴兜底使用。
        void this.readTextFromClipboard(msg);
        break;
      case 'bridgeOpenExternal':
      case 'bridgeOpenFile':
        // 桥接跳转消息统一走 host 的 handleBridgeMessage（内部分流外链/文件，做白名单与路径解析）
        void handleBridgeMessage(msg, {
          openExternal: (u) => vscode.env.openExternal(vscode.Uri.parse(u)),
          // showTextDocument 返回 TextEditor，而依赖约定返回 Thenable<void>：用 async 包装丢弃返回值
          openTextDocument: async (p) => {
            await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false });
          },
          // 用户提示统一走 vscode.window.showWarningMessage（host 层不 import vscode，保持纯逻辑可单测）
          showWarning: (m) => void vscode.window.showWarningMessage(m),
          workspaceRoot: this.workspaceRoot(), // 工作区根目录：openFile 相对路径解析的兜底基准
        });
        break;
      case 'bridgeAck':
        // 握手回执：通知注入的回调（Task 7 据此评估桥接状态）
        this.onBridgeAck?.(msg.ok);
        break;
    }
  }

  /** 剪贴板桥接：扩展宿主写系统剪贴板，完成后回执给 webview（由顶层脚本转发给 iframe） */
  private async copyTextToClipboard(msg: Extract<PanelMessage, { type: 'bridgeCopyText' }>): Promise<void> {
    let ok = false;
    try {
      await vscode.env.clipboard.writeText(msg.text);
      ok = true;
    } catch {
      // 写剪贴板失败：回执 ok=false，iframe 侧会 reject writeText，
      // DSH 会继续走自己的 execCommand('copy') 回退路径。
    }
    try {
      await this.view?.webview.postMessage({ type: 'bridgeCopyTextAck', requestId: msg.requestId, ok });
    } catch {
      // 面板可能已隐藏/销毁，回执发不出去也不影响扩展其它功能。
    }
  }

  /** 剪贴板桥接：扩展宿主读系统剪贴板，完成后回执给 webview（由顶层脚本转发给 iframe） */
  private async readTextFromClipboard(msg: Extract<PanelMessage, { type: 'bridgeReadText' }>): Promise<void> {
    let ok = false;
    let text: string | undefined;
    try {
      // 读取失败或内容为空时都回执 ok=false，iframe 侧放弃本次粘贴
      text = await vscode.env.clipboard.readText();
      ok = typeof text === 'string' && text !== '';
    } catch {
      // 读剪贴板失败（如系统无剪贴板权限）：回执 ok=false，iframe 侧静默放弃
    }
    try {
      await this.view?.webview.postMessage({
        type: 'bridgeReadTextAck',
        requestId: msg.requestId,
        ok,
        text,
      });
    } catch {
      // 面板可能已隐藏/销毁，回执发不出去也不影响扩展其它功能。
    }
  }

  /** 按服务状态渲染对应页面 */
  private render(): void {
    const v = this.view;
    if (!v) return;
    const nonce = Math.random().toString(36).slice(2);
    const { host, port } = this.manager.getTarget();
    const ctx: PageCtx = { nonce, cspSource: v.webview.cspSource, frameHosts: [`http://${host}:${port}`] };
    const s = this.manager.getSnapshot();
    let html: string;
    switch (s.state) {
      case 'ready':
        this.wasConnected = true;
        html = readyPage(s.url ?? `http://${host}:${port}/`, ctx, {
          token: this.bridgeToken,
          enabled: this.bridgeEnabled(), // 由 dsh.bridge.enabled 配置驱动（Task 7 接入）
        });
        break;
      case 'failed':
        html = errorPage(t, ctx, s.error ? t(s.error, s.errorVars) : t('err.loadFailed'));
        break;
      case 'idle':
        html = this.wasConnected ? disconnectedPage(t, ctx) : stoppedPage(t, ctx);
        break;
      default:
        // detecting / starting / waiting / stopping：统一加载中动画页
        html = loadingPage(t, ctx);
    }
    v.webview.html = html;
  }
}
