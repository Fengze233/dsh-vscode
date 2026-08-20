// test/config.test.ts — 配置规范化与回环地址校验的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, isLoopbackHost, DEFAULTS } from '../src/config';

test('合法配置原样通过', () => {
  const { config, errors } = normalizeConfig({
    host: 'localhost', port: 4000, autoStart: false, stopOnExit: false, extraArgs: ['--trusted-host', 'x:1'],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(config, {
    host: 'localhost', port: 4000, autoStart: false, stopOnExit: false, extraArgs: ['--trusted-host', 'x:1'],
    bridgeEnabled: true, workspaceRootIndex: 0, silenceWarning: false, executablePath: '',
    openInBrowser: false, remoteEnabled: false, imageFallback: false,
  });
});

test('缺省值回退默认', () => {
  const { config } = normalizeConfig({});
  assert.deepEqual(config, DEFAULTS);
});

test('非回环地址回退默认并记录错误', () => {
  const { config, errors } = normalizeConfig({ host: '192.168.1.5' });
  assert.equal(config.host, DEFAULTS.host);
  assert.equal(errors.length, 1);
});

test('端口非法（越界/非整数）回退默认并记录错误', () => {
  for (const bad of [-1, 65536, 1.5, NaN]) {
    const { config, errors } = normalizeConfig({ port: bad });
    assert.equal(config.port, DEFAULTS.port);
    assert.equal(errors.length, 1);
  }
});

test('extraArgs 非字符串元素被过滤', () => {
  const { config } = normalizeConfig({ extraArgs: ['--a', 1 as unknown as string, '--b'] });
  assert.deepEqual(config.extraArgs, ['--a', '--b']);
});

test('回环地址识别', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('192.168.0.1'), false);
  assert.equal(isLoopbackHost('example.com'), false);
});

test('normalizeConfig 处理桥接新设置项的缺省与非法值', () => {
  // 缺省值：bridgeEnabled 默认 true、workspaceRootIndex 默认 0、silenceWarning 默认 false
  const r1 = normalizeConfig({});
  assert.equal(r1.config.bridgeEnabled, true);
  assert.equal(r1.config.workspaceRootIndex, 0);
  assert.equal(r1.config.silenceWarning, false);
  // 合法值原样通过
  const r2 = normalizeConfig({ bridgeEnabled: false, workspaceRootIndex: 2, silenceWarning: true });
  assert.equal(r2.config.bridgeEnabled, false);
  assert.equal(r2.config.workspaceRootIndex, 2);
  assert.equal(r2.config.silenceWarning, true);
  // 非法值回退默认并记录错误
  const r3 = normalizeConfig({ workspaceRootIndex: -1 });
  assert.equal(r3.config.workspaceRootIndex, 0); // 非法回退默认
  assert.equal(r3.errors.length, 1);
});

test('workspaceRootIndex 非法分支逐类回退并记录错误', () => {
  // 非整数（1.5 / NaN）与类型错误（字符串）都必须回退 0 并记录 error
  const r1 = normalizeConfig({ workspaceRootIndex: 1.5 });
  assert.equal(r1.config.workspaceRootIndex, 0);
  assert.equal(r1.errors.length, 1);
  const r2 = normalizeConfig({ workspaceRootIndex: Number.NaN });
  assert.equal(r2.config.workspaceRootIndex, 0);
  assert.equal(r2.errors.length, 1);
  const r3 = normalizeConfig({ workspaceRootIndex: '2' as unknown as number });
  assert.equal(r3.config.workspaceRootIndex, 0);
  assert.equal(r3.errors.length, 1);
});

test('executablePath：缺省回退空串', () => {
  const { config } = normalizeConfig({});
  assert.equal(config.executablePath, '');
});

test('executablePath：非字符串静默回退空串', () => {
  const r1 = normalizeConfig({ executablePath: 123 as unknown as string });
  assert.equal(r1.config.executablePath, '');
  assert.equal(r1.errors.length, 0); // 静默回退，不记录错误
  const r2 = normalizeConfig({ executablePath: undefined });
  assert.equal(r2.config.executablePath, '');
});

test('executablePath：合法值原样通过（含空串）', () => {
  assert.equal(normalizeConfig({ executablePath: 'C:\\tools\\dsh.cmd' }).config.executablePath, 'C:\\tools\\dsh.cmd');
  assert.equal(normalizeConfig({ executablePath: '' }).config.executablePath, '');
});

// —— v0.3.0 新设置：openInBrowser / remoteEnabled / imageFallback ——
test('v0.3.0 新设置缺省值：openInBrowser=false / remoteEnabled=false / imageFallback=false(图片降级已停用)', () => {
  const r = normalizeConfig({});
  assert.equal(r.config.openInBrowser, false);
  assert.equal(r.config.remoteEnabled, false);
  assert.equal(r.config.imageFallback, false); // 图片降级已停用
  assert.deepEqual(r.config, DEFAULTS);
});

test('v0.3.0 新设置合法值原样通过', () => {
  const r1 = normalizeConfig({ openInBrowser: true, remoteEnabled: true, imageFallback: false });
  assert.equal(r1.config.openInBrowser, true);
  assert.equal(r1.config.remoteEnabled, true);
  assert.equal(r1.config.imageFallback, false);
  assert.equal(r1.errors.length, 0);
});

test('v0.3.0 新设置非布尔值回退默认（不记错误）', () => {
  const r2 = normalizeConfig({ openInBrowser: 'yes' as unknown as boolean });
  assert.equal(r2.config.openInBrowser, false);
  const r3 = normalizeConfig({ remoteEnabled: 1 as unknown as boolean });
  assert.equal(r3.config.remoteEnabled, false);
  // 非布尔回退默认（现默认 false）
  const r4 = normalizeConfig({ imageFallback: 1 as unknown as boolean });
  assert.equal(r4.config.imageFallback, false);
  assert.equal(r2.errors.length, 0);
  assert.equal(r3.errors.length, 0);
  assert.equal(r4.errors.length, 0);
});
