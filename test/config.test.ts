// test/config.test.ts — 配置规范化与回环地址校验的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, isLoopbackHost, DEFAULTS } from '../src/config';

test('合法配置原样通过', () => {
  const { config, errors } = normalizeConfig({
    host: 'localhost', port: 4000, autoStart: false, stopOnExit: false, extraArgs: ['--trusted-host', 'x:1'],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(config, { host: 'localhost', port: 4000, autoStart: false, stopOnExit: false, extraArgs: ['--trusted-host', 'x:1'] });
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
