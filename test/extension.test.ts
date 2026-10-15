// test/extension.test.ts — profile 配置变更回调的装配与握手回归测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationChangeEvent, WebviewViewProvider } from 'vscode';
import { activate, deactivate, shouldResetHandshake } from '../src/extension';
import { ServiceManager, type ManagerOptions, type ServiceSnapshot } from '../src/service/manager';
import { BRIDGE_BEGIN_MARK } from '../src/bridge/installer';
import * as vscodeStub from './vscode-stub';

test('profile 变更先安装桥接再重新配置服务，仅保留就绪外部服务的握手', async (t) => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-profile-change-'));
  const previousHome = process.env.DSH_HOME;
  // 测试 bundle 位于 out/test，激活入口按 __dirname 查找随附桥接包。
  const bridgeSourceDir = join(__dirname, 'bridge-client');
  cpSync(join(__dirname, '..', 'bridge-client'), bridgeSourceDir, { recursive: true });
  process.env.DSH_HOME = dshHome;
  try {
    for (const scenario of [
      { state: 'ready', owned: true, bridgeEnabled: true },
      { state: 'ready', owned: false, bridgeEnabled: true },
      { state: 'ready', owned: true, bridgeEnabled: false },
      { state: 'idle', owned: false, bridgeEnabled: true },
    ] as const) {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const settings: Record<string, unknown> = {
        profile: 'web', executablePath: join(dshHome, 'bin', 'dsh.cmd'),
      };
      const logs: string[] = [];
      const providers = new Map<string, WebviewViewProvider>();
      let handler: ((event: ConfigurationChangeEvent) => void) | undefined;
      let reconfigureCalls = 0;
      const snapshot: ServiceSnapshot = {
        state: 'ready', url: 'http://127.0.0.1:3080/', error: null, owned: scenario.owned,
      };
      const customDir = join(dshHome, 'profiles', 'custom-profile');
      mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true });
      mkdirSync(customDir, { recursive: true });
      t.mock.method(vscodeStub.workspace, 'getConfiguration', () => ({
        get: (key: string) => settings[key],
      }));
      t.mock.method(vscodeStub.workspace, 'onDidChangeConfiguration', (cb: typeof handler) => {
        handler = cb;
        return { dispose: () => {} };
      });
      t.mock.method(vscodeStub.window, 'createOutputChannel', () => ({
        appendLine: (line: string) => logs.push(line), dispose: () => {},
      }));
      t.mock.method(vscodeStub.window, 'registerWebviewViewProvider', (id: string, provider: WebviewViewProvider) => {
        providers.set(id, provider);
        return { dispose: () => {} };
      });
      t.mock.method(ServiceManager.prototype, 'getSnapshot', () => snapshot);
      t.mock.method(ServiceManager.prototype, 'reconfigure', (options: ManagerOptions) => {
        reconfigureCalls += 1;
        assert.equal(options.profile, 'custom-profile');
        // 重启入口被调用前，新 profile 的桥接条目与副本必须已经就绪。
        const patchPath = join(customDir, 'cordis.patch.yml');
        assert.equal(existsSync(patchPath), scenario.bridgeEnabled);
        if (scenario.bridgeEnabled) {
          assert.ok(readFileSync(patchPath, 'utf8').includes(BRIDGE_BEGIN_MARK));
          assert.ok(existsSync(join(customDir, 'node_modules', 'dsh-vscode-bridge', 'package.json')));
        }
        // idle 场景模拟外部服务退出后，按新 profile 启动的自启服务已就绪。
        snapshot.state = 'ready';
        snapshot.url = 'http://127.0.0.1:3080/';
        if (scenario.state === 'idle') snapshot.owned = true;
        return Promise.resolve(snapshot);
      });
      const context = {
        subscriptions: [] as { dispose(): void }[],
        extension: { packageJSON: { version: 'test' } },
        globalState: { get: () => undefined, update: async () => {} },
      };
      try {
        activate(context as never);
        const panel = providers.get('dsh.panel.secondary')!;
        // 模拟面板向扩展提交握手回执，再通过实际注册的回调修改配置。
        Reflect.get(panel, 'onBridgeAck')(true);
        snapshot.state = scenario.state;
        if (scenario.state === 'idle') snapshot.url = null;
        settings.profile = ' custom-profile ';
        settings['bridge.enabled'] = scenario.bridgeEnabled;
        assert.ok(handler);
        handler({ affectsConfiguration: (key: string) => key === 'dsh.profile' || key === 'dsh' } as ConfigurationChangeEvent);
        assert.equal(reconfigureCalls, 1);
        Reflect.get(panel, 'onFirstOpen')();
        t.mock.timers.tick(5000);
        assert.equal(logs.some((line) => line.includes('[bridge] handshake timeout')),
          (scenario.state !== 'ready' || scenario.owned) && scenario.bridgeEnabled,
          '仅就绪的外部服务应保留成功握手，新服务应等待新握手');
      } finally {
        await deactivate();
        for (const subscription of context.subscriptions) subscription.dispose();
        t.mock.restoreAll();
        t.mock.timers.reset();
        rmSync(customDir, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(bridgeSourceDir, { recursive: true, force: true });
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// PR #35 隐患：清握手只看「就绪 且 非自启」，而快照在 reconfigure 之前取、反映旧目标。
// 端口 + profile 同时改、且新端口上已有外部服务时，旧的 handshakeOk=true 被保留，
// 新页面若不握手也会因「已回执」早退、永不武装超时 → 桥接永久误报健康。
// 判据抽成纯函数后逐条锁定：
test('shouldResetHandshake：端点变化必重握手；仅 profile 变时只保留「就绪外部服务」的握手', () => {
  const ready = { state: 'ready', owned: false };
  const readyOwned = { state: 'ready', owned: true };
  const idle = { state: 'idle', owned: false };
  // ① 端点（host/port）变了：无论快照是不是就绪外部服务，都必须重握手
  assert.equal(shouldResetHandshake({ profile: false, endpoint: true }, ready), true);
  assert.equal(shouldResetHandshake({ profile: true, endpoint: true }, ready), true);
  assert.equal(shouldResetHandshake({ profile: true, endpoint: true }, readyOwned), true);
  assert.equal(shouldResetHandshake({ profile: true, endpoint: true }, null), true);
  // ② 只换 profile：就绪的外部服务可复用握手（同一端口上的服务没变）
  assert.equal(shouldResetHandshake({ profile: true, endpoint: false }, ready), false);
  // ③ 只换 profile：自启服务会按新 profile 重启 → 必须等新页面握手
  assert.equal(shouldResetHandshake({ profile: true, endpoint: false }, readyOwned), true);
  // ④ 服务未就绪/无快照：等新握手
  assert.equal(shouldResetHandshake({ profile: true, endpoint: false }, idle), true);
  assert.equal(shouldResetHandshake({ profile: true, endpoint: false }, null), true);
});
