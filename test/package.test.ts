// test/package.test.ts — package.json 静态贡献与设置的回归校验（v0.3.0）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function pkg() {
  return JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
}

test('extensionKind 优先 workspace（远程场景跑在远端）', () => {
  const p = pkg();
  assert.ok(Array.isArray(p.extensionKind));
  assert.equal(p.extensionKind[0], 'workspace');
});

test('右上角图标命令与 editor/title 菜单（v0.3.0）', () => {
  const p = pkg();
  const cmd = p.contributes.commands.find((c: { command: string }) => c.command === 'dsh.openFromTitle');
  assert.ok(cmd, '存在 dsh.openFromTitle 命令');
  // 右上角图标：原鲸鱼 + 白底（明暗主题都清晰可见），不再用明暗双主题变体
  assert.equal(cmd.icon, 'assets/whale-icon-bg.svg', '右上角命令图标应为白底鲸鱼');
  assert.ok(existsSync(join(__dirname, '..', '..', 'assets', 'whale-icon-bg.svg')), '白底鲸鱼图标文件应存在');
  const bg = readFileSync(join(__dirname, '..', '..', 'assets', 'whale-icon-bg.svg'), 'utf8');
  assert.ok(bg.includes('#FFFFFF'), '白底图标应含白色背景');
  assert.ok(bg.includes('#000000'), '白底图标应保留原黑色鲸鱼路径');
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

test('活动栏/辅助侧边栏容器图标保持原始鲸鱼图标（assets/whale-icon.svg）', () => {
  const p = pkg();
  for (const container of [...p.contributes.viewsContainers.activitybar, ...p.contributes.viewsContainers.secondarySidebar]) {
    assert.equal(container.icon, 'assets/whale-icon.svg', container.id + ' 应保持原始鲸鱼图标');
  }
  assert.ok(existsSync(join(__dirname, '..', '..', 'assets', 'whale-icon.svg')), '原始鲸鱼图标文件应存在');
});

test('v0.3.0 设置项：remote.enabled 默认 false、image.fallback 默认 true、openInBrowser 默认 false', () => {
  const p = pkg();
  const props = p.contributes.configuration.properties;
  assert.equal(props['dsh.remote.enabled'].default, false);
  assert.equal(props['dsh.image.fallback'].default, true);
  assert.equal(props['dsh.openInBrowser'].default, false);
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
