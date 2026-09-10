// test/launchUrl.test.ts — dsh web 启动网址解析的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchUrlLine, tokenFromLaunchUrl, pickLaunchUrl } from '../src/service/launchUrl';

test('parseLaunchUrlLine：0.1.2 鉴权行（带 token）→ 返回完整 URL', () => {
  const line = 'dsh web: http://127.0.0.1:3080/?token=ZQpcwOGassFgG-SOxgnI4JSqJp5UmgVUqeo2rZzNYAI';
  assert.equal(parseLaunchUrlLine(line), line.slice('dsh web: '.length));
});

test('parseLaunchUrlLine：LAN 后缀同行时只取主 URL（不被并入）', () => {
  const line = 'dsh web: http://127.0.0.1:3080/?token=abc123 (LAN: http://192.168.1.5:3080/?token=abc123)';
  assert.equal(parseLaunchUrlLine(line), 'http://127.0.0.1:3080/?token=abc123');
});

test('parseLaunchUrlLine：0.1.1 及更早的裸地址行 → 返回 URL（无 token）', () => {
  assert.equal(parseLaunchUrlLine('dsh web: http://127.0.0.1:3080/'), 'http://127.0.0.1:3080/');
});

test('parseLaunchUrlLine：非 dsh web 行 / 噪音 → null', () => {
  assert.equal(parseLaunchUrlLine('[stdout] some other output'), null);
  assert.equal(parseLaunchUrlLine('dsh web: not-a-url'), null);
  assert.equal(parseLaunchUrlLine(''), null);
  assert.equal(parseLaunchUrlLine('dsh webx: http://127.0.0.1:1/'), null); // 前缀必须精确 `dsh web: `
});

test('tokenFromLaunchUrl：0.1.2 URL 提取 token', () => {
  assert.equal(
    tokenFromLaunchUrl('http://127.0.0.1:3080/?token=ZQpcwOGassFgG-SOxgnI4JSqJp5UmgVUqeo2rZzNYAI'),
    'ZQpcwOGassFgG-SOxgnI4JSqJp5UmgVUqeo2rZzNYAI',
  );
});

test('tokenFromLaunchUrl：无 token / 非法 token → null', () => {
  assert.equal(tokenFromLaunchUrl('http://127.0.0.1:3080/'), null);
  assert.equal(tokenFromLaunchUrl('http://127.0.0.1:3080/?token='), null);
  assert.equal(tokenFromLaunchUrl('http://127.0.0.1:3080/?token=!!bad!!'), null);
});

test('pickLaunchUrl：环回优先于 LAN，且端口须匹配', () => {
  const lan = 'http://192.168.1.5:3080/?token=abc';
  const loop = 'http://127.0.0.1:3080/?token=abc';
  assert.equal(pickLaunchUrl([lan, loop], 3080), loop);
  // 端口不匹配的候选被排除
  assert.equal(pickLaunchUrl([lan, loop], 3081), null);
  // 只有 LAN 候选且端口匹配：退而取之
  assert.equal(pickLaunchUrl([lan], 3080), lan);
});

test('pickLaunchUrl：localhost 也视为环回', () => {
  assert.equal(pickLaunchUrl(['http://192.168.1.5:1/?t=1', 'http://localhost:3080/?t=1'], 3080), 'http://localhost:3080/?t=1');
});
