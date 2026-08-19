// src/panel/html.ts — 面板占位页模板（纯函数、无逻辑、不依赖 vscode）
import type { MsgKey } from '../i18n';

/** 翻译函数签名（把 i18n.t 传入模板） */
export type T = (key: MsgKey, vars?: Record<string, string | number>) => string;

/** 面板内按钮发回扩展的消息类型（含桥接跳转与握手回执三类） */
export type PanelMessage =
  | { type: 'retry' }
  | { type: 'reconnect' }
  | { type: 'openExternal' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'copyUrl' }
  | { type: 'showLogs' }
  | { type: 'bridgeOpenExternal'; url: string }
  | { type: 'bridgeOpenFile'; path: string; cwd?: string }
  | { type: 'bridgeCopyText'; text: string; requestId: string }
  | { type: 'bridgeReadText'; requestId: string }
  | { type: 'bridgeReadTextAck'; requestId: string; ok: boolean; text?: string }
  | { type: 'bridgeAck'; ok: boolean };

/** 渲染上下文 */
export interface PageCtx {
  /** 内联脚本的 CSP nonce */
  nonce: string;
  /** webview.cspSource（本地资源来源） */
  cspSource: string;
  /** 允许加载 iframe 的目标地址（DSH 服务地址） */
  frameHosts: string[];
}

/** CSP：最小权限——只放行目标 iframe 与带 nonce 的内联脚本 */
function csp(ctx: PageCtx): string {
  return [
    "default-src 'none'",
    `frame-src ${ctx.frameHosts.join(' ')}`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${ctx.nonce}'`,
    `img-src ${ctx.cspSource} data:`,
  ].join('; ');
}

/** 通用样式（使用 VS Code 主题变量，自动适配浅色/深色主题） */
const STYLE = `
body { margin: 0; padding: 0; height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
body.frame-body { display: block; }
.center { text-align: center; max-width: 90%; }
p { margin: 8px 0 16px; opacity: 0.9; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; margin: 4px; cursor: pointer; border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground); }
.spinner { width: 28px; height: 28px; border: 3px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; margin: 0 auto 12px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
iframe.frame { position: fixed; inset: 0; width: 100%; height: 100%; border: none; }
`;

/** 按钮点击 → postMessage 的内联脚本（nonce 放行） */
const BUTTON_SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  vscode.postMessage({ type: btn.dataset.action });
});
`;

/**
 * 桥接握手脚本（内联，nonce 放行，紧随 BUTTON_SCRIPT 之后、共用其声明的 vscode）。
 * 职责：
 *  - 上行：向 iframe 下发 { kind:'bridgeHello', token } 握手消息，接收其 bridgeAck 回执，
 *    并把 iframe 上行消息（openExternal / openFile / copyText）转发给扩展侧处理；
 *  - 下行：把扩展侧的剪贴板回执 { type:'bridgeCopyTextAck' } 转发回 iframe，
 *    供 DSH 页面内的 writeText Promise 收尾（VS Code 会拦截跨源 iframe 的原生剪贴板 API）。
 * 安全约束：上行仅接收「目标 origin」且「source 为 iframe 内容窗口」的消息，防止其它站点伪造。
 * @param token 握手防伪凭据（与桥接侧 isBridgeMessage 校验的一致）
 * @param allowedOrigin 允许的消息来源 origin（由 DSH 页面地址推导，如 http://127.0.0.1:3080）
 */
function bridgeHandshakeScript(token: string, allowedOrigin: string): string {
  return `
