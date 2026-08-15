// test/bridge/installer.test.ts — 桥接安装器单测（内存 fs）
// 全部用例通过注入的 InstallerFs 内存实现完成，不依赖真实文件系统；
// 生产侧的 Node fs 适配（createNodeFs）只做结构校验，不触碰磁盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installBridge,
  uninstallBridge,
  detectProfileDir,
  createNodeFs,
  BRIDGE_BEGIN_MARK,
  BRIDGE_END_MARK,
  BRIDGE_BEGIN_MARK_WAS_EMPTY,
  BRIDGE_PACKAGE_NAME,
  type InstallerFs,
} from '../../src/bridge/installer';

// 内存 fs：files 是路径→内容，dirs 是目录集合。
// copyDir 只象征性落一个 package.json，用于让 exists(dest) 为真；
// 真实递归复制由生产侧的 createNodeFs（fs.cpSync recursive）负责，此处不模拟。
function makeMemFs(init: Record<string, string> = {}): InstallerFs {
  const files = new Map(Object.entries(init));
  const dirs = new Set<string>();
  return {
    exists: (p) => files.has(p) || dirs.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error(`no such file: ${p}`); return v; },
    writeFile: (p, c) => { files.set(p, c); },
    mkdir: (p) => { dirs.add(p); },
    copyDir: (src, dest) => { dirs.add(dest); files.set(`${dest}/package.json`, `{"copied":"${src}"}`); },
    rmDir: (p) => { dirs.delete(p); },
    readdir: () => [],
  };
}

test('detectProfileDir 返回 profiles/web 路径', () => {
  const fs = makeMemFs();
  fs.mkdir('/home/u/.dsh/profiles/web');
  assert.equal(detectProfileDir('/home/u/.dsh', fs), '/home/u/.dsh/profiles/web');
  assert.equal(detectProfileDir('/home/u/.dsh2', fs), null);
});

test('installBridge 幂等：第二次安装不重复追加条目', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const fs = makeMemFs({ [patchPath]: '# 用户自己的内容\n- id: user-plugin\n  name: user-plugin\n' });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  const r1 = installBridge(opts);
  const after1 = fs.readFile(patchPath);
  const r2 = installBridge(opts);
  assert.equal(r1.status, 'ok');
  assert.equal(r2.status, 'ok');
  assert.equal(fs.readFile(patchPath), after1); // 幂等
  assert.ok(after1.includes(BRIDGE_BEGIN_MARK));
  assert.ok(after1.includes('- id: dsh-vscode-bridge'));
  assert.ok(after1.includes('# 用户自己的内容')); // 不覆盖用户内容
});

test('uninstallBridge 还原用户内容并删除桥接目录', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n';
  const fs = makeMemFs({ [patchPath]: original });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  installBridge(opts);
  uninstallBridge(opts);
  assert.equal(fs.readFile(patchPath), original);
  assert.equal(fs.exists(`${profile}/node_modules/dsh-vscode-bridge`), false);
});

test('profile 目录缺失时返回 degraded 并带原因', () => {
  const fs = makeMemFs({});
  const r = installBridge({ dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs });
  assert.equal(r.status, 'degraded');
  assert.ok(r.reason);
});

test('[] 空数组场景：安装改写为块序列，卸载还原为 []', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '[]\n';
  const fs = makeMemFs({ [patchPath]: original });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  const r = installBridge(opts);
  assert.equal(r.status, 'ok');
  const after = fs.readFile(patchPath);
  assert.ok(after.includes(BRIDGE_BEGIN_MARK));
  assert.ok(after.includes(BRIDGE_END_MARK));
  assert.ok(after.includes('- insert:'));
  assert.ok(after.includes(`- id: ${BRIDGE_PACKAGE_NAME}`));
  // 卸载后必须还原为安装前的 []
  uninstallBridge(opts);
  assert.equal(fs.readFile(patchPath), original);
});

test('默认模板（注释 + []）改写为块序列，而非在 [] 后追加', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  // 模拟 DSH 初始化的真实默认文件：说明注释 + 顶层流式空数组 []
  const original = '# Your patch layer for this dsh profile\n# a top-level YAML array of loader patch entries\n[]\n';
  const fs = makeMemFs({ [patchPath]: original });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  installBridge(opts);
  const after = fs.readFile(patchPath);
  assert.ok(after.includes(BRIDGE_BEGIN_MARK));
  assert.ok(after.includes(BRIDGE_BEGIN_MARK_WAS_EMPTY)); // 空数组改写分支需带元数据
  assert.ok(after.includes('- insert:'));
  assert.ok(after.includes(`- id: ${BRIDGE_PACKAGE_NAME}`));
  // 关键：不得出现「[] 后直接跟块序列」的非法形状（Task 0 实测会导致整个 YAML 解析失败 fail-loud）
  assert.ok(!/\[\]\s*\n# dsh-vscode-bridge: begin/.test(after));
  // 卸载按字节级还原安装前内容（注释头 + []，而非仅剩 []）
  uninstallBridge(opts);
  assert.equal(fs.readFile(patchPath), original);
});

test('注释头 + [] 空数组：安装→卸载后字节级还原（不丢注释头）', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  // 模拟默认 profile 原始文件：3 行注释头 + []（实测 217 字节的形态）
  const init = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n';
  const fs = makeMemFs({ [patchPath]: init });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  const r = installBridge(opts);
  assert.equal(r.status, 'ok');
  const after = fs.readFile(patchPath);
  // 安装后应保留注释头，并用带元数据的 begin 标记包裹条目
  assert.ok(after.startsWith(init.slice(0, init.indexOf('[]'))));
  assert.ok(after.includes(BRIDGE_BEGIN_MARK_WAS_EMPTY));
  assert.ok(after.includes('- insert:'));
  uninstallBridge(opts);
  // 断言最终内容与 init 字节一致（逐字节还原）
  assert.equal(fs.readFile(patchPath), init);
  assert.equal(fs.exists(`${profile}/node_modules/dsh-vscode-bridge`), false);
});

test('createNodeFs 返回 InstallerFs 的 7 个方法', () => {
  const fs = createNodeFs();
  for (const m of ['exists', 'readFile', 'writeFile', 'mkdir', 'copyDir', 'rmDir', 'readdir'] as const) {
    assert.equal(typeof fs[m], 'function', `${m} 应为函数`);
  }
});
