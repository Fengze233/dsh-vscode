// test/package.test.ts — package.json 静态贡献与设置的回归校验（v0.3.0）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { installBridge, createNodeFs } from '../src/bridge/installer';
import { PROFILE_NAME_PATTERN } from '../src/config';

function pkg() {
  return JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
}

test('extensionKind 优先 workspace（远程场景跑在远端）', () => {
  const p = pkg();
  assert.ok(Array.isArray(p.extensionKind));
  assert.equal(p.extensionKind[0], 'workspace');
});

test('编辑器标题栏图标：紧凑画布 + 明暗两套单色资源（issue #46）', () => {
  const p = pkg();
  const cmd = p.contributes.commands.find((c: { command: string }) => c.command === 'dsh.openFromTitle');
  assert.ok(cmd, '存在 dsh.openFromTitle 命令');
  // issue #46：VS Code 不会给扩展图标按主题着色，所以只能用 {light, dark} 两份单色资源，
  // 并且不再有白色底块（白色圆角底是 v0.3.0 为解决深色主题不可见加的临时方案）。
  assert.deepEqual(cmd.icon, {
    light: 'assets/whale-icon-light.svg',
    dark: 'assets/whale-icon-dark.svg',
  }, '右上角命令图标应为明暗两套单色图标');
  const root = join(__dirname, '..', '..');
  for (const [file, fill] of [
    ['assets/whale-icon-light.svg', '#424242'],
    ['assets/whale-icon-dark.svg', '#C5C5C5'],
  ] as const) {
    assert.ok(existsSync(join(root, file)), `${file} 应存在`);
    const svg = readFileSync(join(root, file), 'utf8');
    assert.ok(!svg.includes('#FFFFFF'), `${file} 不得再含白色背景块`);
    assert.ok(svg.includes(fill), `${file} 应使用单色填充 ${fill}`);
    // 紧凑画布：viewBox 紧贴内容（不再是 0 0 128 128），否则内容只占约 73%，看起来偏小
    assert.ok(!svg.includes('viewBox="0 0 128 128"'), `${file} 应使用紧贴内容的 viewBox`);
    // 鲸鱼是宽扁造型，等比缩放时永远显矮：用 preserveAspectRatio="none" 纵向拉满，视觉尺寸才与 codicon 一致
    assert.ok(svg.includes('preserveAspectRatio="none"'), `${file} 应纵向拉满（preserveAspectRatio="none"）`);
  }
  const menu: { command: string; group?: string }[] = p.contributes.menus['editor/title'] || [];
  const item = menu.find((m) => m.command === 'dsh.openFromTitle');
  assert.ok(item, 'editor/title 菜单包含该命令');
  assert.ok(String(item.group).startsWith('navigation'), '组为 navigation（标签栏右侧图标区）');
});

test('存在手动清理图片缓存命令 dsh.cleanupImageCache', () => {
  const p = pkg();
  const cmd = p.contributes.commands.find((c: { command: string }) => c.command === 'dsh.cleanupImageCache');
  assert.ok(cmd, '存在 dsh.cleanupImageCache 命令');
  assert.ok(String(cmd.title).includes('dsh.cmd.cleanupImageCache.title'), '命令标题走本地化');
  assert.ok(Array.isArray(p.activationEvents) && p.activationEvents.includes('onCommand:dsh.cleanupImageCache'), '需声明激活事件');
});

test('活动栏/辅助侧边栏容器图标必须单文件（viewsContainers.icon 只接受路径字符串）', () => {
  const p = pkg();
  // 真机 + v0.3.0 的教训：容器图标传 {light,dark} 对象会被渲染成空白占位方块
  // （VS Code 的 viewsContainers 扩展点 schema 里 icon 只声明为 string）。
  for (const container of [...p.contributes.viewsContainers.activitybar, ...p.contributes.viewsContainers.secondarySidebar]) {
    assert.equal(container.icon, 'assets/whale-icon.svg', container.id + ' 应使用单文件图标');
  }
  const file = join(__dirname, '..', '..', 'assets', 'whale-icon.svg');
  assert.ok(existsSync(file), '容器图标文件应存在');
  const svg = readFileSync(file, 'utf8');
  assert.ok(svg.includes('#8A8A8A'), '容器图标用中性灰：#1F1F1F 与 #FFFFFF 上都可辨');
  assert.ok(svg.includes('preserveAspectRatio="none"'), '容器图标同样纵向拉满，避免显小');
});

