// test/bridge/interceptor.test.ts — 图片降级拦截器集成测试（在真实构建产物上运行）
// 目的：直接把「内联后的 client.js」工厂放进一个最小浏览器沙箱（node:vm）执行，
// 模拟握手 + 附件捕获 + 被拒响应，验证 v0.3.0 图片降级的新行为（用户验收口径）：
//   ① 非视觉模型被拒 → 保存图片、改为「原文+图片地址」重发、用重发成功响应顶替被拒响应
//      （DSH 不再显示"不支持图像输入"报错），且不向上发任何 imageFallback 通知；
//   ② 视觉模型（成功响应）→ 原样透传，完全不动；
//   ③ 被拒但无落盘（未打开工作区）→ 回退原生被拒响应，绝不吞错误。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBridgeClient } from '../../scripts/bridge-build.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const REJECT_BODY = {
  rpcId: 'orig-1',
  result: {
    ok: false,
    error: {
      code: 'attachment-error',
      message: 'Model "x" does not support image input.',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    },
  },
};
const ACCEPT_BODY = { rpcId: 'orig-1', result: { ok: true, value: { accepted: true } } };

/** 构造并加载桥接工厂，返回可调用的沙箱句柄 */
function loadBridge(opts: { fetch: (input: unknown, init: any) => Promise<Response> }) {
  const outDir = join(tmpdir(), 'dsh-bridge-it-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const built = buildBridgeClient({
    coreSource: join(process.cwd(), 'bridge-client', 'lib', 'core.js'),
    clientTemplate: join(process.cwd(), 'bridge-client', 'lib', 'client.js'),
    outDir,
  });
  const code = readFileSync(built, 'utf8');

  // —— 最小浏览器沙箱 ——
  const windowListeners: Map<string, Set<(...a: any[]) => void>> = new Map();
  const docListeners: Map<string, Set<(...a: any[]) => void>> = new Map();
  const parentMessages: any[] = [];
  let loadedPlugin: any = null;

  const emitWin = (type: string, data: unknown) => {
    for (const fn of windowListeners.get(type) ?? []) fn({ data });
  };
  const emitDoc = (type: string, ev: unknown) => {
    for (const fn of docListeners.get(type) ?? []) fn(ev);
  };

  // 父页面（扩展宿主）桩：落盘 saveImage 即回执 saveImageAck（模拟扩展写盘后回路径）。
  const parent = {
    postMessage(msg: any, _o?: string) {
      parentMessages.push(msg);
      if (msg?.kind === 'saveImage') {
        emitWin('message', { kind: 'saveImageAck', requestId: msg.requestId, ok: true, path: '/ws/' + msg.name });
      } else if (msg?.kind === 'deleteImages') {
        emitWin('message', { kind: 'deleteImagesAck', requestId: msg.requestId, ok: true });
      }
    },
  };

  const fakeWindow: Record<string, any> = {
    __ModuleLoader__: { load(cfg: any) { loadedPlugin = cfg; } },
    fetch: opts.fetch,
    __dshVscodeBridgeReady: false,
    addEventListener(type: string, fn: (...a: any[]) => void) {
      (windowListeners.get(type) ?? (windowListeners.set(type, new Set()).get(type)!)).add(fn);
    },
    removeEventListener(type: string, fn: (...a: any[]) => void) {
      windowListeners.get(type)?.delete(fn);
    },
    getSelection() { return null; },
    innerWidth: 1280,
    innerHeight: 800,
  };
  const fakeDocument: Record<string, any> = {
    addEventListener(type: string, fn: (...a: any[]) => void) {
      (docListeners.get(type) ?? (docListeners.set(type, new Set()).get(type)!)).add(fn);
    },
    activeElement: null,
    execCommand() { return true; },
    createElement() { return { textContent: '', style: {}, append() {}, setAttribute() {}, addEventListener() {} }; },
    head: { append() {} },
    body: { append() {} },
  };

  const sandbox: Record<string, any> = {
    window: fakeWindow,
    document: fakeDocument,
    navigator: { clipboard: {} },
    parent,
    btoa: (globalThis as any).btoa?.bind(globalThis),
    atob: (globalThis as any).atob?.bind(globalThis),
    Response: globalThis.Response,
    fetch: globalThis.fetch,
    setTimeout,
    clearTimeout,
    console,
  };
  const ctx = createContext(sandbox);
  runInContext(code, ctx);

  assert.ok(loadedPlugin, '工厂应被 load 捕获');
  assert.equal(loadedPlugin.id, 'dsh-vscode-bridge');
  assert.ok(typeof loadedPlugin.factory === 'function');

  return {
    outDir,
    window: fakeWindow,
    windowListeners,
    docListeners,
    parentMessages,
    emitWin,
    emitDoc,
    /** 执行 factory 并返回 module.exports（应用实例） */
    apply() {
      const req = (id: string) => { throw new Error('unexpected require: ' + id); };
      return loadedPlugin.factory(req);
    },
  };
}

