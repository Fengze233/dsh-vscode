// test/launcher.test.ts — 执行入口裁决的单元测试（全部依赖注入，可在 Linux 上覆盖 Windows 分支）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binJsFromShim, cmdScriptArgs, containsPath, resolveLaunch, type LaunchInput } from '../src/service/launcher';

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
  // 双层引号：cmd /d /s /c 的 /s 会剥掉最外层引号，含空格的路径才不会在空格处被截断
  assert.deepEqual(r.argsPrefix, ['/d', '/s', '/c', `""${DESKTOP_CMD}""`]);
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

test('desktopCommandPath：配置路径存在时优先于默认探测；不存在则退回默认目录且不报错', () => {
  const configured = 'D:\\tools\\dsh-desktop\\dsh.cmd';
  const r1 = resolveLaunch(baseInput({
    preference: 'desktop', desktopCommandPath: configured, exists: existsOf(configured),
  }));
  assert.ok(r1);
  assert.equal(r1.source, 'desktop');
  assert.equal(r1.executablePath, configured);
  assert.equal(r1.fellBack, false);
  // 配置的路径不存在 → 退回 %LOCALAPPDATA% 下的默认位置，并留下说明
  const r2 = resolveLaunch(baseInput({
    preference: 'desktop', desktopCommandPath: 'D:\\gone\\dsh.cmd', exists: existsOf(DESKTOP_CMD),
  }));
  assert.ok(r2);
  assert.equal(r2.executablePath, DESKTOP_CMD);
  assert.deepEqual(r2.argsPrefix, ['/d', '/s', '/c', `""${DESKTOP_CMD}""`]);
  assert.ok(r2.candidateLog.some((line) => line.includes('configured')));
});

test('preference=desktop：桌面端可用时优先，npm 也同时存在时不回退；桌面端缺失则回退 npm', () => {
  const both = existsOf(NPM_SHIM, NPM_BINJS, DESKTOP_CMD);
  const first = resolveLaunch(baseInput({ preference: 'desktop', exists: both }));
  assert.ok(first);
  assert.equal(first.source, 'desktop');
  assert.equal(first.fellBack, false);
  const fallback = resolveLaunch(baseInput({ preference: 'desktop', exists: existsOf(NPM_SHIM, NPM_BINJS) }));
  assert.ok(fallback);
  assert.equal(fallback.source, 'npm');
  assert.equal(fallback.fellBack, true);
});

test('三种来源都不可用 → 返回 null（调用方据此报「未找到 dsh」）', () => {
  assert.equal(resolveLaunch(baseInput({ preference: 'auto' })), null);
  assert.equal(resolveLaunch(baseInput({ preference: 'desktop' })), null);
  assert.equal(resolveLaunch(baseInput({ explicitPath: 'D:\\gone\\dsh.cmd' })), null);
});

test('containsPath：跨平台判断子路径（Windows 反斜杠与 POSIX 斜杠同等对待）', () => {
  // Windows：卸载钩子的越界判定曾写死 '/'，导致反斜杠路径恒判为越界（所有 profile 被跳过）
  assert.equal(containsPath('C:\\Users\\u\\.dsh\\profiles', 'C:\\Users\\u\\.dsh\\profiles\\web'), true);
  assert.equal(containsPath('C:\\Users\\u\\.dsh\\profiles', 'C:\\Users\\u\\.dsh\\profiles'), true);
  assert.equal(containsPath('C:\\Users\\u\\.dsh\\profiles', 'C:\\outside'), false);
  assert.equal(containsPath('C:\\Users\\u\\.dsh\\profiles\\', 'C:\\Users\\u\\.dsh\\profiles\\web'), true);
  // 前缀相同但并非子路径（profiles2 不能被当成 profiles 的子目录）
  assert.equal(containsPath('/home/u/.dsh/profiles', '/home/u/.dsh/profiles2/x'), false);
  // POSIX
  assert.equal(containsPath('/home/u/.dsh/profiles', '/home/u/.dsh/profiles/web'), true);
  assert.equal(containsPath('/home/u/.dsh/profiles', '/outside'), false);
});

test('cmdScriptArgs：含空格/括号/中文的脚本路径一律双层引号包裹（否则 cmd 在空格处截断）', () => {
  // 真实报错形态：'C:\Users\ni125\AppData\Local\Programs\DeepSeek' 不是内部或外部命令
  const p1 = 'C:\\Users\\ni125\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
  assert.deepEqual(cmdScriptArgs(p1), ['/d', '/s', '/c', `""${p1}""`]);
  // 含括号（Program Files (x86)）与中文用户名同样只需引号，不需要转义
  for (const p of ['C:\\Program Files (x86)\\dsh\\dsh.cmd', 'C:\\Users\\张三\\.dsh\\bin\\dsh.cmd', 'D:\\a b\\c\\dsh.cmd']) {
    assert.deepEqual(cmdScriptArgs(p), ['/d', '/s', '/c', `""${p}""`]);
  }
});