// dsh-bridge-handshake：DSH 页面桥接握手与消息路由（上行转发 + 剪贴板回执下行转发）
const iframeEl = document.getElementById('dsh-frame');
if (iframeEl) {
  const iframeSrc = iframeEl.src;
  // 握手 token 与允许的 DSH 页面 origin
  const TOKEN = ${JSON.stringify(token)};
  const ALLOWED_ORIGIN = ${JSON.stringify(allowedOrigin)};
  let bridgeAcked = false;
  window.addEventListener('message', (e) => {
    const d = e.data;
    // —— 下行：扩展宿主回执（vscode.webview.postMessage 投递），转发给 iframe ——
    if (d && d.type === 'bridgeCopyTextAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({ kind: 'copyTextAck', requestId: d.requestId, ok: d.ok }, iframeSrc);
      return;
    }
    // 剪贴板读取回执：转发给 iframe，供其 resolve 粘贴兜底的 readText Promise
    if (d && d.type === 'bridgeReadTextAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({
        kind: 'readTextAck',
        requestId: d.requestId,
        ok: d.ok,
        text: typeof d.text === 'string' ? d.text : undefined,
      }, iframeSrc);
      return;
    }
    // —— 上行：iframe 发来的消息，origin + source 双重校验 ——
    if (e.origin !== ALLOWED_ORIGIN || e.source !== iframeEl.contentWindow) return;
    // 握手回执：统一形状 { kind:'bridgeAck', ok }（不带 token 字段），只读 ok
    if (d && d.kind === 'bridgeAck') { bridgeAcked = true; vscode.postMessage({ type: 'bridgeAck', ok: d.ok === true }); return; }
    // 打开外链：转发给扩展 → vscode.env.openExternal
    if (d && d.kind === 'openExternal' && typeof d.url === 'string') { vscode.postMessage({ type: 'bridgeOpenExternal', url: d.url }); return; }
    // 打开文件：转发给扩展 → showTextDocument（携带可选 cwd）
    if (d && d.kind === 'openFile' && typeof d.path === 'string') {
      vscode.postMessage({ type: 'bridgeOpenFile', path: d.path, cwd: typeof d.cwd === 'string' ? d.cwd : undefined });
      return;
    }
    // 复制文本：转发给扩展 → vscode.env.clipboard.writeText（跨源 iframe 原生剪贴板 API 被 VS Code 拦截）
    if (d && d.kind === 'copyText' && typeof d.text === 'string' && typeof d.requestId === 'string') {
      vscode.postMessage({ type: 'bridgeCopyText', text: d.text, requestId: d.requestId });
      return;
    }
    // 读取剪贴板：转发给扩展 → vscode.env.clipboard.readText（Cmd+V 粘贴兜底）
    if (d && d.kind === 'readText' && typeof d.requestId === 'string') {
      vscode.postMessage({ type: 'bridgeReadText', requestId: d.requestId });
    }
  });
  // iframe 加载完成后下发握手消息（携带 token）。
  // DSH 的 client 插件 factory 可能在 load 之后才 materialize，握手消息会丢失，
  // 因此收到 bridgeAck 前每 250ms 重发一次，最多重试 3 秒。
  iframeEl.addEventListener('load', () => {
    let helloAttempts = 0;
    const sendHello = () => {
      if (!bridgeAcked && iframeEl.contentWindow) {
        iframeEl.contentWindow.postMessage({ kind: 'bridgeHello', token: TOKEN }, iframeSrc);
      }
    };
    sendHello();
    const helloRetry = setInterval(() => {
      helloAttempts += 1;
      if (bridgeAcked || helloAttempts > 12) { clearInterval(helloRetry); return; }
      sendHello();
    }, 250);
  });
}`;
}

/** HTML 转义（防御性，消息来自 i18n 但转义不费事） */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 页面外壳：公共骨架 + BUTTON_SCRIPT，可选追加额外内联脚本（如桥接握手脚本）。
 * @param extraScripts 追加在 BUTTON_SCRIPT 之后、</body> 之前的内联脚本（含 <script> 标签）
 */
function shell(ctx: PageCtx, title: string, bodyClass: string, body: string, extraScripts = ''): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(ctx)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body class="${bodyClass}">${body}
<script nonce="${ctx.nonce}">${BUTTON_SCRIPT}</script>${extraScripts}
</body>
</html>`;
}

/** 加载中占位页 */
export function loadingPage(t: T, ctx: PageCtx): string {
  return shell(ctx, t('panel.loading'), '', `<div class="center"><div class="spinner"></div><p>${t('panel.loading')}</p></div>`);
}

/** 启动失败占位页：原因 + 重试 + 查看日志 */
export function errorPage(t: T, ctx: PageCtx, message: string): string {
  return shell(
    ctx,
    t('panel.errorTitle'),
    '',
    `<div class="center"><p>${t('panel.errorTitle')}</p><p>${escapeHtml(message)}</p>
<button data-action="retry">${t('panel.retry')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 服务断开占位页：重连 + 查看日志 */
export function disconnectedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('panel.disconnectedTitle'),
    '',
    `<div class="center"><p>${t('panel.disconnectedTitle')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 手动停止后的占位页 */
export function stoppedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('status.stopped'),
    '',
    `<div class="center"><p>${t('status.stopped')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button></div>`,
  );
}

/**
 * 就绪页：全屏 iframe 加载真实 DSH 网页（无 sandbox，避免破坏页面自身功能）。
 * iframe 显式声明 allow="clipboard-write" 作为第一层修复；但 VS Code 对 webview 内跨源 iframe 的
 * 原生剪贴板 API 仍存在权限拦截（microsoft/vscode#182642），因此还需桥接脚本把 DSH 页面内的
 * writeText 转发给扩展宿主（vscode.env.clipboard）执行，才能真正写入系统剪贴板。
 * 桥接启用时注入握手脚本，让顶层 webview 与 DSH 页面 iframe 建立握手并转发跳转/剪贴板消息。
 * @param bridge 桥接配置（可选，向后兼容既有调用）：token 为握手凭据，enabled 为是否注入握手脚本
 */
export function readyPage(url: string, ctx: PageCtx, bridge?: { token: string; enabled: boolean }): string {
  // 桥接启用时注入握手脚本；未传入或 enabled=false 时保持向后兼容，不注入
  const extraScripts = bridge?.enabled
    ? `<script nonce="${ctx.nonce}">${bridgeHandshakeScript(bridge.token, new URL(url).origin)}</script>`
    : '';
  return shell(
    ctx,
    'DSH',
    'frame-body',
    `<iframe id="dsh-frame" class="frame" allow="clipboard-write" src="${url}"></iframe>`,
    extraScripts,
  );
}
