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
  bridgeTargetDirs,
  BRIDGE_BEGIN_MARK,
  BRIDGE_END_MARK,
  BRIDGE_BEGIN_MARK_WAS_EMPTY,
  BRIDGE_PACKAGE_NAME,
  type InstallerFs,
} from '../../src/bridge/installer';

// 内存 fs：files 是路径→内容，dirs 是目录集合。
// copyDir 落一个含 `"name"` 的 package.json，满足幂等分支「读 package.json 验证」的要求，
// 同时让 exists(dest) 为真；真实递归复制由生产侧的 createNodeFs（fs.cpSync recursive）负责，此处不模拟。
function makeMemFs(init: Record<string, string> = {}): InstallerFs {
  const files = new Map(Object.entries(init));
  const dirs = new Set<string>();
  return {
    exists: (p) => files.has(p) || dirs.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error(`no such file: ${p}`); return v; },
    writeFile: (p, c) => { files.set(p, c); },
    mkdir: (p) => { dirs.add(p); },
    copyDir: (src, dest) => { dirs.add(dest); files.set(`${dest}/package.json`, `{"name":"dsh-vscode-bridge","copied":"${src}"}`); },
    rmDir: (p) => { dirs.delete(p); for (const k of [...files.keys()]) { if (k.startsWith(`${p}/`)) files.delete(k); } },
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

// 可注入单路径失败的 fs：在原 makeMemFs 之上按路径覆盖某方法的实现。
// 用于模拟 chmod 000（package.json 读抛错，rmDir 操作抛错）等坏包场景，
// 不影响其余路径的正常读写。
interface FailPathFs extends InstallerFs {
  failReadPaths: Set<string>;
  failRmPaths: Set<string>;
  failCopy: boolean;
}
function makeFailableFs(init: Record<string, string> = {}): FailPathFs {
  const base = makeMemFs(init);
  const failReadPaths = new Set<string>();
  const failRmPaths = new Set<string>();
  let failCopy = false;
  return {
    ...base,
    failReadPaths,
    failRmPaths,
    get failCopy() { return failCopy; },
    set failCopy(v: boolean) { failCopy = v; },
    readFile: (p) => {
      if (failReadPaths.has(p)) throw new Error(`EACCES: permission denied: ${p}`);
      const v = base.readFile(p);
      return v;
    },
    rmDir: (p) => {
      if (failRmPaths.has(p)) throw new Error(`EBUSY: cannot remove: ${p}`);
      base.rmDir(p);
    },
    copyDir: (src, dest) => {
      if (failCopy) throw new Error(`EACCES: copy failed: ${src}`);
      base.copyDir(src, dest);
    },
  };
}

test('首次安装 copyDir 抛错 → degraded、patch 字节级还原、无桥接目录', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n- id: user-plugin\n  name: user-plugin\n';
  const fs = makeFailableFs({ [patchPath]: original });
  fs.mkdir(profile);
  fs.failCopy = true;
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  const r = installBridge(opts);
  assert.equal(r.status, 'degraded');
  assert.ok(r.reason && /copy/i.test(r.reason), 'reason 应包含失败原因');
  // patch 必须回滚为安装前字节（绝不残留「有条目但包不可用」）
  assert.equal(fs.readFile(patchPath), original);
  // 无桥接目录
  assert.equal(fs.exists(`${profile}/node_modules/dsh-vscode-bridge`), false);
});

test('幂等分支 package.json 不可读且 rmDir 抛错 → degraded、patch 回滚为无条目', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  // 注释头 + []（空数组形态），安装→卸载应字节级还原为原始内容
  const original = '# Your patch layer for this dsh profile\n[]\n';
  const fs = makeFailableFs({ [patchPath]: original });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  installBridge(opts); // 正常完成一次安装

  // 模拟 chmod 000：package.json 读取抛错 → 进入强制重装；rmDir 也抛错 → 回滚条目
  const bridgeDir = `${profile}/node_modules/dsh-vscode-bridge`;
  const pkgPath = `${bridgeDir}/package.json`;
  fs.failReadPaths.add(pkgPath);
  fs.failRmPaths.add(bridgeDir);

  const r = installBridge(opts);
  assert.equal(r.status, 'degraded');
  assert.ok(r.reason);
  // patch 回滚为「无桥接条目」的原始内容（注释头 + []，与 uninstallBridge 的 was-empty-array 还原一致）
  assert.equal(fs.readFile(patchPath), original);
});

