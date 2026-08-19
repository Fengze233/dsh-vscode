// test/bridge/image-messages.test.ts — v0.3.0 图片缓存降级消息的纯逻辑单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSaveImageRequest,
  parseSaveImageAck,
  buildDeleteImagesRequest,
  parseDeleteImagesAck,
  imageCacheFilename,
  IMAGE_CACHE_EXTENSIONS,
  detectModelReject,
  isPromptWithImages,
  extractPromptText,
  buildImagePointerLine,
  buildTextOnlyContent,
  buildImageFallbackNotice,
  imageCacheKey,
} from '../../bridge-client/lib/core.js';

test('saveImage 请求构造与 ack 解析', () => {
  const req = buildSaveImageRequest('r1', 'a.png', 'AAAA', '/w/ws');
  assert.equal(req.kind, 'saveImage');
  assert.equal(req.sessionCwd, '/w/ws');
  const ok = parseSaveImageAck({ kind: 'saveImageAck', requestId: 'r1', ok: true, path: '/w/ws/x.png' }, 'r1');
  assert.equal(ok?.path, '/w/ws/x.png');
  // requestId 不匹配 → 视为无效回执
  assert.equal(parseSaveImageAck({ kind: 'saveImageAck', requestId: 'r2', ok: false }, 'r1'), null);
  // 形状不合法 → null
  assert.equal(parseSaveImageAck({ kind: 'other' }, 'r1'), null);
});

test('deleteImages 请求构造与 ack 解析', () => {
  const req = buildDeleteImagesRequest('d1', ['/a', '/b']);
  assert.equal(req.kind, 'deleteImages');
  assert.deepEqual(req.paths, ['/a', '/b']);
  assert.deepEqual(parseDeleteImagesAck({ kind: 'deleteImagesAck', requestId: 'd1', ok: true }, 'd1'), { ok: true });
  assert.equal(parseDeleteImagesAck({ kind: 'deleteImagesAck', requestId: 'other', ok: true }, 'd1'), null);
});

test('缓存文件名：白名单扩展名可用，非法扩展名拒绝', () => {
  assert.ok(imageCacheFilename('x', 0, '.png')?.startsWith('dsh-imgcache-'));
  assert.equal(imageCacheFilename('x', 0, '.exe'), null);
  assert.equal(imageCacheFilename('x', 0, 'png'), null);
  assert.equal(imageCacheFilename('x', 0, '.JPG')?.endsWith('.jpg'), true);
  assert.ok(IMAGE_CACHE_EXTENSIONS.length > 0);
});
test('detectModelReject：识别 MODEL_DOES_NOT_SUPPORT_IMAGES（兼容三种形状）', () => {
  assert.equal(detectModelReject({ code: 'attachment-error', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } }), true);
  assert.equal(detectModelReject({ result: { ok: false, error: { code: 'attachment-error', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } } } }), true);
  assert.equal(detectModelReject({ ok: false, error: { code: 'attachment-error', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } } }), true);
  assert.equal(detectModelReject({ code: 'attachment-error', details: { reason: 'IMAGE_TOO_LARGE' } }), false);
  assert.equal(detectModelReject({}), false);
  assert.equal(detectModelReject(null), false);
});

test('isPromptWithImages / extractPromptText / buildTextOnlyContent', () => {
  assert.equal(isPromptWithImages([{ type: 'image' }, { type: 'text', text: 'hi' }]), true);
  assert.equal(isPromptWithImages([{ type: 'text', text: 'hi' }]), false);
  assert.equal(extractPromptText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
  const built = buildTextOnlyContent([{ type: 'text', text: 'a' }, { type: 'image' }], [buildImagePointerLine('/w/x.png')]);
  assert.equal(built.length, 1);
  assert.equal(built[0].type, 'text');
  assert.ok(built[0].text.includes('/w/x.png'));
  assert.ok(built[0].text.includes('a'));
  // 无指针时保持原文本
  assert.equal(buildTextOnlyContent([{ type: 'text', text: 'a' }], []).length, 1);
});

test('buildImageFallbackNotice / imageCacheKey', () => {
  const n = buildImageFallbackNotice(['/a.png']);
  assert.equal(n.kind, 'imageFallback');
  assert.deepEqual(n.paths, ['/a.png']);
  assert.equal(imageCacheKey({ name: 'x.png', size: 10, lastModified: 5 }), 'x.png:10:5');
  assert.equal(imageCacheKey({ name: '', size: 1, lastModified: 2 }), null);
  assert.equal(imageCacheKey(null), null);
});

