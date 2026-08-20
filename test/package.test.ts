// test/package.test.ts — package.json 静态贡献与设置的回归校验（v0.3.0）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('v0.3.0 设置项：remote.enabled 默认 false、image.fallback 默认 false(已停用)、openInBrowser 默认 false', () => {
  const p = pkg();
  const props = p.contributes.configuration.properties;
  assert.equal(props['dsh.remote.enabled'].default, false);
  assert.equal(props['dsh.image.fallback'].default, false); // 图片降级已停用
  assert.equal(props['dsh.openInBrowser'].default, false);
});