test('幂等分支 package.json 不可读、rmDir+copyDir 成功 → ok、patch 保留、目录为 source 副本', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n';
  const fs = makeFailableFs({ [patchPath]: original });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  installBridge(opts);
  const after = fs.readFile(patchPath);

  // 坏包（package.json 读抛错），但 rmDir/copyDir 正常 → 强制重装成功
  const bridgeDir = `${profile}/node_modules/dsh-vscode-bridge`;
  const pkgPath = `${bridgeDir}/package.json`;
  fs.failReadPaths.add(pkgPath);

  const r = installBridge(opts);
  assert.equal(r.status, 'ok');
  // patch 保留条目（不删除、不追加）
  assert.equal(fs.readFile(patchPath), after);
  // 强装成功后坏包标记清除，目录内容应为 source 副本（含 name）
  fs.failReadPaths.delete(pkgPath);
  const pkg = fs.readFile(`${bridgeDir}/package.json`);
  assert.ok(pkg.includes('"name"'));
  assert.ok(pkg.includes(opts.bridgeSourceDir));
});

// —— 双位置安装（Windows/WSL 兼容）：primary=profiles/web/node_modules，secondary=profiles/node_modules ——

test('bridgeTargetDirs 不传 npm 位置时返回 primary 与 secondary 两个目标目录', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const dirs = bridgeTargetDirs(profile);
  assert.deepEqual(dirs, [
    '/home/u/.dsh/profiles/web/node_modules/dsh-vscode-bridge',
    '/home/u/.dsh/profiles/node_modules/dsh-vscode-bridge',
  ]);
});

test('bridgeTargetDirs 传入 npm 位置时返回三个目标目录（顺序固定）', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const npmGlobal = '/c/Users/u/AppData/Roaming/npm/node_modules';
  const dirs = bridgeTargetDirs(profile, npmGlobal);
  assert.deepEqual(dirs, [
    '/home/u/.dsh/profiles/web/node_modules/dsh-vscode-bridge',
    '/home/u/.dsh/profiles/node_modules/dsh-vscode-bridge',
    '/c/Users/u/AppData/Roaming/npm/node_modules/dsh-vscode-bridge',
  ]);
});

test('首次安装：primary 与 secondary 两处目录均被创建', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n';
  const fs = makeMemFs({ [patchPath]: original });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  const r = installBridge(opts);
  assert.equal(r.status, 'ok');
  const [primary, secondary] = bridgeTargetDirs(profile);
  assert.equal(fs.exists(primary), true);
  assert.equal(fs.exists(secondary), true);
  // bridgeDir 语义保持为 primary 路径（兼容既有）。
  assert.equal(r.bridgeDir, primary);
});

test('首次安装 secondary copyDir 抛错 → degraded、patch 字节还原、primary 也已清理', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n- id: user-plugin\n  name: user-plugin\n';
  const fs = makeFailableFs({ [patchPath]: original });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };

  // 仅让 secondary copyDir 失败：首次 primary 复制后，secondary 复制抛错。
  const secondary = `${profile}/../node_modules/dsh-vscode-bridge`;
  const realCopy = fs.copyDir.bind(fs);
  let primaryCopied = false;
  fs.copyDir = (src, dest) => {
    // 第一次调用（primary）成功；第二次调用（secondary）抛错。
    if (dest === secondary || primaryCopied) {
      throw new Error(`EACCES: copy failed: ${src}`);
    }
    primaryCopied = true;
    realCopy(src, dest);
  };

  const r = installBridge(opts);
  assert.equal(r.status, 'degraded');
  assert.ok(r.reason && /copy/i.test(r.reason), 'reason 应包含失败位置');
  assert.equal(fs.readFile(patchPath), original); // patch 字节级还原
  const [pDir, sDir] = bridgeTargetDirs(profile);
  assert.equal(fs.exists(pDir), false); // primary 已清理
  assert.equal(fs.exists(sDir), false);
});

test('幂等分支 secondary 缺失（dsh 升级清理 fallback）→ 自愈补回 secondary 且 primary 不动', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n';
  const fs = makeFailableFs({ [patchPath]: original });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  installBridge(opts); // 正常完成首次安装，两处均存在

  // 记录 primary 副本内容，再模拟 dsh 升级清理 secondary。
  const [primary, secondary] = bridgeTargetDirs(profile);
  const primaryPkg = fs.readFile(`${primary}/package.json`);
  fs.rmDir(secondary);
  assert.equal(fs.exists(secondary), false);

  const r = installBridge(opts); // 幂等分支：secondary 缺失 → 自愈补回
  assert.equal(r.status, 'ok');
  assert.equal(fs.exists(secondary), true);
  // primary 保持原样（未被重装覆盖）。
  assert.equal(fs.readFile(`${primary}/package.json`), primaryPkg);
});

test('uninstallBridge：两处目录均删除', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n';
  const fs = makeMemFs({ [patchPath]: original });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  installBridge(opts);
  const [primary, secondary] = bridgeTargetDirs(profile);
  assert.equal(fs.exists(primary), true);
  assert.equal(fs.exists(secondary), true);
  uninstallBridge(opts);
  assert.equal(fs.exists(primary), false);
  assert.equal(fs.exists(secondary), false);
});

