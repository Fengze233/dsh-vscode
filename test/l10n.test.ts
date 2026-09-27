// test/l10n.test.ts — 本地化一致性守卫
//
// 背景：扩展有两套文案通道——
//   ① 静态文案：package.json 里的 %key% 由 VS Code 用 package.nls.<locale>.json 解析（清单层）；
//   ② 运行时文案：src/i18n.ts 的 messages（状态栏、占位页、错误提示、日志等）。
// l10n/bundle.l10n*.json 是清单 l10n 机制的占位（扩展未使用 vscode.l10n.t()，故键集为空）。
// 两套通道的键一旦漂移，用户就会看到「键名」或空白，且编译期不会报错——本文件把一致性固化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initI18n, t, type MsgKey } from '../src/i18n';

/** 仓库根目录（当前文件位于 out/test/ 或 src 同级的 test/ 下，均回退两级） */
const root = join(__dirname, '..', '..');

function readJson(rel: string): Record<string, string> {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, string>;
}

test('package.nls 三份语言文件键集完全一致（缺键会让界面显示原始键名）', () => {
  const en = Object.keys(readJson('package.nls.json')).sort();
  const zhCn = Object.keys(readJson('package.nls.zh-cn.json')).sort();
  const zhHans = Object.keys(readJson('package.nls.zh-hans.json')).sort();
  assert.deepEqual(zhCn, en, 'package.nls.zh-cn.json 键集应与 package.nls.json 一致');
  assert.deepEqual(zhHans, en, 'package.nls.zh-hans.json 键集应与 package.nls.json 一致');
  // 反向护栏：撤回 PR #11 后不得残留上下文相关键（它们会让已移除的设置/命令"复活"占位文案）
  const leftovers = en.filter((k) => k.startsWith('dsh.context.') || k.startsWith('dsh.cmd.addFileContext') || k.startsWith('dsh.cmd.askAbout'));
  assert.deepEqual(leftovers, [], '不得残留已撤回功能的 nls 键');
});

test('package.json 引用的每个 %key% 都有对应 nls 文案（且无未引用的冗余键）', () => {
  const pkgRaw = readFileSync(join(root, 'package.json'), 'utf8');
  const refs = new Set<string>();
  for (const m of pkgRaw.matchAll(/%([A-Za-z0-9._-]+)%/g)) refs.add(m[1]);
  assert.ok(refs.size > 30, `package.json 应引用多个本地化键，实际 ${refs.size}`);
  const nlsKeys = Object.keys(readJson('package.nls.json'));
  const missing = [...refs].filter((k) => !nlsKeys.includes(k));
  const unused = nlsKeys.filter((k) => !refs.has(k));
  assert.deepEqual(missing, [], 'package.json 引用了但 nls 中缺失的键');
  assert.deepEqual(unused, [], 'nls 中定义但 package.json 未引用的冗余键');
});

test('l10n/bundle.l10n 三份键集一致（清单 l10n 通道）', () => {
  const en = Object.keys(readJson('l10n/bundle.l10n.json')).sort();
  const zhCn = Object.keys(readJson('l10n/bundle.l10n.zh-cn.json')).sort();
  const zhHans = Object.keys(readJson('l10n/bundle.l10n.zh-hans.json')).sort();
  assert.deepEqual(zhCn, en);
  assert.deepEqual(zhHans, en);
});

// 撤回 PR #11 时删掉了 16 条 ctx.* 运行时文案，两侧的键数必须仍然相等。
// 该断言在键漂移时会失败——这是"编译期保证不了"的那部分一致性。
test('i18n 中英文键数一致，且两侧文案均非空', () => {
  const src = readFileSync(join(root, 'src', 'i18n.ts'), 'utf8');
  const lines = src.split('\n');
  // 顶层语言块起始行：缩进两格的 `en: {` / `zh: {`
  const starts: Array<{ lang: string; idx: number }> = [];
  lines.forEach((line, idx) => {
    const m = /^ {2}(en|zh): \{$/.exec(line);
    if (m) starts.push({ lang: m[1], idx });
  });
  // messages 顶层应恰好两个语言块（若将来新增语言，此断言会提示同步更新本测试）
  assert.deepEqual(starts.map((s) => s.lang), ['en', 'zh'], 'i18n messages 顶层语言块');
  const counts = starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].idx : lines.length;
    return lines.slice(s.idx, end).filter((l) => /^ {4}'[^']+':/.test(l)).length;
  });
  assert.equal(counts[0], counts[1], `中英文文案条数应相等（en=${counts[0]}, zh=${counts[1]}）`);
  // 撤回 PR #11 后基数为 51 条（原 67 条，删掉 16 条 ctx.*）；低于 45 说明文案被误删
  assert.ok(counts[0] >= 45, `运行时文案条数应 ≥45，实际 ${counts[0]}`);
});

test('已撤回的上下文档位：i18n 中不得再出现 ctx.* 文案', () => {
  const src = readFileSync(join(root, 'src', 'i18n.ts'), 'utf8');
  assert.ok(!/'ctx\./.test(src), 'i18n 不得残留 ctx.* 文案');
});

test('每条运行时文案都能取到值（抽样覆盖各功能域）', () => {
  const keys: MsgKey[] = [
    'panel.loading',
    'panel.errorTitle',
    'bridge.warnDegraded',
    'msg.logsCopied',
    'msg.imageCacheCleaned',
  ];
  for (const lang of ['en', 'zh-cn'] as const) {
    initI18n(lang);
    for (const k of keys) {
      const v = t(k);
      assert.ok(typeof v === 'string' && v.length > 0, `${lang} 的 ${k} 应有文案`);
      assert.notEqual(v, k, `${lang} 的 ${k} 不应回退为键名`);
    }
  }
  initI18n('en'); // 复位，避免影响其它测试文件（node --test 同进程内文件级隔离有限）
});
