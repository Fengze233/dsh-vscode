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
  assert.ok(typeof cmd.icon === 'string' && cmd.icon.startsWith('assets/'), '命令图标应为扩展内资源路径（鲸鱼图标）');
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
  // ③ 握手诊断日志随版本号（DevTools 排查依据）
  const client = readFileSync(join(__dirname, '..', '..', 'bridge-client', 'lib', 'client.js'), 'utf8');
  assert.ok(client.includes('handshake ok, v' + p.version + ','), '握手日志应同步版本号 v' + p.version);
  // ④ 构建产物应包含卸载脚本（build.mjs 在两种模式下都会构建 out/uninstall.js）
  assert.ok(existsSync(join(__dirname, '..', 'uninstall.js')), '构建产物应包含 out/uninstall.js');
});