// —— 第三安装目标：npm 全局 node_modules（Windows 扩展宿主 ESM 解析可达位置）——

test('传入 npmGlobalNodeModules：首次安装创建三个目标目录', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n';
  const npmGlobal = '/c/Users/u/AppData/Roaming/npm/node_modules';
  // 预创建 npm 全局目录，模拟真实环境 npm 全局 node_modules 已存在
  const fs = makeMemFs({ [patchPath]: original });
  fs.mkdir(profile);
  fs.mkdir(npmGlobal);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs, npmGlobalNodeModules: npmGlobal };
  const r = installBridge(opts);
  assert.equal(r.status, 'ok');
  const targets = bridgeTargetDirs(profile, npmGlobal);
  assert.equal(targets.length, 3);
  for (const t of targets) {
    assert.equal(fs.exists(t), true, `${t} 应被创建`);
  }
  // bridgeDir 仍指向 primary
  assert.equal(r.bridgeDir, targets[0]);
});

test('npm 目标 copyDir 失败 → degraded + patch 字节还原 + primary/secondary 已清理', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n- id: user-plugin\n  name: user-plugin\n';
  const npmGlobal = '/c/Users/u/AppData/Roaming/npm/node_modules';
  const fs = makeFailableFs({ [patchPath]: original });
  fs.mkdir(profile);
  fs.mkdir(npmGlobal);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs, npmGlobalNodeModules: npmGlobal };

  // 仅让 npm 目标（第三个）copyDir 失败：前两个成功后，第三个复制抛错。
  const npmTarget = `${npmGlobal}/dsh-vscode-bridge`;
  const realCopy = fs.copyDir.bind(fs);
  fs.copyDir = (src, dest) => {
    if (dest === npmTarget) {
      throw new Error(`EACCES: copy failed: ${src}`);
    }
    realCopy(src, dest);
  };

  const r = installBridge(opts);
  assert.equal(r.status, 'degraded');
  assert.ok(r.reason && r.reason.includes(npmTarget), 'reason 应包含失败目标路径');
  // patch 字节级还原
  assert.equal(fs.readFile(patchPath), original);
  // 三个目标全部清理（primary/secondary 已复制也要回滚清除）
  for (const t of bridgeTargetDirs(profile, npmGlobal)) {
    assert.equal(fs.exists(t), false, `${t} 应被清理`);
  }
});

test('幂等分支 npm 目标缺失 → 自愈补回该目标且其他不动', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n';
  const npmGlobal = '/c/Users/u/AppData/Roaming/npm/node_modules';
  const fs = makeMemFs({ [patchPath]: original });
  fs.mkdir(profile);
  fs.mkdir(npmGlobal);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs, npmGlobalNodeModules: npmGlobal };
  installBridge(opts); // 正常完成首次安装，三处均存在

  // 记录 primary 副本内容，再模拟 npm 全局目标被清理。
  const [primary, secondary, npmTarget] = bridgeTargetDirs(profile, npmGlobal);
  const primaryPkg = fs.readFile(`${primary}/package.json`);
  const secondaryPkg = fs.readFile(`${secondary}/package.json`);
  fs.rmDir(npmTarget);
  assert.equal(fs.exists(npmTarget), false);

  const r = installBridge(opts); // 幂等分支：npm 目标缺失 → 自愈补回
  assert.equal(r.status, 'ok');
  assert.equal(fs.exists(npmTarget), true);
  // primary / secondary 保持原样（未被重装覆盖）。
  assert.equal(fs.readFile(`${primary}/package.json`), primaryPkg);
  assert.equal(fs.readFile(`${secondary}/package.json`), secondaryPkg);
});

test('uninstall：三个目标目录全删', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n';
  const npmGlobal = '/c/Users/u/AppData/Roaming/npm/node_modules';
  const fs = makeMemFs({ [patchPath]: original });
  fs.mkdir(profile);
  fs.mkdir(npmGlobal);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs, npmGlobalNodeModules: npmGlobal };
  installBridge(opts);
  const targets = bridgeTargetDirs(profile, npmGlobal);
  for (const t of targets) {
    assert.equal(fs.exists(t), true);
  }
  uninstallBridge(opts);
  for (const t of targets) {
    assert.equal(fs.exists(t), false, `${t} 应被删除`);
  }
});

test('不传 npmGlobalNodeModules：目标数组仅两项，与旧双位置行为完全一致', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const dirs = bridgeTargetDirs(profile);
  assert.equal(dirs.length, 2);
  assert.deepEqual(dirs, [
    '/home/u/.dsh/profiles/web/node_modules/dsh-vscode-bridge',
    '/home/u/.dsh/profiles/node_modules/dsh-vscode-bridge',
  ]);
});
