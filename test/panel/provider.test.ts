// test/panel/provider.test.ts — 面板 provider 的重渲染入口与消息路由
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshPanelProvider } from '../../src/panel/provider';
import { initI18n, t } from '../../src/i18n';
import * as vscodeStub from '../vscode-stub';

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

// 文案回归：点击「停止服务」后 manager 进入 stopping，面板不能仍显示「正在启动」。
test('stopping 状态的面板显示「正在停止」而不是「正在启动」', () => {
  initI18n('en');
  const manager = {
    ...fakeManager(),
    getSnapshot: () => ({ state: 'stopping', url: null, error: null, owned: true }),
  };
  const provider = new DshPanelProvider(manager as never);
  const view = fakeView();
  provider.resolveWebviewView(view as never);
  assert.ok(view.webview.html.includes(t('panel.stopping')));
  assert.ok(!view.webview.html.includes(t('panel.loading')));
});

// issue #33：交付物（图片/PDF/未知二进制）必须用 vscode.open 打开。
// 锁定的是 provider 里真实装配的依赖实现，而不是测试自造的替身——
// 否则「打开方式」这条契约（showTextDocument vs vscode.open）测不到。
test('bridgeDeps 的 openTextDocument 走 vscode.open（支持二进制交付物）', async (t) => {
  const executed: unknown[][] = [];
  const shownText: string[] = [];
  t.mock.method(vscodeStub.commands, 'executeCommand', async (...args: unknown[]) => {
    executed.push(args);
    return undefined;
  });
  t.mock.method(vscodeStub.window, 'showTextDocument', async () => {
    shownText.push('called');
    return undefined;
  });
  const provider = new DshPanelProvider(fakeManager() as never);
  const deps = Reflect.get(provider, 'bridgeDeps').call(provider) as {
    openTextDocument: (p: string) => Promise<void>;
  };
  await deps.openTextDocument('C:\\tmp\\kf11_full.png');
  assert.deepEqual(executed[0], ['vscode.open', { fsPath: 'C:\\tmp\\kf11_full.png' }, { preview: false }]);
  assert.equal(shownText.length, 0, '不得再用 window.showTextDocument');
});

// 编辑区标签页（v0.5.0）：WebviewPanel 只提供 webview，没有 WebviewView 外壳，
// 因此 provider 必须能直接绑定一个 Webview 宿主，并与侧边栏共用同一套渲染逻辑。
test('resolveWebview 可直接绑定编辑区面板宿主并渲染 ready 页', () => {
  const provider = new DshPanelProvider(
    fakeManager() as never,
    undefined, undefined,
    () => '/proj', () => true, () => false,
    async (u) => u, () => true,
    {},
  );
  const webview = fakeView().webview;
  provider.resolveWebview(webview as never);
  assert.ok(webview.html.includes('<iframe'), '绑定后应渲染出 DSH 的 iframe');
});

// 关闭编辑区标签页会销毁 webview：detach 之后若仍渲染，会向已销毁宿主写 html。
test('detach 之后不再向旧宿主渲染', () => {
  const provider = new DshPanelProvider(
    fakeManager() as never,
    undefined, undefined,
    () => '/proj', () => true, () => false,
    async (u) => u, () => true,
    {},
  );
  const webview = fakeView().webview;
  provider.resolveWebview(webview as never);
  const rendered = webview.html;
  provider.detach(webview as never);
  provider.refreshContextBar();
  assert.equal(webview.html, rendered, '解绑后 refreshContextBar 不应再写 html');
});

// 资源管理器右键「DSH → 添加到对话」：把已格式化的 @ 引用插入 DSH 输入框
// （v0.5.1 起由扩展侧按 DSH 语法生成文本，provider 只负责下发）
test('insertMentions 下发插入请求，页面回执后返回 true', async () => {
  const provider = new DshPanelProvider(
    fakeManager() as never,
    undefined, undefined,
    () => '/proj', () => true, () => false,
    async (u) => u, () => true,
    {},
  );
  const view = fakeView();
  provider.resolveWebview(view.webview as never);
  const pending = provider.insertMentions(['@src/a.ts', '@test/']);
  view.fire({ type: 'bridgeInsertMentionsAck', ok: true });
  assert.equal(await pending, true);
  assert.deepEqual(view.posted[view.posted.length - 1], {
    type: 'bridgeInsertMentions',
    mentions: ['@src/a.ts', '@test/'],
    // v0.5.0 桥接的旧字段：扩展升级但 DSH 服务未重启时，页面里可能还是旧桥接
    paths: ['src/a.ts', 'test/'],
  });
});

