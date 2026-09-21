// src/context/controller.ts — 上下文能力协调层(纯逻辑,vscode 触点依赖注入)
import { createDshApi, DshApiError, type DshApi } from './dshApi';
import { describeFileRef } from './tracker';
import { injectContext, injectQuestion, injectText, buildSelectionMessage } from './injector';
import type { ServiceSnapshot } from '../service/manager';
import type { MsgKey } from '../i18n';

export interface ControllerMessages {
  t(key: MsgKey, vars?: Record<string, string | number>): string;
  showInformation(msg: string): void;
  showWarning(msg: string): void;
  showInputBox(opts: { prompt: string; placeHolder?: string }): Promise<string | undefined>;
}

export interface ControllerDeps {
  manager: {
    getSnapshot(): ServiceSnapshot;
    getTarget(): { host: string; port: number };
    ensureRunning(): Promise<ServiceSnapshot>;
  };
  getWorkspaceRoot(): string | undefined;
  getAutoFollow(): boolean;
  setAutoFollow(v: boolean): Promise<void>;
  messages: ControllerMessages;
  /** 自动注入去重窗口(毫秒,默认 3000):同一 ref 的最小间隔 */
  dedupeMs?: number;
  /**
   * API 基地址（可选）：扩展的本地代办地址。
   * DSH ≥0.1.2 的 /api 需要会话 cookie，生产路径应经代办（代办注入会话 cookie 并适配
   * browser-trust fence）；未接线或代办未就绪时返回 undefined，此时回退直连 manager 目标
   * （旧版 DSH 无鉴权可用）。
   */
  getApiBaseUrl?: () => string | undefined;
  /** 等待会话/代办就绪的最长时间(毫秒,默认 5000)——自启场景的会话兑换通常 1~3 秒内完成 */
  authWaitMs?: number;
}

export class ContextController {
  private lastAutoInject: { ref: string; at: number } | null = null;

  constructor(private deps: ControllerDeps) {}

  /** 构造 API 客户端：优先代办地址（由代办注入会话），否则回退直连目标（旧版无鉴权） */
  private api(): DshApi {
    const base = this.deps.getApiBaseUrl?.();
    if (base !== undefined && base !== '') return createDshApi(base);
    const { host, port } = this.deps.manager.getTarget();
    return createDshApi(`http://${host}:${port}`);
  }

  /** 确保服务就绪;失败时按 showWarningOnFail 决定是否弹提示,返回是否就绪 */
  private async ensureReady(showWarningOnFail: boolean): Promise<boolean> {
    let snap = this.deps.manager.getSnapshot();
    if (snap.state !== 'ready') snap = await this.deps.manager.ensureRunning();
    if (snap.state !== 'ready') {
      if (showWarningOnFail) this.deps.messages.showWarning(this.deps.messages.t('ctx.serviceFailed'));
      return false;
    }
    // 接线了代办（DSH ≥0.1.2）：等待会话就绪，避免刚打开面板时因 401 直接失败
    if (this.deps.getApiBaseUrl !== undefined) {
      const waitMs = this.deps.authWaitMs ?? 5000;
      const step = 500;
      for (let waited = 0; waited < waitMs; waited += step) {
        const base = this.deps.getApiBaseUrl();
        if (base !== undefined && base !== '') return true;
        await new Promise((r) => setTimeout(r, step));
      }
      if (showWarningOnFail) this.deps.messages.showWarning(this.deps.messages.t('ctx.serviceFailed'));
      return false;
    }
    return true;
  }

  private fileRef(absPath: string) {
    return describeFileRef(absPath, this.deps.getWorkspaceRoot());
  }

  /** 半自动:当前文件加入上下文(成功弹提示) */
  async addFileContext(absPath: string): Promise<void> {
    if (!(await this.ensureReady(true))) return;
    const ref = this.fileRef(absPath);
    try {
      await injectContext(this.api(), { workspaceRoot: this.deps.getWorkspaceRoot(), ref: ref.ref });
      this.deps.messages.showInformation(this.deps.messages.t('ctx.added', { path: ref.ref }));
    } catch (err) {
      this.reportError(err);
    }
  }

  /** 自动跟随:静默注入,同 ref 去重,失败不打扰 */
  async autoInject(absPath: string): Promise<void> {
    const ref = this.fileRef(absPath);
    const now = Date.now();
    if (this.lastAutoInject && this.lastAutoInject.ref === ref.ref && now - this.lastAutoInject.at < (this.deps.dedupeMs ?? 3000)) {
      return;
    }
    this.lastAutoInject = { ref: ref.ref, at: now };
    if (!(await this.ensureReady(false))) return;
    try {
      await injectContext(this.api(), { workspaceRoot: this.deps.getWorkspaceRoot(), ref: ref.ref });
    } catch {
      /* 静默:自动跟随不打扰用户 */
    }
  }

  /** 询问文件:输入框提问(可空)→ 注入问题+引用 */
  async askAboutFile(absPath: string): Promise<void> {
    if (!(await this.ensureReady(true))) return;
    const ref = this.fileRef(absPath);
    const question = await this.deps.messages.showInputBox({
      prompt: this.deps.messages.t('ctx.askPrompt', { path: ref.ref }),
      placeHolder: this.deps.messages.t('ctx.askPlaceholder'),
    });
    if (question === undefined) return; // 用户取消
    try {
      await injectQuestion(this.api(), { workspaceRoot: this.deps.getWorkspaceRoot(), question, ref: ref.ref });
    } catch (err) {
      this.reportError(err);
    }
  }

  /** 发送选区:输入框附言(可空)→ 注入附言+文件:行号+代码块 */
  async sendSelection(opts: { fileAbsPath: string; startLine: number; code: string }): Promise<void> {
    if (!(await this.ensureReady(true))) return;
    const ref = this.fileRef(opts.fileAbsPath);
    const note = await this.deps.messages.showInputBox({
      prompt: this.deps.messages.t('ctx.selPrompt', { path: ref.ref }),
      placeHolder: this.deps.messages.t('ctx.selPlaceholder'),
    });
    if (note === undefined) return;
    try {
      await injectText(this.api(), {
        workspaceRoot: this.deps.getWorkspaceRoot(),
        text: buildSelectionMessage(note, ref.ref, opts.startLine, opts.code),
      });
    } catch (err) {
      this.reportError(err);
    }
  }

  /** 切换自动跟随开关 */
  toggleAutoFollow(): void {
    void this.deps.setAutoFollow(!this.deps.getAutoFollow());
  }

  /** 幂等注册当前工作区(工作区切换后调用;失败静默) */
  async registerWorkspace(): Promise<void> {
    const root = this.deps.getWorkspaceRoot();
    if (root === undefined) return;
    try {
      await this.api().workspaceCreate(root);
    } catch {
      /* 注册失败不打断(下次注入会重试) */
    }
  }

  /** 释放资源(契约方法;当前无计时器/监听器,清空去重记录即可) */
  dispose(): void {
    this.lastAutoInject = null;
  }

  private reportError(err: unknown): void {
    if (err instanceof DshApiError) {
      if (err.kind === 'unsupported') {
        this.deps.messages.showWarning(this.deps.messages.t('ctx.unsupportedVersion'));
      } else if (err.kind === 'rpc') {
        this.deps.messages.showWarning(this.deps.messages.t('ctx.rpcError', { message: err.message }));
      } else {
        this.deps.messages.showWarning(this.deps.messages.t('ctx.serviceUnreachable'));
      }
      return;
    }
    this.deps.messages.showWarning(this.deps.messages.t('ctx.failed', { message: String(err) }));
  }
}