test('v0.3.0 设置项：remote.enabled 默认 false、image.fallback 默认 true、openInBrowser 默认 false', () => {
  const p = pkg();
  const props = p.contributes.configuration.properties;
  assert.equal(props['dsh.remote.enabled'].default, false);
  assert.equal(props['dsh.image.fallback'].default, true);
  assert.equal(props['dsh.openInBrowser'].default, false);
  assert.equal(props['dsh.profile'].type, 'string');
  assert.equal(props['dsh.profile'].default, 'web');
  assert.equal(props['dsh.profile'].markdownDescription, '%dsh.config.profile%');
  assert.equal(props['dsh.profile'].pattern, PROFILE_NAME_PATTERN.source);
  assert.equal(props['dsh.launchPreference'].type, 'string');
  assert.equal(props['dsh.launchPreference'].default, 'auto');
  assert.deepEqual(props['dsh.launchPreference'].enum, ['auto', 'npm', 'desktop']);
  assert.equal(props['dsh.launchPreference'].markdownDescription, '%dsh.config.launchPreference%');
  assert.equal(props['dsh.desktopCommandPath'].type, 'string');
  assert.equal(props['dsh.desktopCommandPath'].default, '');
  assert.equal(props['dsh.desktopCommandPath'].markdownDescription, '%dsh.config.desktopCommandPath%');
});

