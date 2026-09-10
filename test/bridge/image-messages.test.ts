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
  imageBlocksOf,
  matchCapturedImages,
  extractPromptText,
  zhOrdinal,
  buildImagePointerLine,
  buildTextOnlyContent,
  imageCacheKey,
  unwrapRpcPayload,
  unwrapRpcRequest,
  normalizeRpcMethod,
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

test('detectModelReject：DSH ≥0.1.2 新错误码 session/attachment-invalid（服务端拒绝码已改）', () => {
  // 服务端 dsh-api-session-controller：RemoteError('session/attachment-invalid', …, { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
  const wire = {
    type: 'server-response',
    rpcId: 'r1',
    result: { ok: false, error: { code: 'session/attachment-invalid', message: 'Model "x" does not support image input.', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } } },
  };
  assert.equal(detectModelReject(wire), true, '0.1.2 的 /api 响应必须能识别');
  // 子代理场景的码也要认
  assert.equal(detectModelReject({ result: { ok: false, error: { code: 'subagent/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } } } }), true);
  // 同码但别的原因（例如图片超限）不得误判
  assert.equal(detectModelReject({ result: { ok: false, error: { code: 'session/attachment-invalid', details: { reason: 'IMAGE_DIMENSION_TOO_LARGE' } } } }), false);
});

test('normalizeRpcMethod：斜杠端点（0.1.2）与点分端点（≤0.1.1）统一为点分', () => {
  assert.equal(normalizeRpcMethod('session/prompt'), 'session.prompt');
  assert.equal(normalizeRpcMethod('session.prompt'), 'session.prompt');
  assert.equal(normalizeRpcMethod('session/create'), 'session.create');
  assert.equal(normalizeRpcMethod(undefined), '');
  assert.equal(normalizeRpcMethod(123), '');
});

test('unwrapRpcRequest：0.1.2 的 payload.args.<参数名> 解包为业务请求对象（兼容旧版）', () => {
  // 0.1.2：{type,rpcId,method,payload:{args:{request:{…}}}}（prompt 的参数名是 request）
  const modern = {
    type: 'client-request', rpcId: 'r1', method: 'session/prompt',
    payload: { args: { request: { requestId: 'p1', sessionId: 's1', mode: 'queue', content: [{ type: 'image', data: 'AA', name: 'a.png' }] } } },
  };
  const req = unwrapRpcRequest(modern) as { sessionId?: string; mode?: string; content?: unknown[] };
  assert.equal(req.sessionId, 's1');
  assert.equal(req.mode, 'queue');
  assert.equal(Array.isArray(req.content), true);
  // session/list 的参数名是 _request（同样解包）
  assert.deepEqual(unwrapRpcRequest({ payload: { args: { _request: { beforeSeq: 1 } } } }), { beforeSeq: 1 });
  // 旧版：payload 直挂业务字段
  const legacy = { rpcId: 'r2', method: 'session.prompt', payload: { sessionId: 's2', content: [{ type: 'text', text: 'hi' }] } };
  assert.equal((unwrapRpcRequest(legacy) as { sessionId?: string }).sessionId, 's2');
  // 无 payload 的裸形态
  assert.deepEqual(unwrapRpcRequest({ sessionId: 's3' }), { sessionId: 's3' });
  assert.equal(unwrapRpcRequest(null), null);
});

test('buildTextResendRequest：0.1.2 斜杠端点 + args 包装下仍能替换 content 并保留其它字段', () => {
  const content = buildTextOnlyContent(
    [{ type: 'image', data: 'AA', name: 'a.png' }, { type: 'text', text: '看看这张' }],
    [buildImagePointerLine('/w/x.png', 1)],
  );
  const body = {
    type: 'client-request', rpcId: 'old-1', method: 'session/prompt',
    payload: { args: { request: { requestId: 'p1', sessionId: 's1', mode: 'queue', content: [{ type: 'image', data: 'AA' }], clientTimeZone: 'Asia/Shanghai' } } },
  };
  const req = buildTextResendRequest(body, content) as {
    type?: string; rpcId?: string; method?: string;
    payload: { args: { request: Record<string, unknown> } };
  };
  assert.equal(req.type, 'client-request');
  assert.equal(req.method, 'session/prompt', '必须保留斜杠端点（0.1.2）');
  assert.notEqual(req.rpcId, 'old-1', '必须换新 rpcId');
  const request = req.payload.args.request;
  assert.equal(request.sessionId, 's1', '业务字段应保留');
  assert.equal(request.requestId, 'p1');
  assert.equal(request.mode, 'queue');
  assert.equal(request.clientTimeZone, 'Asia/Shanghai');
  assert.equal(Array.isArray(request.content), true);
  assert.equal((request.content as unknown[]).length, 1);
  assert.equal((request.content as { type: string }[])[0].type, 'text');
  // 原请求体不得被就地修改（避免影响 DSH 自身持有的引用）
  assert.equal((body.payload.args.request.content as { type: string }[])[0].type, 'image');
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
  // 序号：zhOrdinal 1..10 中文、超出阿拉伯数字兜底；带序号时输出 图片一/图片二…
  assert.equal(zhOrdinal(1), '一');
  assert.equal(zhOrdinal(2), '二');
  assert.equal(zhOrdinal(10), '十');
  assert.equal(zhOrdinal(11), '11');
  assert.equal(buildImagePointerLine('/w/1.png', 1), '图片一：/w/1.png');
  assert.equal(buildImagePointerLine('/w/2.png', 2), '图片二：/w/2.png');
  // 无指针时保持原文本
  assert.equal(buildTextOnlyContent([{ type: 'text', text: 'a' }], []).length, 1);
});

test('imageBlocksOf / matchCapturedImages：按本条消息顺序只取实际包含的图片', () => {
  const content = [
    { type: 'text', text: '描述' },
    { type: 'image', name: 'A.png', data: 'dataA' },
    { type: 'image', name: 'B.png', data: 'dataB' },
  ];
  assert.equal(imageBlocksOf(content).length, 2);
  assert.equal(imageBlocksOf([{ type: 'text' }]).length, 0);
  // 5 个历史缓存，但本条消息只含 A/B —— 只应匹配到 A/B（按消息顺序）
  const entries = [
    { key: 'kA', name: 'A.png', b64: 'dataA' },
    { key: 'kX', name: 'X.png', b64: 'dataX' },
    { key: 'kB', name: 'B.png', b64: 'dataB' },
    { key: 'kY', name: 'Y.png', b64: 'dataY' },
    { key: 'kZ', name: 'Z.png', b64: 'dataZ' },
  ];
  const used = matchCapturedImages(content, entries);
  assert.deepEqual(used.map((e) => e.key), ['kA', 'kB'], '只应取本条消息实际包含的图片，且保持消息顺序');
  // 消息图片块无 name 时退回按 base64 数据匹配
  const used2 = matchCapturedImages([{ type: 'image', data: 'dataZ' }], entries);
  assert.deepEqual(used2.map((e) => e.key), ['kZ']);
  // 无任何匹配时兜底按序取第一个未占用
  const used3 = matchCapturedImages([{ type: 'image', data: 'none' }], [{ key: 'k1', name: '1.png', b64: 'x' }]);
  assert.deepEqual(used3.map((e) => e.key), ['k1']);
});

test('matchCapturedImages：字节精确匹配优先于同名（防止同名旧缓存顶替新图）', () => {
  // 场景（code review Critical）：同会话先传过 a.png（旧内容），缓存未清；再传同名 a.png（新内容）
  const content = [{ type: 'image', name: 'a.png', data: 'NEWBYTES' }];
  const entries = [
    { key: 'k-old', name: 'a.png', b64: 'OLDBYTES', mime: 'image/png' },
    { key: 'k-new', name: 'a.png', b64: 'NEWBYTES', mime: 'image/png' },
  ];
  const used = matchCapturedImages(content, entries);
  assert.equal(used.length, 1);
  assert.equal(used[0].key, 'k-new', '必须按 base64 精确匹配，绝不能命中同名旧条目');

  // 旧版（≤0.1.1）图片块只带 name 时，退回按文件名匹配
  const legacy = matchCapturedImages([{ type: 'image', name: 'b.png' }], [{ key: 'k-b', name: 'b.png', b64: 'X' }]);
  assert.equal(legacy[0].key, 'k-b');

  // 既无 data 也无 name 命中 → 按序兜底取第一个未占用
  const fallback = matchCapturedImages([{ type: 'image' }], [{ key: 'k-1', name: 'x', b64: 'A' }]);
  assert.equal(fallback[0].key, 'k-1');
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

test('buildTextResendRequest：保留线格式 type/method、换新 rpcId、content 替换为纯文本', () => {
  const content = buildTextOnlyContent([{ type: 'image' }, { type: 'text', text: 'hi' }], [buildImagePointerLine('/w/x.png')]);
  const body = { type: 'client-request', rpcId: 'old-1', method: 'session.prompt', payload: { sessionId: 's1', mode: 'queue', content: [{ type: 'image', data: 'x' }] } };
  const req = buildTextResendRequest(body, content);
  assert.equal(req.type, 'client-request', '必须保留 type=client-request，否则服务器 bad-request 拒绝');
  assert.equal(req.method, 'session.prompt', '必须保留 method=session.prompt');
  assert.notEqual(req.rpcId, 'old-1');
  assert.equal(req.payload.sessionId, 's1');
  assert.equal(req.payload.mode, 'queue');
  assert.ok(Array.isArray(req.payload.content));
  assert.equal((req.payload.content as unknown[]).length, 1);
  assert.equal(((req.payload.content as unknown[])[0] as { type: string }).type, 'text');
  // 无 type/method 的简写形态（老测试形态）也应能安全生成
  const bare = buildTextResendRequest({ rpcId: 'x', payload: { content } }, content);
  assert.equal(typeof bare.rpcId, 'string');
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



