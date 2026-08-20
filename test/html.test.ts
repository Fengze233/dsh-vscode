// test/html.test.ts — 面板占位页模板的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initI18n, t } from '../src/i18n';
import { loadingPage, errorPage, disconnectedPage, stoppedPage, readyPage, remoteDisabledPage, type PageCtx } from '../src/panel/html';

function ctx(): PageCtx {
  return { nonce: 'abc123', cspSource: 'vscode-webview:', frameHosts: ['http://127.0.0.1:3080'] };
}

test('loadingPage 包含加载动画与本地化文案', () => {
  initI18n('zh-cn');
  const html = loadingPage(t, ctx());
  assert.ok(html.includes('spinner'));
  assert.ok(html.includes(t('panel.loading')));
});

test('errorPage 包含重试按钮并转义消息中的 HTML', () => {
  initI18n('en');
  const html = errorPage(t, ctx(), '<script>alert(1)</script>');
  assert.ok(html.includes('data-action="retry"'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('disconnectedPage 与 stoppedPage 都包含重连按钮', () => {
  const d = disconnectedPage(t, ctx());
  const s = stoppedPage(t, ctx());
  assert.ok(d.includes('data-action="reconnect"'));
  assert.ok(s.includes('data-action="reconnect"'));
});

test('readyPage 包含目标地址 iframe 且无 sandbox 属性', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(html.includes('id="dsh-frame"'));
  assert.ok(html.includes('class="frame"'));
  assert.ok(html.includes('src="http://127.0.0.1:3080/"'));
  assert.ok(!html.includes('sandbox'));
});

test('readyPage 为跨源 iframe 声明 clipboard-write 权限', () => {
  // VS Code webview 与 DSH 页面跨源：不声明 allow="clipboard-write" 时，
  // DSH 代码块复制按钮的 navigator.clipboard.writeText 会被 Permissions Policy 拦截。
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(html.includes('allow="clipboard-write"'));
});

test('readyPage 启用桥接时注入握手脚本', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 握手脚本标记与 token 均需出现在产物中（脚本会向 iframe 下发 bridgeHello）
  assert.ok(html.includes('dsh-bridge-handshake'));
  assert.ok(html.includes('tok123'));
});

test('readyPage 握手脚本包含上行 bridgeHello 发送', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // iframe load 后向 iframe 发送 bridgeHello 握手消息（携带 token）
  assert.ok(html.includes("kind: 'bridgeHello'"), 'load 后应发送 bridgeHello');
  assert.ok(html.includes('token: TOKEN'), '握手消息应携带 token');
  // 不应再包含下行 syncWorkspace 转发逻辑（工作区同步已移除）
  assert.ok(!html.includes('syncWorkspace'), '脚本不应包含 syncWorkspace 下行转发');
});

test('readyPage 握手脚本包含剪贴板桥接的上下行转发', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 上行：iframe 的 copyText → vscode.postMessage(bridgeCopyText)
  assert.ok(html.includes("kind === 'copyText'"), '应转发 iframe 的 copyText 上行消息');
  assert.ok(html.includes("type: 'bridgeCopyText'"), '应向扩展宿主发送 bridgeCopyText');
  // 下行：扩展宿主 bridgeCopyTextAck → iframe 的 copyTextAck
  assert.ok(html.includes("type === 'bridgeCopyTextAck'"), '应接收扩展宿主的剪贴板回执');
  assert.ok(html.includes("kind: 'copyTextAck'"), '应把回执转发为 iframe 的 copyTextAck');
});

test('readyPage 握手脚本包含剪贴板读取（粘贴兜底）的上下行转发', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 上行：iframe 的 readText → vscode.postMessage(bridgeReadText)
  assert.ok(html.includes("kind === 'readText'"), '应转发 iframe 的 readText 上行消息');
  assert.ok(html.includes("type: 'bridgeReadText'"), '应向扩展宿主发送 bridgeReadText');
  // 下行：扩展宿主 bridgeReadTextAck → iframe 的 readTextAck（携带 text）
  assert.ok(html.includes("type === 'bridgeReadTextAck'"), '应接收扩展宿主的读取回执');
  assert.ok(html.includes("kind: 'readTextAck'"), '应把回执转发为 iframe 的 readTextAck');
  assert.ok(html.includes('typeof d.text === \'string\''), '回执应透传剪贴板文本');
});

test('readyPage 未启用桥接时不注入握手脚本', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  // 未传第三参（或 enabled=false）时保持向后兼容，不注入握手脚本
  assert.ok(!html.includes('dsh-bridge-handshake'));
});

test('CSP 声明 frame-src 与 script-src nonce', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(html.includes('frame-src http://127.0.0.1:3080'));
  assert.ok(html.includes("script-src 'nonce-abc123'"));
});
test('remoteDisabledPage 包含提示文案与打开设置按钮（v0.3.0）', () => {
  initI18n('zh-cn');
  const html = remoteDisabledPage(t, ctx());
  assert.ok(html.includes(t('panel.remoteDisabled')));
  assert.ok(html.includes('data-action="openSettings"'));
});
test('readyPage 握手脚本包含 saveImage/deleteImages 上下行转发（v0.3.0）', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  assert.ok(html.includes("kind === 'saveImage'"), '上行：转发 iframe 的 saveImage');
  assert.ok(html.includes("type: 'bridgeSaveImage'"), '上行：向扩展宿主发送 bridgeSaveImage');
  assert.ok(html.includes("kind === 'deleteImages'"), '上行：转发 iframe 的 deleteImages');
  assert.ok(html.includes("type === 'bridgeSaveImageAck'"), '下行：接收扩展宿主的保存回执');
  assert.ok(html.includes("type === 'bridgeDeleteImagesAck'"), '下行：接收扩展宿主的删除回执');
});
test('readyPage 握手脚本携带 imageFallback 开关（v0.3.0）', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true, imageFallback: true });
  assert.ok(html.includes('IMAGE_FALLBACK'), '脚本应定义 IMAGE_FALLBACK');
  assert.ok(html.includes('imageFallback: IMAGE_FALLBACK'), 'hello 消息应携带 imageFallback');
  // 未指定时默认 false（降级关闭）
  const html2 = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  assert.ok(html2.includes('IMAGE_FALLBACK = false'));
});