test('桥接版本与插件版本统一（一同随包发布），且卸载钩子自动清理桥接', () => {
  const p = pkg();
  // ① 卸载钩子：VS Code 卸载扩展时执行 node ./out/uninstall.js
  assert.equal(p.uninstall, 'node ./out/uninstall.js', 'package.json 应声明 uninstall 钩子');
  // ② 版本统一：bridge-client 版本 === 插件版本（防止日后漂移）
  const bridge = JSON.parse(readFileSync(join(__dirname, '..', '..', 'bridge-client', 'package.json'), 'utf8'));
  assert.equal(bridge.version, p.version, '桥接包版本必须与插件版本一致（一同被上传到商城）');
  // ③ 握手诊断日志随版本号（DevTools 排查依据；client.js 用 BRIDGE_VERSION 常量拼接）
  const client = readFileSync(join(__dirname, '..', '..', 'bridge-client', 'lib', 'client.js'), 'utf8');
  assert.ok(client.includes('const BRIDGE_VERSION = "' + p.version + '";'), 'client.js 应声明 BRIDGE_VERSION = ' + p.version);
  assert.ok(client.includes('ok, v" + BRIDGE_VERSION'), '握手日志应使用 BRIDGE_VERSION 常量拼接');
  assert.ok(client.includes('buildSyncWorkspaceAck(true, undefined, BRIDGE_VERSION)'), '握手回执应携带桥接版本');
  // ④ 构建产物应包含卸载脚本（build.mjs 在两种模式下都会构建 out/uninstall.js）
  assert.ok(existsSync(join(__dirname, '..', 'uninstall.js')), '构建产物应包含 out/uninstall.js');
  // 仅使用 Node 的卸载钩子也必须清理自定义 profile，
  // 没有本扩展桥接标记的 profile 保持原样。
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-profile-uninstall-'));
  try {
    const fs = createNodeFs();
    for (const profile of ['web', 'custom-profile']) {
      mkdirSync(join(dshHome, 'profiles', profile), { recursive: true });
      const result = installBridge({
        dshHome, profile, fs, bridgeSourceDir: join(__dirname, '..', 'bridge-client'),
      });
      assert.equal(result.status, 'ok');
    }
    const otherPatch = join(dshHome, 'profiles', 'other', 'cordis.patch.yml');
    mkdirSync(join(dshHome, 'profiles', 'other'), { recursive: true });
    writeFileSync(otherPatch, '# user content\n[]\n');
    // 子进程环境必须清掉测试运行器标记：node --test 会把 NODE_TEST_CONTEXT 传下去，
    // 而卸载钩子据它拒绝执行（该守卫是为了防止单测误清理用户真实的 ~/.dsh）。
    // 真实卸载场景（VS Code 执行 node out/uninstall.js）没有这个变量。
    const childEnv: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dshHome, APPDATA: dshHome };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [join(__dirname, '..', 'uninstall.js')], {
      env: childEnv, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const profile of ['web', 'custom-profile']) {
      assert.equal(readFileSync(join(dshHome, 'profiles', profile, 'cordis.patch.yml'), 'utf8'), '[]\n');
      assert.equal(existsSync(join(dshHome, 'profiles', profile, 'node_modules', 'dsh-vscode-bridge')), false);
    }
    assert.equal(existsSync(join(dshHome, 'profiles', 'node_modules', 'dsh-vscode-bridge')), false);
    assert.equal(readFileSync(otherPatch, 'utf8'), '# user content\n[]\n');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ——— issue #27 回归防线（0.4.2 撤回 PR #11 后固化） ———
// 背景：#27 的现象是「切一次活动编辑器，面板整页重载一次」。根因是活动编辑器变化 →
// 工具条刷新 → render() → webview 文档重建（nonce 每次重生成）。该链路随 PR #11 撤回移除。
// 这里用源码静态断言把「不得复活该链路」固化下来——它同时是自动化回归证据：
// 一旦有人重新接上"文件切换触发刷新"，本测试立即失败。
test('#27 回归：活动编辑器变化不得触发面板刷新/重载链路', () => {
  const root = join(__dirname, '..', '..');
  const src = readFileSync(join(root, 'src', 'extension.ts'), 'utf8');
  const provider = readFileSync(join(root, 'src', 'panel', 'provider.ts'), 'utf8');

  // ① 不得监听活动编辑器变化（v0.5.0 的 tracker.setFile 入口）
  assert.ok(!src.includes('onDidChangeActiveTextEditor'), '不得订阅 onDidChangeActiveTextEditor');
  // ② 上下文跟踪器整体不存在（含 onSettled / setFile / setDebounceMs 等入口）
  assert.ok(!/tracker/i.test(src), 'extension.ts 不得再有 tracker 相关代码');
  // ③ 刷新入口只允许由配置变更触发：extension.ts 中恰好 2 处调用（两个面板各一次）
  const total = (src.match(/refreshContextBar/g) ?? []).length;
  assert.equal(total, 2, 'extension.ts 中只应有 2 处 refreshContextBar 调用（配置变更时两个面板）');
  const fnStart = src.indexOf('function onConfigChanged()');
  assert.ok(fnStart > 0, '存在 onConfigChanged');
  const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
  assert.equal((fnBody.match(/refreshContextBar/g) ?? []).length, 2, '仅配置变更回调内调用（两个面板各一次）');
  // ④ 工具条下行消息同步通道不得复活（它只服务于已撤回的上下文工具条）
  assert.ok(!provider.includes("kind: 'updateContextBar'"), '不得再有 updateContextBar 下行消息');
  // ⑤ 渲染不得注入"当前文件名"（#27 的放大器：文件名进 HTML → 每次文件切换 HTML 都不同）
  assert.ok(!provider.includes('fileLabel'), 'provider 不得再向模板注入 fileLabel');
  // ⑥ 已撤回的右键命令不得复活。
  // 注意：v0.5.0 起 `explorer/context` 被新功能（「DSH → 添加到对话」）占用，
  // 所以这里不再断言整块菜单不存在，改为断言已撤回的上下文命令没有被接回来。
  const p = pkg();
  const withdrawn = (id: string): boolean => id.startsWith('dsh.addFileContext') || id.startsWith('dsh.askAbout');
  for (const menu of ['editor/context', 'explorer/context', 'editor/title/context']) {
    for (const item of p.contributes.menus[menu] ?? []) {
      assert.ok(!withdrawn(String(item.command ?? '')), `菜单 ${menu} 不得复活已撤回命令：${item.command}`);
    }
  }
  assert.ok(!p.contributes.commands.some((c: { command: string }) => withdrawn(c.command)), '命令表不得复活已撤回命令');
});

// 缩放（issue #8）在 0.4.2 中保留：它是唯一需要"重渲染才生效"的设置项，
// 上面 ③ 的断言依赖它仍然接线，这里同时固化"缩放不能被误删"。
test('#27 回归：面板缩放仍接线且传参位置正确（0.4.2 保留 issue #8）', () => {
  const root = join(__dirname, '..', '..');
  const provider = readFileSync(join(root, 'src', 'panel', 'provider.ts'), 'utf8');
  const html = readFileSync(join(root, 'src', 'panel', 'html.ts'), 'utf8');
  assert.ok(provider.includes('this.ui.zoomLevel?.() ?? 1'), 'provider 仍读取 zoomLevel');
  // readyPage 第 4 个参数必须是 zoomLevel（撤回 contextBar 后不能还留着 undefined 占位）
  assert.ok(/readyPage\(\s*frameUrl,\s*ctx,\s*\{[\s\S]*?\},\s*\/\/[^\n]*\n\s*this\.ui\.zoomLevel/.test(provider),
    'readyPage 第 4 参应为 zoomLevel');
  assert.ok(html.includes('--dshv-zoom'), '缩放 CSS 变量仍在');
});

// ——— 文档与测试数一致性 ———
// README/CHANGELOG 里的测试数在发布流程中被反复手改（326 → 275 → 277 → 283），
// README 与 CHANGELOG 当前版本段按静态计数校验，已发布版本保留历史数字。
// 当前版本段：开发期是 [Unreleased]，定版后是最近的 [X.Y.Z] —— 两种形态都要能校验，
// 否则「定版提交」本身会把仓库守卫弄失败。
test('README 中英与 CHANGELOG 当前版本测试数等于实际测试数，历史数字保持一致', () => {
  const root = join(__dirname, '..', '..');
  // ① 静态计数：递归 test/ 下所有 *.test.ts 的顶层 test( 调用
  const stack = [join(root, 'test')];
  let count = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
      } else if (entry.name.endsWith('.test.ts')) {
        count += (readFileSync(p, 'utf8').match(/^test\(/gm) ?? []).length;
      }
    }
  }
  assert.ok(count > 200, `静态计数应达到数百条，实际 ${count}`);

  // ② README（中英）在 npm run test 的注释里声明了同一个数字
  for (const file of ['README.md', 'README.zh.md']) {
    const text = readFileSync(join(root, file), 'utf8');
    const m = /npm run test\s+# (\d+) /.exec(text);
    assert.ok(m, `${file} 应声明测试数`);
    assert.equal(Number(m[1]), count, `${file} 声明的测试数应与实际一致（实际 ${count}）`);
  }

  // ③ CHANGELOG 当前版本段（开发期 [Unreleased]，定版后最近的 [X.Y.Z]）
  // 记录当前测试数，避免为新增用例修改已发布版本。
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const current = /## \[(?:Unreleased|\d+\.\d+\.\d+)\][^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(changelog);
  assert.ok(current, 'CHANGELOG 应包含未发布节或最近版本节');
  const currentCount = /测试用例共 (\d+) 个/.exec(current[1]);
  assert.ok(currentCount, 'CHANGELOG 当前版本段应写明当前测试数');
  assert.equal(Number(currentCount[1]), count, 'CHANGELOG 当前测试数应与实际一致');
  // ④ 已发布 0.4.2 段落的 "npm test X/X 全绿" 与 "由 A 降至 X" 保持一致。
  const green = /`npm test` (\d+)\/\1 全绿/.exec(changelog);
  assert.ok(green, 'CHANGELOG 应写明 npm test 全绿的数量');
  const dropped = /测试用例由 (\d+) 降至 (\d+)/.exec(changelog);
  assert.ok(dropped, 'CHANGELOG 应写明测试数的变化');
  // 历史版本的测试数不随新增用例变化，只验证同一版本段落内的数字一致。
  assert.equal(Number(dropped[2]), Number(green[1]), 'CHANGELOG 同一版本的测试数应一致');
  assert.ok(Number(dropped[1]) > Number(dropped[2]), '撤回后测试数应下降');
});

// v0.5.0：资源管理器右键「将文件添加到 DSH 对话」必须是**一级**菜单项。
// 真机反馈：二级子菜单要点两次才选得到，和 VS Code 内置的「将文件添加到聊天」不一致。
test('explorer/context 直接暴露「添加到对话」，不使用二级子菜单', () => {
  const p = pkg();
  const items: Array<{ command?: string; submenu?: string; group?: string }> =
    p.contributes.menus['explorer/context'] ?? [];
  const item = items.find((m) => m.command === 'dsh.addToChat');
  assert.ok(item, 'explorer/context 应有 dsh.addToChat');
  assert.equal(item.submenu, undefined, '不应再通过 submenu 包一层');
  assert.ok(String(item.group).startsWith('1_modification'), '应与内置「将文件添加到聊天」同分组');
  assert.ok(!(p.contributes.submenus ?? []).some((s: { id: string }) => s.id === 'dsh.chat'), '不再声明 DSH 子菜单');
});
