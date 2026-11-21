#!/usr/bin/env node
// scripts/verify-testbuild.mjs — 测试版本地自检（面向 Remote-WSL / Linux 开发机）
//
// 为什么需要这个脚本：测试包（0.5.0-testN）是通过 VSIX 装进「扩展宿主」的，而扩展宿主在 WSL 里，
// 与 Windows 侧的 VS Code 是两个文件系统；装没装对、桥接有没有跟着升级、启动裁决能不能命中，
// 在 UI 上基本看不出来。这里把这几件事一次对照输出，避免每次真机验证靠肉眼猜。
//
// 用法：
//   npm run verify:build            # 常规自检，桥接版本落后只算警告（激活扩展后才升级）
//   npm run verify:build -- --strict# 桥接版本也必须已同步，否则算失败（CI/发布前用）
//
// 说明：非 Windows 平台（含 WSL）上扩展宿主走 POSIX 分支，直接 spawn `dsh`，
// 不经过 launcher 的 Windows 裁决；因此这里用「构造环境」的方式模拟 Windows 场景做回归。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');
const EXT_ID = 'fengze233.dsh-vscode-panel';
const BRIDGE_PKG = 'dsh-vscode-bridge';

const expected = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

let failed = 0;
let warned = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => { warned += 1; console.log(`  ⚠️  ${msg}`); };
const bad = (msg) => { failed += 1; console.log(`  ❌ ${msg}`); };

function section(title) {
  console.log(`\n== ${title} ==`);
}

/** 列出某个扩展目录下同 ID 的所有已安装版本（VS Code 会保留旧版本目录） */
function installedExtensionVersions() {
  const roots = [
    join(homedir(), '.vscode-server', 'extensions'), // Remote-WSL / Remote-SSH 的扩展宿主
    join(homedir(), '.vscode', 'extensions'),        // 桌面版（Linux 直装）
    join(homedir(), '.vscode-insiders', 'extensions'),
  ];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!name.startsWith(`${EXT_ID}-`)) continue;
      const pkgPath = join(root, name, 'package.json');
      try {
        found.push({ where: root, dir: name, version: JSON.parse(readFileSync(pkgPath, 'utf8')).version });
      } catch {
        /* 目录残缺：跳过，不算失败 */
      }
    }
  }
  return found;
}

/** 扫描所有 DSH profile 下已安装的桥接包版本与 BRIDGE_VERSION */
function installedBridges() {
  const profiles = join(homedir(), '.dsh', 'profiles');
  if (!existsSync(profiles)) return [];
  const out = [];
  for (const name of readdirSync(profiles)) {
    const base = join(profiles, name, 'node_modules', BRIDGE_PKG);
    const pkgPath = join(base, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let version = '?';
    let bridgeVersion = '?';
    try {
      version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    } catch { /* 忽略 */ }
    const client = join(base, 'lib', 'client.js');
    if (existsSync(client)) {
      const m = /BRIDGE_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(client, 'utf8'));
      if (m !== null) bridgeVersion = m[1];
    }
    out.push({ profile: name, version, bridgeVersion });
  }
  return out;
}

/** 递归找最新的扩展输出日志（VS Code 会把 OutputChannel 落盘到 logs/<时间戳>/exthostN/output_logging_ 下的 DSH.log） */
function newestDshLog() {
  const base = join(homedir(), '.vscode-server', 'data', 'logs');
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.name.endsWith('DSH.log')) {
        try {
          candidates.push({ path: p, mtime: statSync(p).mtimeMs });
        } catch { /* 忽略并发删除 */ }
      }
    }
  };
  walk(base, 0);
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ?? null;
}

function dshInfo() {
  try {
    const out = execFileSync('dsh', ['--version'], { encoding: 'utf8', timeout: 20000 }).trim();
    let bin = 'dsh';
    try {
      bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    } catch { /* 交给 PATH 解析 */ }
    return { bin, version: out.split('\n')[0] };
  } catch (err) {
    return { bin: null, version: null, error: String(err).split('\n')[0] };
  }
}