test('新标签页只在绑定完成前请求绑定工作区，回执后重渲染不再请求', () => {
  let ackResult: { ok: boolean; reason?: string } | null = null;
  const provider = new DshPanelProvider(
    fakeManager() as never,
    undefined, undefined,
    () => '/proj', () => true, () => false,
    async (u) => u, () => true,
    {
      bootstrapWorkspace: () => true, // 扩展侧：设置开 + 有工作区
      onWorkspaceBootstrapAck: (ok, reason) => { ackResult = { ok, reason }; },
    },
  );
  const view = fakeView();
  provider.resolveWebview(view.webview as never);
  assert.ok(view.webview.html.includes('const WORKSPACE_ROOT = "/proj";'), '应携带工作区根');
  assert.ok(view.webview.html.includes('const BOOTSTRAP_WORKSPACE = true;'), '首次渲染应请求绑定');

  // 桥接完成绑定之后（例如鉴权/代理刷新触发重渲染）：不再重复请求切换工作区。
  // 注意不能用 bridgeAck 做闸门：握手回执远早于绑定完成，提前停发会在页面重载时打断绑定。
  view.fire({ type: 'bridgeWorkspaceBootstrapAck', ok: false, reason: 'boom' });
  assert.deepEqual(ackResult, { ok: false, reason: 'boom' }, '失败原因应回传');
  provider.refreshContextBar();
  assert.ok(view.webview.html.includes('const BOOTSTRAP_WORKSPACE = false;'), '回执后不得再触发');
});

test('侧边栏视图重建后可以再次绑定工作区（新页面重新获得一次机会）', () => {
  const provider = new DshPanelProvider(
    fakeManager() as never,
    undefined, undefined,
    () => '/proj', () => true, () => false,
    async (u) => u, () => true,
    { bootstrapWorkspace: () => true },
  );
  const first = fakeView();
  provider.resolveWebview(first.webview as never);
  assert.ok(first.webview.html.includes('const BOOTSTRAP_WORKSPACE = true;'), '首次打开应请求绑定');
  first.fire({ type: 'bridgeWorkspaceBootstrapAck', ok: true });
  provider.refreshContextBar();
  assert.ok(first.webview.html.includes('const BOOTSTRAP_WORKSPACE = false;'), '同一页面不得重复绑定');

  // 视图被重建 = 新 webview（新页面）：应重新获得一次绑定机会
  const second = fakeView();
  provider.resolveWebview(second.webview as never);
  assert.ok(second.webview.html.includes('const BOOTSTRAP_WORKSPACE = true;'), '新页面应再次请求绑定');
});

test('绑定进行中时「添加到对话」先等回执，避免把引用写进即将切走的会话', async () => {
  const provider = new DshPanelProvider(
    fakeManager() as never,
    undefined, undefined,
    () => '/proj', () => true, () => false,
    async (u) => u, () => true,
    { bootstrapWorkspace: () => true },
  );
  const view = fakeView();
  provider.resolveWebview(view.webview as never); // 渲染 ready 页 → 记录工作区绑定请求
  const posted = (): Array<{ type?: string }> => view.posted as Array<{ type?: string }>;
  const inserts = (): number => posted().filter((m) => m.type === 'bridgeInsertMentions').length;

  const pending = provider.insertMentions(['@src/a.ts']);
  assert.equal(inserts(), 0, '绑定完成前不得下发插入请求');
  view.fire({ type: 'bridgeWorkspaceBootstrapAck', ok: true }); // 切换完成
  await new Promise((resolve) => setTimeout(resolve, 0)); // 等等待者被唤醒后的微任务
  assert.equal(inserts(), 1, '回执后应正常下发一次');
  view.fire({ type: 'bridgeInsertMentionsAck', ok: true });
  assert.equal(await pending, true);
});

test('insertMentions 在没有绑定 webview 时直接返回 false', async () => {
  const provider = new DshPanelProvider(
    fakeManager() as never,
    undefined, undefined,
    () => '/proj', () => true, () => false,
    async (u) => u, () => true,
    {},
  );
  assert.equal(await provider.insertMentions(['@src/a.ts']), false);
});
