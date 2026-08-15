// test/i18n.test.ts — i18n 语言规则与变量替换的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initI18n, getLang, t } from '../src/i18n';

test('zh-* 语言使用中文文案', () => {
  initI18n('zh-cn');
  assert.equal(getLang(), 'zh');
  assert.equal(t('panel.loading'), '正在启动 DSH 服务…');
});

test('非 zh 语言一律使用英文文案', () => {
  initI18n('en');
  assert.equal(getLang(), 'en');
  assert.equal(t('panel.loading'), 'Starting DSH service…');
  initI18n('ja');
  assert.equal(getLang(), 'en');
  initI18n('de');
  assert.equal(getLang(), 'en');
});

test('大小写不敏感：ZH-cn 判定为中文', () => {
  initI18n('ZH-cn');
  assert.equal(getLang(), 'zh');
});

test('t() 支持 {变量} 替换', () => {
  initI18n('en');
  assert.equal(
    t('err.portOccupied', { port: 3080 }),
    'Port 3080 is occupied by another program. Change dsh.port in settings, then retry.',
  );
});
