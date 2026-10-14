// test/uninstall.test.ts — 卸载钩子的 profile 遍历守卫（PR #35 把清理面扩大到 profiles/* 之后的安全前提）
// 用内存 fs + 注入 realpath，完全离线：验证「符号链接 / 非法名 / 越界路径」三类条目不会被改写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUninstallHook } from '../src/uninstall';
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
