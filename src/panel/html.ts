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
  | { type: 'bridgeAck'; ok: boolean; version?: string }
  | { type: 'openSettings' }
  | { type: 'bridgeSaveImage'; requestId: string; name: string; dataB64: string; sessionCwd?: string }
  | { type: 'bridgeSaveImageAck'; requestId: string; ok: boolean; path?: string }
  | { type: 'bridgeDeleteImages'; requestId: string; paths: string[] }
  | { type: 'bridgeDeleteImagesAck'; requestId: string; ok: boolean }
  /** 需要登录引导页：用户粘贴外部启动的 DSH 启动网址后提交（扩展校验并兑换会话） */
  | { type: 'authSubmitLaunchUrl'; url: string };

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
 * 安全约束：上行仅接收「目标 iframe 内容窗口」且「来源 origin 属于本页面加载的 DSH 服务」
 * 的消息，防止其它站点伪造（详情见 isAllowedBridgeOrigin 注释——webview 的 service worker
 * 可能重写 iframe 真实 origin，故不能只用 src 推导的 origin 一刀切拒绝）。
 * @param token 握手防伪凭据（与桥接侧 isBridgeMessage 校验的一致）
 * @param allowedOrigin 允许的消息来源 origin（由 DSH 页面地址推导，如 http://127.0.0.1:3080）
 */