/** 把 launcher 打成一个临时 ESM，直接用构造好的 Windows 环境跑裁决 */
async function loadLauncher() {
  const outFile = join(ROOT, 'out', '.verify-launcher.mjs');
  mkdirSync(dirname(outFile), { recursive: true });
  const result = await build({
    entryPoints: [join(ROOT, 'src', 'service', 'launcher.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'error',
  });
  writeFileSync(outFile, result.outputFiles[0].text);
  return import(pathToFileURL(outFile).href);
}

function existsOf(...paths) {
  const set = new Set(paths);
  return (p) => set.has(p);
}

function baseInput(over = {}) {
  return {
    platform: 'win32',
    env: { path: 'C:\\Windows', localAppData: 'C:\\Users\\u\\AppData\\Local' },
    exists: () => false,
    ...over,
  };
}

async function main() {
  console.log(`测试版自检 (${process.platform}/${process.arch})：期望版本 ${expected}`);

  section('已安装扩展');
  const exts = installedExtensionVersions();
  if (exts.length === 0) {
    bad('没有找到任何已安装的 dsh-vscode-panel（先执行 code --install-extension）');
  }
  for (const ext of exts) {
    const line = `${ext.where} → ${ext.dir} (v${ext.version})`;
    if (ext.version === expected) ok(line);
    else warn(`${line}（不是当前测试版，重载窗口后 VS Code 会用最新版本）`);
  }

  section('已安装桥接');
  const bridges = installedBridges();
  if (bridges.length === 0) {
    warn('还没有任何 profile 装过桥接（首次打开面板后由扩展安装）');
  }
  for (const b of bridges) {
    const line = `profile "${b.profile}": 包 v${b.version} / BRIDGE_VERSION ${b.bridgeVersion}`;
    if (b.version === expected && b.bridgeVersion === expected) ok(line);
    else if (STRICT) bad(`${line}（应与 ${expected} 一致）`);
    else warn(`${line}（打开一次面板后会被强制重装为 ${expected}）`);
  }

  section('dsh 可执行文件');
  const dsh = dshInfo();
  if (dsh.version === null) bad(`没有可用的 dsh：${dsh.error}`);
  else ok(`${dsh.bin} → ${dsh.version}`);

  section('最近一次扩展日志');
  const log = newestDshLog();
  if (log === null) {
    warn('没有找到 DSH 输出日志（还没在本窗口里打开过面板？）');
  } else {
    const text = readFileSync(log.path, 'utf8');
    const when = new Date(log.mtime).toLocaleString();
    console.log(`  文件：${log.path}（${when}）`);
    const handshake = [...text.matchAll(/handshake ok \(bridge v([^)]+)\)/g)].pop();
    if (handshake === undefined) {
      warn('日志里还没有握手记录（打开一次面板再看）');
    } else if (handshake[1] === expected) {
      ok(`桥接已握手：bridge v${handshake[1]}`);
    } else {
      warn(`桥接握手版本 v${handshake[1]}，期望 ${expected}（重载窗口并打开一次面板后会刷新）`);
    }
    const notFound = /dsh not found|未找到可用的 dsh/.test(text);
    if (notFound) bad('日志里出现「未找到可用的 dsh」');
    const source = /dsh 启动来源[:：]\s*(.+)/.exec(text);
    const entry = /dsh 实际入口[:：]\s*(.+)/.exec(text);
    const ver = /dsh 版本[:：]\s*(.+)/.exec(text);
    if (source !== null) console.log(`  启动来源：${source[1].trim()}`);
    if (entry !== null) console.log(`  实际入口：${entry[1].trim()}`);
    if (ver !== null) console.log(`  dsh 版本：${ver[1].trim()}`);
  }

  section('Windows 启动裁决（构造环境模拟，不依赖当前平台）');
  const launcher = await loadLauncher();
  const customCmd = 'D:\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd';
  const stdCmd = 'H:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
  const npmShim = 'C:\\Users\\u\\AppData\\Roaming\\npm\\dsh.cmd';
  const npmBin = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';

  const cases = [
    {
      name: 'issue #44：自定义根 D:\\dsh 只命中 PATH',
      input: baseInput({
        env: { path: 'C:\\Windows;D:\\dsh\\resources\\runtime\\cli\\bin', localAppData: 'C:\\Users\\u\\AppData\\Local' },
        exists: existsOf(customCmd),
      }),
      expect: { source: 'desktop', mode: 'cmd', executablePath: customCmd, desktopRoot: 'D:\\dsh' },
    },
    {
      name: '标准根（H:\\DeepSeek Harness）回归',
      input: baseInput({
        env: { path: `C:\\Windows;${win32.dirname(stdCmd)}`, localAppData: 'C:\\Users\\u\\AppData\\Local' },
        exists: existsOf(stdCmd),
      }),
      expect: { source: 'desktop', mode: 'cmd', executablePath: stdCmd },
    },
    {
      name: 'npm 全局 shim + bin.js 存在 → 仍优先 npm',
      input: baseInput({
        env: { path: 'C:\\Windows;C:\\Users\\u\\AppData\\Roaming\\npm', localAppData: 'C:\\Users\\u\\AppData\\Local' },
        exists: existsOf(npmShim, npmBin),
      }),
      expect: { source: 'npm', mode: 'node', executablePath: npmBin },
    },
    {
      name: 'npm shim 的 bin.js 缺失 + 自定义 Desktop → 走 desktop',
      input: baseInput({
        env: { path: `C:\\Users\\u\\AppData\\Roaming\\npm;${win32.dirname(customCmd)}`, localAppData: 'C:\\Users\\u\\AppData\\Local' },
        exists: existsOf(npmShim, customCmd),
      }),
      expect: { source: 'desktop', mode: 'cmd', executablePath: customCmd },
    },
    {
      name: '显式路径 dsh.executablePath 指向 .cmd → 直接执行脚本',
      input: baseInput({ explicitPath: customCmd, exists: existsOf(customCmd) }),
      expect: { source: 'explicit', mode: 'cmd', executablePath: customCmd },
    },
  ];

  for (const c of cases) {
    const r = launcher.resolveLaunch(c.input);
    if (r === null) {
      bad(`${c.name} → 返回 null（会被报「未找到可用的 dsh」）`);
      continue;
    }
    const mismatches = Object.entries(c.expect)
      .filter(([k, v]) => r[k] !== v)
      .map(([k, v]) => `${k}: 期望 ${v}，实际 ${r[k]}`);
    if (mismatches.length === 0) ok(`${c.name} → ${r.source} / ${r.mode}`);
    else bad(`${c.name} → ${mismatches.join('; ')}`);
  }

  section('结论');
  console.log(`  失败 ${failed} 项，警告 ${warned} 项`);
  if (process.platform !== 'win32') {
    console.log('  提示：当前平台不是 Windows，扩展宿主会直接 spawn dsh；上面第 5 组是构造环境回归。');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('自检脚本自身出错：', err);
  process.exit(2);
});
