// test/html.test.ts — 面板占位页模板的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initI18n, t } from '../src/i18n';
import { loadingPage, errorPage, disconnectedPage, stoppedPage, readyPage, type PageCtx } from '../src/panel/html';

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
  assert.ok(html.includes('<iframe id="dsh-frame" class="frame" src="http://127.0.0.1:3080/"></iframe>'));
  assert.ok(!html.includes('sandbox'));
});

test('readyPage 启用桥接时注入握手脚本', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 握手脚本标记与 token 均需出现在产物中（脚本会向 iframe 下发 bridgeHello）
  assert.ok(html.includes('dsh-bridge-handshake'));
  assert.ok(html.includes('tok123'));
});

test('readyPage 握手脚本包含下行 syncWorkspace 转发（补 token）', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 下行转发：收到扩展发来的 {kind:'syncWorkspace', path}（无 token）时，
  // 向 iframe 补发携带 token 的 {kind:'syncWorkspace', path, token}，供桥接侧校验来源。
  assert.ok(html.includes("kind: 'syncWorkspace'"), '脚本应包含 syncWorkspace 下行转发逻辑');
  assert.ok(html.includes("token: TOKEN"), '下行转发应向 iframe 补发握手 token');
});

test('readyPage 握手脚本下行 syncWorkspace 走缓冲 + source 收紧为 window', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 下行缓冲：iframe 加载完成前先记录 pendingPath，load 后统一补发（可覆盖旧值、最后一次生效）
  assert.ok(html.includes('pendingPath'), '脚本应包含下行缓冲变量 pendingPath');
  assert.ok(html.includes('iframeLoaded'), '脚本应包含 iframe 加载状态标志 iframeLoaded');
  // 下行分支 source 判定收紧为 e.source === window（仅 webview 顶层自身，避免误认 DSH 页内嵌套 iframe）
  assert.ok(html.includes('e.source === window'), '下行分支 source 判定应为 e.source === window');
  // iframe load 后先发 bridgeHello，再补发缓冲的 syncWorkspace（带 token）
  assert.ok(html.includes("kind: 'bridgeHello'"), 'load 后应先发 bridgeHello');
  assert.ok(html.includes("kind: 'syncWorkspace'"), 'load 后应补发 syncWorkspace');
  assert.ok(html.includes('path: pendingPath'), 'load 后应转发缓冲的 pendingPath');
  assert.ok(html.includes('token: TOKEN'), '下行转发应补发握手 token');
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
