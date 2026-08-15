// src/panel/provider.ts — 侧边栏面板：iframe 与占位页切换
import * as vscode from 'vscode';
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
  /** 握手 token：面板与 iframe 之间的防伪凭据（每实例随机，Task 5 下行同步复用同一 token） */
  private readonly bridgeToken = Math.random().toString(36).slice(2) + Date.now().toString(36);

  /**
   * @param manager 服务管理器（面板与服务状态联动）
   * @param onFirstOpen 面板首次打开时调用一次的回调（用于引导提示，由入口注入）
   * @param onBridgeAck 桥接握手回执回调（Task 7 评估桥接状态时注入；可选）
   * @param workspaceRoot 工作区根目录注入函数（Task 5 工作区同步使用；可选，默认无根）
   */
  constructor(
    private manager: ServiceManager,
    private onFirstOpen?: () => void,
    private onBridgeAck?: (ok: boolean) => void,
    private workspaceRoot: () => string | undefined = () => undefined,
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
    // 面板打开即确保服务运行：复用已有或自动启动
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
          workspaceRoot: this.workspaceRoot(), // 见 Task 5 的 resolveWorkspaceRoot 结果
        });
        break;
      case 'bridgeAck':
        // 握手回执：通知注入的回调（Task 7 据此评估桥接状态）
        this.onBridgeAck?.(msg.ok);
        break;
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
          enabled: true, // Task 6 引入 bridgeEnabled 设置后改由配置驱动
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
