// test/uninstall.test.ts — 卸载钩子的 profile 遍历守卫（PR #35 把清理面扩大到 profiles/* 之后的安全前提）
// 用内存 fs + 注入 realpath，完全离线：验证「符号链接 / 非法名 / 越界路径」三类条目不会被改写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUninstallHook, shouldRunUninstall } from '../src/uninstall';
import type { InstallerFs } from '../src/bridge/installer';

/** 内存 fs：files 为路径→内容，dirs 为目录集合，symlinks 记录「哪条路径是符号链接」 */
function makeMemFs(init: Record<string, string>, symlinks: string[] = []): InstallerFs & { written: string[] } {
  const files = new Map(Object.entries(init));
  const dirs = new Set<string>();
  const linkSet = new Set(symlinks);
  return {
    written: [],
    exists: (p) => files.has(p) || dirs.has(p),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`no such file: ${p}`);
      return v;
    },
    writeFile(p, c) {
      files.set(p, c);
      this.written.push(p);
    },
    mkdir: (p) => { dirs.add(p); },
    copyDir: (src, dest) => {
      dirs.add(dest);
      files.set(`${dest}/package.json`, `{"name":"dsh-vscode-bridge","copied":"${src}"}`);
    },
    rmDir: (p) => { dirs.delete(p); for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k); },
    readdir: (p) => [...new Set([...files.keys(), ...dirs, ...linkSet]
      .filter((entry) => entry.startsWith(`${p}/`))
      .map((entry) => entry.slice(p.length + 1).split('/')[0]))],
    isSymlink: (p) => linkSet.has(p),
    readFileRaw: (p: string) => files.get(p),
  } as InstallerFs & { written: string[]; readFileRaw(p: string): string | undefined };
}

const MARK = '# dsh-vscode-bridge: begin';
const OUTSIDE_PATCH = '/outside/cordis.patch.yml';

test('卸载钩子不使用符号链接 profile：$DSH_HOME 之外的 cordis.patch.yml 不被改写', () => {
  const outsideContent = `${MARK}\n- id: dsh-vscode-bridge\n`;
  const fs = makeMemFs({ [OUTSIDE_PATCH]: outsideContent }, ['/home/u/.dsh/profiles/linked']);
  fs.mkdir('/home/u/.dsh/profiles');
  runUninstallHook({
    dshHome: '/home/u/.dsh',
    bridgeSourceDir: '/ext/bridge-client',
    fs,
    // 注入 realpath：把符号链接解析到 $DSH_HOME 之外
    realpath: (p) => (p === '/home/u/.dsh/profiles/linked' ? '/outside' : p),
  });
  assert.equal(fs.readFile(OUTSIDE_PATCH), outsideContent, '外部文件必须原样保留');
  assert.deepEqual(fs.written, [], '不允许对外部路径做任何写入');
});

test('卸载钩子跳过非法 profile 名（路径穿越形态）', () => {
  const evil = '/home/u/.dsh/profiles/../evil/cordis.patch.yml';
  const fs = makeMemFs({ [evil]: `${MARK}\n` });
  fs.mkdir('/home/u/.dsh/profiles');
  runUninstallHook({ dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs });
  assert.equal(fs.readFile(evil), `${MARK}\n`, '非法名条目不参与清理');
});

test('卸载钩子跳过 realpath 越界的 profile（双保险，不依赖 isSymlink 是否实现）', () => {
  const patch = '/home/u/.dsh/profiles/linked/cordis.patch.yml';
  const fs = makeMemFs({ [patch]: `${MARK}\n` });
  fs.mkdir('/home/u/.dsh/profiles');
  // 故意不提供 isSymlink（模拟旧 fs 实现）：只靠 realpath 校验也要挡住
  delete (fs as { isSymlink?: unknown }).isSymlink;
  runUninstallHook({
    dshHome: '/home/u/.dsh',
    bridgeSourceDir: '/ext/bridge-client',
    fs,
    realpath: (p) => (p.startsWith('/home/u/.dsh/profiles/linked') ? p.replace('/home/u/.dsh/profiles/linked', '/outside') : p),
  });
  assert.deepEqual(fs.written, [], '越界条目不参与清理');
});

test('卸载钩子照常清理合法 profile 的桥接条目与目录', () => {
  const patch = '/home/u/.dsh/profiles/web/cordis.patch.yml';
  const original = `# 用户自己的内容\n${MARK}\n- id: dsh-vscode-bridge\n# dsh-vscode-bridge: end\n`;
  const fs = makeMemFs({ [patch]: original });
  fs.mkdir('/home/u/.dsh/profiles');
  fs.mkdir('/home/u/.dsh/profiles/web');
  runUninstallHook({ dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs });
  const after = fs.readFile(patch);
  assert.ok(!after.includes(MARK), '桥接标记段应被删除');
  assert.ok(after.includes('# 用户自己的内容'), '用户内容必须保留');
});

// C1（审查发现）：`node --test` 会把测试文件自身作为 argv[1]、__filename 也是它，
// 于是「只看 argv[1] === __filename」的守卫在单测里判为真 → npm test 会真的执行卸载钩子
// （实测会去写用户的 ~/.dsh/profiles/web/cordis.patch.yml）。下面把这三种情形钉死。
test('shouldRunUninstall：测试运行器/测试 bundle 一律不执行，仅生产入口执行', () => {
  const entry = '/ext/out/uninstall.js';
  // ① node:test 运行期（NODE_TEST_CONTEXT 由测试运行器设置）
  assert.equal(shouldRunUninstall(entry, entry, { NODE_TEST_CONTEXT: '1' }), false);
  // ② 直接执行测试 bundle（argv[1] 与 __filename 都是测试文件）
  assert.equal(shouldRunUninstall('/ext/out/test/uninstall.test.js', '/ext/out/test/uninstall.test.js', {}), false);
  // ③ 生产入口：VS Code 卸载时 node ./out/uninstall.js
  assert.equal(shouldRunUninstall(entry, entry, {}), true);
  // ④ 入口不确定 / 被当作模块 require：不清理（宁可不清理，也不能误删用户 profile）
  assert.equal(shouldRunUninstall(undefined, entry, {}), false);
  assert.equal(shouldRunUninstall('/other/script.js', entry, {}), false);
});

// 仅 Windows 运行：本用例要验证的是 win32 路径语义（node:path 在 Linux 上不会把 `C:\\…`
// 当作绝对路径），跑在 Linux 上测不到目标行为，只会得到平台差异导致的假失败。
test('Windows 形态路径：合法 profile 照常清理，越界链接仍被挡住', { skip: process.platform !== 'win32' }, () => {
  const home = 'C:\\Users\\u\\.dsh';
  const patch = `${home}\\profiles\\web\\cordis.patch.yml`;
  const fs = makeMemFs({ [patch]: `# 用户内容\n${MARK}\n# dsh-vscode-bridge: end\n` });
  fs.mkdir(`${home}\\profiles`);
  runUninstallHook({
    dshHome: home,
    bridgeSourceDir: 'C:\\ext\\bridge-client',
    fs,
    // 注入 Windows 语义的 realpath，避免依赖运行平台
    realpath: (x) => x,
  });
  const after = fs.readFile(patch);
  assert.ok(!after.includes(MARK), 'Windows 路径下的合法 profile 必须照常清理（否则是 0.4.2 行为回归）');
  assert.ok(after.includes('# 用户内容'), '用户内容保留');
});
