// test/launcher.test.ts — 执行入口裁决的单元测试（全部依赖注入，可在 Linux 上覆盖 Windows 分支）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binJsFromShim, resolveLaunch, type LaunchInput } from '../src/service/launcher';

/** 构造一份「文件系统里存在这些路径」的 exists 实现 */
function existsOf(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

const NPM_SHIM = 'C:\\Users\\u\\AppData\\Roaming\\npm\\dsh.cmd';
const NPM_BINJS = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const DESKTOP_CMD = 'C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';

function baseInput(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    platform: 'win32',
    env: { path: 'C:\\Windows;C:\\Users\\u\\AppData\\Roaming\\npm', localAppData: 'C:\\Users\\u\\AppData\\Local' },
    exists: () => false,
    ...over,
  };
}

test('binJsFromShim 由 shim 目录推导 npm 布局的 bin.js 路径', () => {
  assert.equal(binJsFromShim(NPM_SHIM), NPM_BINJS);
});

test('显式路径：以 .js 结尾走 node 直跑', () => {
  const r = resolveLaunch(baseInput({ explicitPath: 'D:\\tools\\bin.js', exists: existsOf('D:\\tools\\bin.js') }));
  assert.ok(r);
  assert.equal(r.source, 'explicit');
  assert.equal(r.mode, 'node');
  assert.deepEqual(r.argsPrefix, ['D:\\tools\\bin.js']);
  assert.equal(r.fellBack, false);
});

test('显式路径：.cmd 走 cmd 执行，不再推导 bin.js（issue #30 的配置方式）', () => {
  const r = resolveLaunch(baseInput({ explicitPath: DESKTOP_CMD, exists: existsOf(DESKTOP_CMD) }));
  assert.ok(r);
  assert.equal(r.source, 'explicit');
  assert.equal(r.mode, 'cmd');
  assert.equal(r.executablePath, DESKTOP_CMD);
  assert.deepEqual(r.argsPrefix, ['/d', '/s', '/c', DESKTOP_CMD]);
});

test('显式路径存在性校验失败时不作为候选，继续走首选', () => {
  const r = resolveLaunch(baseInput({
    explicitPath: 'D:\\gone\\dsh.cmd',
    preference: 'npm',
    exists: existsOf(NPM_SHIM, NPM_BINJS),
  }));
  assert.ok(r);
  assert.equal(r.source, 'npm');
  assert.ok(r.candidateLog.some((line) => line.includes('explicit')));
});

test('npm 可行：PATH 命中 dsh.cmd 且 bin.js 真实存在', () => {
  const r = resolveLaunch(baseInput({ preference: 'auto', exists: existsOf(NPM_SHIM, NPM_BINJS) }));
  assert.ok(r);
  assert.equal(r.source, 'npm');
  assert.equal(r.mode, 'node');
  assert.deepEqual(r.argsPrefix, [NPM_BINJS]);
  assert.equal(r.fellBack, false);
});

test('npm 不可行：bin.js 不存在时必须判定 npm 不可用（issue #30 核心）', () => {
  const r = resolveLaunch(baseInput({ preference: 'npm', exists: existsOf(NPM_SHIM, DESKTOP_CMD) }));
  assert.ok(r);
  assert.equal(r.source, 'desktop');
  assert.equal(r.fellBack, true);
  assert.ok(r.reason.includes('npm'));
  assert.ok(r.candidateLog.some((line) => line.includes('bin.js')));
});