test('被拒（非视觉模型）→ 保存图片、图片改为地址重发、返回成功响应且无通知', async () => {
  const calls: { input: unknown; init: any }[] = [];
  let servedOriginal = false;
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    if (!servedOriginal) {
      servedOriginal = true;
      return jsonResponse(REJECT_BODY); // 第 1 次：原始含图请求 → 被拒
    }
    return jsonResponse(ACCEPT_BODY);   // 第 2 次：降级重发 → 成功
  };

  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply(); // 执行工厂：完成所有监听绑定与 fetch 接管

    // 握手：携带 imageFallback=true 激活降级
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    assert.equal(b.parentMessages.length, 1, '握手应回执 bridgeAck');
    assert.equal(b.parentMessages[0].kind, 'bridgeAck');

    // 捕获一张图片（模拟对话框选择文件）
    const file = {
      name: 'photo.png',
      size: 3,
      lastModified: 42,
      type: 'image/png',
      arrayBuffer: async () => new Uint8Array([1, 2, 3]),
    };
    b.emitDoc('change', { target: { files: [file] } });
    await new Promise((r) => setTimeout(r, 10)); // 等 btoa 微任务完成

    // 模拟 DSH 发送含图 prompt（父页面桩会自动回执 saveImageAck）
    const promptBody = JSON.stringify({
      rpcId: 'orig-1',
      payload: {
        sessionId: 's1',
        mode: 'queue',
        content: [{ type: 'text', text: '这是什么？' }, { type: 'image', image: 'x' }],
      },
    });
    const out = await b.window.fetch('http://127.0.0.1:3080/api/prompt', { method: 'POST', body: promptBody, headers: { 'content-type': 'application/json' } });

    // ① 返回给 DSH 的是「成功」响应（顶替被拒），且 rpcId 回写为原请求
    const json = await out.json();
    assert.equal(json.rpcId, 'orig-1', '交回响应的 rpcId 应为原请求');
    assert.equal(json.result.ok, true, '交回响应应为成功（不再报"不支持图像输入"）');
    assert.equal(json.result.value.accepted, true);
    assert.equal(out.status, 200);

    // ② DSH 侧应发起两次真实 fetch：原始（含图）+ 降级重发（纯文本图片地址）
    assert.equal(calls.length, 2, '应恰好一次原始 + 一次重发');
    const originalBody = JSON.parse(calls[0].init.body);
    const resendBody = JSON.parse(calls[1].init.body);
    // 原始请求不被篡改（仍是原 rpcId + 图片块）
    assert.equal(originalBody.rpcId, 'orig-1');
    assert.ok(originalBody.payload.content.some((x: any) => x.type === 'image'));
    // 重发：新 rpcId、保留 sessionId/mode、内容为「原文 + 图片：路径」且不再含图片块
    assert.match(resendBody.rpcId, /^vsc-fb-/);
    assert.equal(resendBody.payload.sessionId, 's1');
    assert.equal(resendBody.payload.mode, 'queue');
    assert.ok(Array.isArray(resendBody.payload.content) && resendBody.payload.content.length === 1);
    assert.equal(resendBody.payload.content[0].type, 'text');
    assert.ok(resendBody.payload.content[0].text.includes('这是什么？'), '应保留用户原文');
    assert.match(resendBody.payload.content[0].text, /图片：\S+dsh-imgcache-\S+\.png/, '应以「图片：<绝对路径>」形式随消息发出');

    // ③ 请求过 saveImage 落盘（带图像数据，父桩回执了路径）
    const saveReqs = b.parentMessages.filter((m) => m.kind === 'saveImage');
    assert.equal(saveReqs.length, 1);
    assert.ok(typeof saveReqs[0].dataB64 === 'string' && saveReqs[0].dataB64.length > 0);
    assert.match(saveReqs[0].name, /^dsh-imgcache-/);

    // ④ 绝不向上发 imageFallback 通知（全程无感）
    assert.ok(!b.parentMessages.some((m) => m.kind === 'imageFallback'), '不应发送 imageFallback 通知');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('视觉模型（成功响应）→ 原样透传，不重发、不落盘、不通知', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    return jsonResponse(ACCEPT_BODY); // 模型支持图像 → 成功
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const promptBody = JSON.stringify({
      rpcId: 'orig-9',
      payload: { sessionId: 's2', content: [{ type: 'image' }, { type: 'text', text: '看图' }] },
    });
    const out = await b.window.fetch('/api/prompt', { method: 'POST', body: promptBody });
    const json = await out.json();
    assert.equal(json.result.ok, true);
    assert.equal(calls.length, 1, '成功路径不应触发重发');
    assert.ok(!b.parentMessages.some((m) => m.kind === 'saveImage'), '成功路径不应落盘');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('被拒但无图片缓存（未打开工作区）→ 回退原生被拒响应，不吞错误', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(REJECT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    // 未捕获任何图片（imageCache 为空）直接发含图请求
    const promptBody = JSON.stringify({
      rpcId: 'orig-3',
      payload: { sessionId: 's3', content: [{ type: 'image' }] },
    });
    const out = await b.window.fetch('/api/prompt', { method: 'POST', body: promptBody });
    const json = await out.json();
    // 保持原生：返回的是被拒响应（用户在 DSH 里能看到原始报错，不静默吞掉）
    assert.equal(json.result.ok, false);
    assert.equal(json.result.error.code, 'attachment-error');
    assert.ok(!b.parentMessages.some((m) => m.kind === 'saveImage'), '无缓存不应落盘');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});
