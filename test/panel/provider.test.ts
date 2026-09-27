// test/panel/provider.test.ts — 面板 provider 的重渲染入口与消息路由
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshPanelProvider } from '../../src/panel/provider';

/** 假 ServiceManager(仅 provider 用到的接口) */
function fakeManager() {
  const listeners = new Set<(s: unknown) => void>();
  return {
    onChange: (cb: (s: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot: () => ({ state: 'ready', url: 'http://127.0.0.1:3080/', error: null, owned: false }),
    getTarget: () => ({ host: '127.0.0.1', port: 3080 }),
    ensureRunning: async () => ({}),
  };
}

/** 假 webview view(仅 provider 触碰的成员) */
function fakeView() {
  const received: Array<{ (msg: unknown): void }> = [];
  const posted: unknown[] = [];
  return {
    webview: {
      options: {} as Record<string, unknown>,
      cspSource: 'vscode-webview:',
      html: '',
      postMessage: (m: unknown) => posted.push(m),
      onDidReceiveMessage: (cb: (msg: unknown) => void) => received.push(cb),
    },
    received,
    posted,
    fire: (msg: unknown) => {
      for (const cb of received) cb(msg);
    },
  };
}

// 自审回归：缩放档位等"渲染期读取"的设置项依赖 refreshContextBar 重渲染。
// 该入口在 v0.4.2 起不再与"上下文工具条"绑定，任何情况下都必须重渲染，
// 否则改设置后要重载窗口才生效。
test('refreshContextBar 重渲染并让新的缩放档位即时生效', () => {
  let zoom = 1;
  const provider = new DshPanelProvider(
    fakeManager() as never,
    undefined, undefined,
    () => '/proj', () => true, () => false,
    async (u) => u, () => true,
    { zoomLevel: () => zoom }, // ui：只接线缩放
  );
  const view = fakeView();
  provider.resolveWebviewView(view as never);
  // 注意口径：CSS 里定义了 --dshv-zoom 的默认值，所以要看"元素上有没有写入内联缩放变量"
  assert.ok(!view.webview.html.includes('style="--dshv-zoom'), '默认 1 档不写内联缩放变量');
  zoom = 0.8;
  provider.refreshContextBar();
  assert.ok(view.webview.html.includes('style="--dshv-zoom:0.8'), '重渲染后应写入新的内联缩放变量');
  assert.equal(view.posted.length, 0, '重渲染不应顺带发任何下行消息');
});

test('未打开面板时 refreshContextBar 安全返回(不抛异常)', () => {
  const provider = new DshPanelProvider(fakeManager() as never);
  provider.refreshContextBar(); // 无 view：内部判空直接返回
});
