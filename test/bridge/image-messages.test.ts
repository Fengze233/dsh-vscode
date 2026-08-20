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
  imageCacheKey,
  unwrapRpcPayload,
  buildTextResendRequest,
  resolveFetchUrl,
  rewriteRpcId,
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
  // 地址行：以「图片：<绝对路径>」自然标注，不含"插件风格"解释文案
  assert.equal(buildImagePointerLine('/w/x.png'), '图片：/w/x.png');
  // 无指针时保持原文本
  assert.equal(buildTextOnlyContent([{ type: 'text', text: 'a' }], []).length, 1);
});

test('imageCacheKey', () => {
  assert.equal(imageCacheKey({ name: 'x.png', size: 10, lastModified: 5 }), 'x.png:10:5');
  assert.equal(imageCacheKey({ name: '', size: 1, lastModified: 2 }), null);
  assert.equal(imageCacheKey(null), null);
});
test('unwrapRpcPayload：{rpcId,payload} 包裹解包，直传形态原样返回', () => {
  const payload = { sessionId: 's1', content: [{ type: 'image' }] };
  const wrapped = { rpcId: 'r1', payload };
  assert.equal(unwrapRpcPayload(wrapped), payload, '包裹形态应返回 payload');
  const direct = { content: [{ type: 'text', text: 'hi' }] };
  assert.equal(unwrapRpcPayload(direct), direct, '直传形态应原样返回');
  const empty = {};
  assert.equal(unwrapRpcPayload(empty), empty);
  assert.equal(unwrapRpcPayload(null), null);
});

test('buildTextResendRequest：换新 rpcId、保留 payload 其余字段、content 替换为纯文本', () => {
  const content = buildTextOnlyContent([{ type: 'image' }, { type: 'text', text: 'hi' }], [buildImagePointerLine('/w/x.png')]);
  const body = { rpcId: 'old-1', payload: { sessionId: 's1', mode: 'queue', content: [{ type: 'image' }] } };
  const req = buildTextResendRequest(body, content);
  assert.notEqual(req.rpcId, 'old-1');
  assert.equal(req.payload.sessionId, 's1');
  assert.equal(req.payload.mode, 'queue');
  assert.ok(Array.isArray(req.payload.content));
  assert.equal((req.payload.content as unknown[]).length, 1);
});
test('rewriteRpcId：把响应 rpcId 改写为指定值（降级重发响应交回 DSH 用）', async () => {
  const rpcResp = new Response(JSON.stringify({ rpcId: 'vsc-fb-new', result: { ok: true, value: { accepted: true } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const rew = await rewriteRpcId(rpcResp as unknown as Response, 'orig-42');
  const json = (await rew.json()) as { rpcId: string; result: { ok: boolean; value: { accepted: boolean } } };
  assert.equal(json.rpcId, 'orig-42');
  assert.equal(json.result.ok, true);
  assert.equal(json.result.value.accepted, true);
  assert.equal(rew.status, 200);
  // 非 JSON 响应：原样返回，不改写
  const raw = new Response('not json', { status: 500 });
  assert.equal(await rewriteRpcId(raw as unknown as Response, 'x'), raw);
  // 无 rpcId 字段的 JSON：原样返回
  const noId = new Response(JSON.stringify({ ok: 1 }));
  assert.equal(await rewriteRpcId(noId as unknown as Response, 'x'), noId);
});

test('resolveFetchUrl：兼容 string / URL(href) / Request(url)，无效输入返回空串', () => {
  assert.equal(resolveFetchUrl('http://127.0.0.1:3080/api/prompt'), 'http://127.0.0.1:3080/api/prompt');
  assert.equal(resolveFetchUrl({ href: 'http://127.0.0.1:3080/api/prompt' }), 'http://127.0.0.1:3080/api/prompt');
  assert.equal(resolveFetchUrl({ url: 'http://127.0.0.1:3080/api/prompt' }), 'http://127.0.0.1:3080/api/prompt');
  assert.equal(resolveFetchUrl(null), '');
  assert.equal(resolveFetchUrl(undefined), '');
  assert.equal(resolveFetchUrl(42), '');
});



