// test/panel/provider.test.ts — 面板 provider 的消息路由与工具条推送
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshPanelProvider, type ContextPanelDeps } from '../../src/panel/provider';

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

interface CtxHarness {
  calls: string[];
  provider: DshPanelProvider;
  view: ReturnType<typeof fakeView>;
  deps: ContextPanelDeps;
}

function makeCtx(): CtxHarness {
  const calls: string[] = [];
  const deps: ContextPanelDeps = {
    getFileLabel: () => 'src/extension.ts',
    getAutoFollow: () => false,
    addFileContext: () => calls.push('addFileContext'),
    toggleAutoFollow: () => calls.push('toggleAutoFollow'),
  };
  // 参数顺序按合并后的构造签名（main 的鉴权/代理接线参数在前，PR 的 context 依赖在最后）
  const provider = new DshPanelProvider(
    fakeManager() as never,
    undefined, // onFirstOpen
    undefined, // onBridgeAck
    () => '/proj', // workspaceRoot
    () => true, // bridgeEnabled
    () => false, // remoteEnabled
    async (u) => u, // resolveExternalUrl
    () => true, // imageFallback
    {}, // ui（未接线时按旧行为）
    deps, // context（PR #11：上下文工具条依赖）
  );
  const view = fakeView();
  provider.resolveWebviewView(view as never);
  return { calls, provider, view, deps };
}

test('resolveWebviewView 注入 context 时渲染工具条(含文件标签)', () => {
  const h = makeCtx();
  assert.ok(h.view.webview.html.includes('id="dsh-ctx-bar"'));
  assert.ok(h.view.webview.html.includes('src/extension.ts'));
});

test('addFileContext 消息 → context.addFileContext()', () => {
  const h = makeCtx();
  h.view.fire({ type: 'addFileContext' });
  assert.deepEqual(h.calls, ['addFileContext']);
});

test('toggleAutoFollow 消息 → context.toggleAutoFollow() 并重渲染', () => {
  const h = makeCtx();
  h.view.fire({ type: 'toggleAutoFollow' });
  assert.deepEqual(h.calls, ['toggleAutoFollow']);
  assert.ok(h.view.webview.html.includes('id="dsh-ctx-bar"')); // 重渲染仍含工具条
});

test('refreshContextBar 推送下行 updateContextBar 消息', () => {
  const h = makeCtx();
  h.provider.refreshContextBar();
  assert.deepEqual(h.view.posted[0], { kind: 'updateContextBar', fileLabel: 'src/extension.ts', autoFollow: false });
});

test('未注入 context 时:无工具条渲染,消息不崩溃', () => {
  const provider = new DshPanelProvider(fakeManager() as never);
  const view = fakeView();
  provider.resolveWebviewView(view as never);
  assert.ok(!view.webview.html.includes('dsh-ctx-bar'));
  view.fire({ type: 'addFileContext' }); // 无 context:静默忽略,不抛异常
});