function bridgeHandshakeScript(token: string, allowedOrigin: string, imageFallback: boolean): string {
  return `
// dsh-bridge-handshake：DSH 页面桥接握手与消息路由（上行转发 + 剪贴板回执下行转发）
const iframeEl = document.getElementById('dsh-frame');
if (iframeEl) {
  // 握手 token 与允许的 DSH 页面 origin
  const TOKEN = ${JSON.stringify(token)};
  const ALLOWED_ORIGIN = ${JSON.stringify(allowedOrigin)};
  const IMAGE_FALLBACK = ${JSON.stringify(imageFallback)}; // v0.3.0：非视觉模型图片降级开关
  let bridgeAcked = false;
  // 发送目标判定：DSH 页面装在 vscode-webview 的 service worker 里，若它重写了 iframe 的
  // 真实 origin（remote 实测 e.origin 回流为 vscode-webview://<uuid>），用 iframe.src 推导的
  // origin 作 targetOrigin 会让 postMessage 直接抛错（61 次 hello 一条都发不出去，见 issue #13）。
  // 因此下行一律 '*'：接收窗口已用 iframeEl.contentWindow 锁定，hello 自身带 token 防伪，
  // 恶意页面拿不到 token 不会回 ack；上行则保留来源校验（见 isAllowedBridgeOrigin）。
  // 顺带兼容「host 从 127.0.0.1 换成 localhost」等 loopback 等价变体。
  function isAllowedBridgeOrigin(o) {
    if (typeof o !== 'string') return false;
    if (o === ALLOWED_ORIGIN) return true;
    // webview SW 重写后的载体 origin（remote 场景实测；source 已限定为本 iframe，可接受）
    if (o.startsWith('vscode-webview://')) return true;
    // 127.0.0.1 / localhost 同端口互换（隧道/WSL 场景 host 替换后 src 与回流 origin 可能不同）
    try {
      const a = new URL(ALLOWED_ORIGIN);
      const b = new URL(o);
      const loopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1';
      return loopback(a.hostname) && loopback(b.hostname) && a.port === b.port;
    } catch {
      return false;
    }
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    // —— 下行：扩展宿主回执（vscode.webview.postMessage 投递），转发给 iframe ——
    if (d && d.type === 'bridgeCopyTextAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({ kind: 'copyTextAck', requestId: d.requestId, ok: d.ok }, '*');
      return;
    }
    // 剪贴板读取回执：转发给 iframe，供其 resolve 粘贴兜底的 readText Promise
    if (d && d.type === 'bridgeReadTextAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({
        kind: 'readTextAck',
        requestId: d.requestId,
        ok: d.ok,
        text: typeof d.text === 'string' ? d.text : undefined,
      }, '*');
      return;
    }
    // 保存图片回执：转发给 iframe，resolve 其 saveImage Promise（ok + 落盘绝对路径）
    if (d && d.type === 'bridgeSaveImageAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({
        kind: 'saveImageAck',
        requestId: d.requestId,
        ok: d.ok,
        ...(typeof d.path === 'string' ? { path: d.path } : {}),
      }, '*');
      return;
    }
    // 删除图片回执：转发给 iframe，resolve 其 deleteImages Promise
    if (d && d.type === 'bridgeDeleteImagesAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({ kind: 'deleteImagesAck', requestId: d.requestId, ok: d.ok }, '*');
      return;
    }
    // —— 上行：iframe 发来的消息，source + origin 双重校验 ——
    if (e.source !== iframeEl.contentWindow || !isAllowedBridgeOrigin(e.origin)) return;
    // 握手回执：统一形状 { kind:'bridgeAck', ok }（不带 token 字段），只读 ok
    if (d && d.kind === 'bridgeAck') {
      bridgeAcked = true;
      vscode.postMessage({
        type: 'bridgeAck',
        ok: d.ok === true,
        ...(typeof d.version === 'string' ? { version: d.version } : {}),
      });
      return;
    }
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
    // 保存图片：转发给扩展 → 扩展宿主落盘到会话 cwd（v0.3.0 图片降级）
    if (d && d.kind === 'saveImage' && typeof d.requestId === 'string' && typeof d.name === 'string' && typeof d.dataB64 === 'string') {
      vscode.postMessage({
        type: 'bridgeSaveImage',
        requestId: d.requestId,
        name: d.name,
        dataB64: d.dataB64,
        ...(typeof d.sessionCwd === 'string' ? { sessionCwd: d.sessionCwd } : {}),
      });
      return;
    }
    // 删除图片缓存：转发给扩展 → 扩展宿主删除文件（会话结束清理）
    if (d && d.kind === 'deleteImages' && typeof d.requestId === 'string' && Array.isArray(d.paths)) {
      vscode.postMessage({ type: 'bridgeDeleteImages', requestId: d.requestId, paths: d.paths });
      return;
    }
    // 读取剪贴板：转发给扩展 → vscode.env.clipboard.readText（Cmd+V 粘贴兜底）
    if (d && d.kind === 'readText' && typeof d.requestId === 'string') {
      vscode.postMessage({ type: 'bridgeReadText', requestId: d.requestId });
    }
  });
  // 下发握手消息（携带 token）。不挂在 iframe 的 load 事件上：webview 里 iframe（本机直连）
  // 毫秒级完成加载，脚本在 body 尾部才注册监听，事件早已错过——hello 循环永远不启动
  // （issue #13-4 实测）。改为脚本执行即启动：DSH 的 client 插件 factory 可能在页面
  // 加载后才 materialize（实测 1.5~3s），收到 bridgeAck 前每 250ms 重发一次，
  // 最长 15 秒（覆盖 remote/慢 boot 场景），收到回执立即停止。
  let helloAttempts = 0;
  const sendHello = () => {
    if (!bridgeAcked && iframeEl.contentWindow) {
      iframeEl.contentWindow.postMessage({ kind: 'bridgeHello', token: TOKEN, imageFallback: IMAGE_FALLBACK }, '*');
    }
  };
  sendHello();
  const helloRetry = setInterval(() => {
    helloAttempts += 1;
    if (bridgeAcked || helloAttempts > 60) { clearInterval(helloRetry); return; }
    sendHello();
  }, 250);
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

/** 远程未启用占位页：远程窗口且 dsh.remote.enabled=false 时展示，引导用户开启并重载（v0.3.0） */
export function remoteDisabledPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('panel.remoteDisabled'),
    '',
    '<div class="center"><p>' + t('panel.remoteDisabled') + '</p>' +
    '<button data-action="openSettings">' + t('panel.openSettings') + '</button></div>',
  );
}

/**
 * 需要登录占位页：DSH ≥0.1.2 带浏览器鉴权，扩展没有其会话 cookie 时展示。
 * 覆盖「DSH 由扩展之外启动」的场景（扩展自启时会从子进程日志自动拿启动网址，
 * 用户不会看到本页）；粘贴启动日志里的 `dsh web: …` 网址（30 天一次）即可完成登录。
 * 输入框提交经 postMessage 交给扩展（扩展负责校验与兑换，不在页面内做任何逻辑）。
 */
export function authRequiredPage(t: T, ctx: PageCtx): string {
  const inputScript = `
// 注意：不得再次声明 vscode 实例——公共段（BUTTON_SCRIPT）已声明过它，
// 顶层重复声明会抛 SyntaxError 使本脚本整体失效；这里直接复用外层 vscode。
const input = document.getElementById('auth-url-input');
const hint = document.getElementById('auth-hint');
const btn = document.getElementById('auth-submit');
function submit() {
  const url = (input && input.value || '').trim();
  if (url === '') return;
  btn.disabled = true;
  if (hint) hint.textContent = ${JSON.stringify(t('panel.authSubmitting'))};
  vscode.postMessage({ type: 'authSubmitLaunchUrl', url });
}
if (btn) btn.addEventListener('click', submit);
if (input) {
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  input.focus();
}
`;
  return shell(
    ctx,
    t('panel.authTitle'),
    '',
    `<div class="center" style="max-width:420px;text-align:left">
<p style="font-weight:600">${t('panel.authTitle')}</p>
<p>${t('panel.authExplain')}</p>
<ol style="margin:4px 0 12px;padding-left:20px;opacity:0.85">
<li>${t('panel.authStep1')}</li>
<li>${t('panel.authStep2')}</li>
</ol>
<input id="auth-url-input" type="text" spellcheck="false" style="width:100%;box-sizing:border-box;padding:6px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border, transparent);border-radius:2px;font-family:var(--vscode-font-family)" placeholder="${escapeHtml(t('panel.authPlaceholder'))}">
<p id="auth-hint" style="font-size:12px;opacity:0.75">${t('panel.authHint')}</p>
<div style="text-align:center">
<button id="auth-submit">${t('panel.authSubmit')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button>
</div>
</div>
<script nonce="${ctx.nonce}">${inputScript}</script>`,
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
export function readyPage(url: string, ctx: PageCtx, bridge?: { token: string; enabled: boolean; imageFallback?: boolean }): string {
  // 桥接启用时注入握手脚本；未传入或 enabled=false 时保持向后兼容，不注入
  const extraScripts = bridge?.enabled
    ? `<script nonce="${ctx.nonce}">${bridgeHandshakeScript(bridge.token, new URL(url).origin, bridge.imageFallback === true)}</script>`
    : '';
  return shell(
    ctx,
    'DSH',
    'frame-body',
    `<iframe id="dsh-frame" class="frame" allow="clipboard-write" src="${url}"></iframe>`,
    extraScripts,
  );
}
