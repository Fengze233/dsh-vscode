// bridge-client/lib/core.js — 桥接纯逻辑（无 DOM、无 window，可在 node 环境单测）
// 说明：本文件是唯一实现与单测目标；生产环境在构建时（scripts/build.mjs）把它
// 内联进 client.js 工厂，保证"生产运行的逻辑 = 单测验证的逻辑"同一份源码。

// 外链协议白名单：只允许 http/https，杜绝 javascript:/file: 等危险协议
export function isAllowedExternalUrl(url) {
  // 非字符串或空串一律拒绝
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    // 用 URL 解析取协议；无效 URL 会抛错，落入 catch 返回 false
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// 构造"打开外链"消息（父页面 → 扩展 → 系统浏览器）
export function buildOpenExternalMessage(url) {
  return { kind: 'openExternal', url };
}

// 构造"打开文件"消息（cwd 为会话工作目录，可选；无 cwd 时省略该字段）
export function buildOpenFileMessage(path, cwd) {
  return cwd === undefined ? { kind: 'openFile', path } : { kind: 'openFile', path, cwd };
}

// 构造"工作区同步回执"消息（bridgeAck，path 可选）
export function buildSyncWorkspaceAck(ok, path) {
  return path === undefined ? { kind: 'bridgeAck', ok } : { kind: 'bridgeAck', ok, path };
}

// 构造"复制文本"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板）
export function buildCopyTextMessage(text, requestId) {
  return { kind: 'copyText', text, requestId };
}

// 构造"复制文本回执"消息（父页面 → iframe 页面，用于 resolve/reject writeText 的 Promise）
export function buildCopyTextAck(requestId, ok) {
  return { kind: 'copyTextAck', requestId, ok };
}

// 校验来自父页面的消息 token（握手防伪）：必须是对象且携带匹配的非空 token
export function isBridgeMessage(data, token) {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof data.token === 'string' &&
    data.token === token &&
    data.token !== ''
  );
}

// 握手 token 字段名（父页面发来的消息里携带）
export const HANDSHAKE_TOKEN_KEY = 'token';

/**
 * 从键盘事件判定"标准编辑快捷键"命令。
 *
 * 背景：VS Code 在 macOS 上会调用 setIgnoreMenuShortcuts(true) 并只在顶层 webview
 * 转发快捷键，导致嵌套 iframe（本桥接所在的 DSH 页面）里的 Cmd+C / Cmd+V / Cmd+A 等
 * 被吞掉（microsoft/vscode#129178 / #180234，官方至今未修复）。但 iframe 内的 JS 仍能
 * 收到 keydown 事件，因此这里把"按键 → 编辑命令"的判定抽成纯函数，
 * 由 client.js 捕获后自行模拟对应行为。
 *
 * @param {{ key?: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean }} e
 *   键盘事件的关键字段（兼容真实 KeyboardEvent 与测试桩，多余字段忽略）
 * @returns {null | 'copy' | 'paste' | 'cut' | 'selectAll' | 'undo' | 'redo'}
 *   命中的编辑命令；未命中返回 null（调用方应放行原事件）
 */
export function getShortcutCommand(e) {
  if (!e || typeof e !== 'object') return null;
  // 主修饰键：mac 用 meta（⌘），Windows/Linux 用 ctrl，两者都识别以兼容两种平台
  const hasMod = e.ctrlKey === true || e.metaKey === true;
  // Windows 上 Shift+Insert 是经典的粘贴组合，一并支持
  if (!hasMod) {
    return e.shiftKey === true && e.key === 'Insert' ? 'paste' : null;
  }
  // 键名统一小写以兼容 'c' 与 'C'（Shift+字母时 key 为大写）
  const k = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  switch (k) {
    case 'c':
      return 'copy';
    case 'v':
      return 'paste';
    case 'x':
      return 'cut';
    case 'a':
      return 'selectAll';
    case 'z':
      // Cmd+Shift+Z 是重做（mac 惯例；Windows 上 Ctrl+Y 也能重做，暂不额外处理）
      return e.shiftKey === true ? 'redo' : 'undo';
    default:
      return null;
  }
}

/**
 * 判定一个元素是否为"可编辑元素"（可接收粘贴/剪切/打字的目标）。
 *
 * @param {object|null} el DOM 元素
 * @returns {boolean} true 表示 textarea / 可输入 input / contenteditable
 */
export function isEditableElement(el) {
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    // 真实 DOM 的 input.type 属性默认为 'text'，但为兼容测试桩与旧浏览器，
    // 空字符串 type 一律按 text 处理
    const type = typeof el.type === 'string' && el.type !== '' ? el.type.toLowerCase() : 'text';
    // 仅把能接收键盘文本输入的 type 视为可编辑（checkbox/button/range 等排除）
    return ['text', 'search', 'url', 'tel', 'password', 'number', 'email'].includes(type);
  }
  return el.isContentEditable === true;
}

/**
 * 计算在字符串的 [start, end) 区间插入 text 后的新值（纯函数，供可编辑元素兜底写入）。
 *
 * @param {string|undefined|null} value 原值（textarea.value 等）
 * @param {number} start 选区起点（selectionStart）
 * @param {number} end 选区终点（selectionEnd）
 * @param {string} text 待插入文本
 * @returns {string} 插入后的完整新值
 */
export function computeInsertedValue(value, start, end, text) {
  const v = typeof value === 'string' ? value : String(value ?? '');
  // 越界/负值/顺序异常都归一到合法区间，避免 slice 结果错乱
  const s = Math.max(0, Math.min(Number.isFinite(start) ? start : v.length, v.length));
  const e = Math.max(s, Math.min(Number.isFinite(end) ? end : v.length, v.length));
  return v.slice(0, s) + text + v.slice(e);
}

// 构造"读取剪贴板"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板读取，供粘贴兜底）
export function buildReadTextMessage(requestId) {
  return { kind: 'readText', requestId };
}

// 构造"读取剪贴板回执"消息（父页面 → iframe 页面，resolve/reject readText 的 Promise）
// ok=true 且 text 非空才视为成功；空文本/失败一律回执 ok=false（无可粘贴内容）
export function buildReadTextAck(requestId, ok, text) {
  return ok === true && typeof text === 'string' && text !== ''
    ? { kind: 'readTextAck', requestId, ok: true, text }
    : { kind: 'readTextAck', requestId, ok: false };
}
// —— v0.3.0 图片缓存降级：saveImage / deleteImages 消息与缓存文件名 ——
// 图片缓存文件的扩展名白名单（仅这些结尾才允许由扩展宿主落盘/删除，防任意文件写入/删除）
export const IMAGE_CACHE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/**
 * 生成图片缓存文件名（不含目录，目录由扩展侧拼接）：dsh-imgcache-<ts>-<i><ext>。
 * 扩展名不在白名单（或缺少点号）时返回 null（调用方不得落盘）。
 */
export function imageCacheFilename(timestamp, index, ext) {
  if (typeof ext !== 'string' || !IMAGE_CACHE_EXTENSIONS.includes(ext.toLowerCase())) return null;
  const t = typeof timestamp === 'string' && timestamp !== '' ? timestamp : String(Date.now());
  const i = Number.isFinite(index) ? index : 0;
  return 'dsh-imgcache-' + t + '-' + i + ext.toLowerCase();
}

// 构造「保存图片」上行消息（iframe 页面 → 父页面 → 扩展宿主落盘）
export function buildSaveImageRequest(requestId, name, dataB64, sessionCwd) {
  return { kind: 'saveImage', requestId, name, dataB64, sessionCwd };
}

/**
 * 解析「保存图片」回执：仅接受与期望 requestId 一致的 saveImageAck。
 * 返回 { ok, path? }；形状不合法或 requestId 不匹配返回 null。
 */
export function parseSaveImageAck(data, expectedRequestId) {
  if (
    data && typeof data === 'object' && data.kind === 'saveImageAck' &&
    data.requestId === expectedRequestId && typeof data.ok === 'boolean'
  ) {
    return typeof data.path === 'string' ? { ok: data.ok, path: data.path } : { ok: data.ok };
  }
  return null;
}

// 构造「删除图片缓存」上行消息（iframe 页面 → 父页面 → 扩展宿主删除）
export function buildDeleteImagesRequest(requestId, paths) {
  return { kind: 'deleteImages', requestId, paths: Array.isArray(paths) ? paths : [] };
}

/**
 * 解析「删除图片缓存」回执：仅接受与期望 requestId 一致的 deleteImagesAck。
 */
export function parseDeleteImagesAck(data, expectedRequestId) {
  if (
    data && typeof data === 'object' && data.kind === 'deleteImagesAck' &&
    data.requestId === expectedRequestId && typeof data.ok === 'boolean'
  ) {
    return { ok: data.ok };
  }
  return null;
}

// —— v0.3.0 图片自由上传降级：模型拒绝判定 / 内容重构 / 指纹 / 指针行 ——
/**
 * 判定一次 prompt RPC 响应是否为「模型不支持图像输入」而被拒。
 * 兼容三种形状：wire 包 ({ result:{ ok:false, error } })、flat ({ ok:false, error })、
 * 裸错误 ({ code, details })，便于单测与线上解析复用。
 */
export function detectModelReject(data) {
  if (!data || typeof data !== 'object') return false;
  const result = data.result && typeof data.result === 'object' ? data.result : data;
  const error = result.error && typeof result.error === 'object'
    ? result.error
    : data.error && typeof data.error === 'object'
      ? data.error
      : data;
  if (error.code !== 'attachment-error') return false;
  return !!(error.details && typeof error.details === 'object' && error.details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES');
}

/** 内容块数组是否含图片块（v0.3.0 判定是否需要走降级） */
export function isPromptWithImages(content) {
  return Array.isArray(content) && content.some((b) => b && typeof b === 'object' && b.type === 'image');
}

/** 提取内容块中的全部文本（按顺序拼接，空行分隔） */
export function extractPromptText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** 构造图片指针行（模型应能据此调用图像识别工具查看文件） */
export function buildImagePointerLine(path) {
  return '[图片已保存到: ' + path + ']（模型可用图像识别工具查看该文件）';
}

/**
 * 构造纯文本内容块数组：原文本 + 图片指针行。
 * 无图片指针时保持原文本不变（形状不变），有指针时拼接到文本之后。
 */
export function buildTextOnlyContent(content, pointerLines) {
  const text = extractPromptText(content);
  const pointers = (Array.isArray(pointerLines) ? pointerLines : []).filter((l) => typeof l === 'string' && l !== '');
  const joined = pointers.length === 0 ? text : text === '' ? pointers.join('\n') : text + '\n\n' + pointers.join('\n');
  return [{ type: 'text', text: joined }];
}

/** 构造「图片降级已发生」的通知消息（iframe → 扩展宿主 → 用户可见提示） */
export function buildImageFallbackNotice(paths) {
  return { kind: 'imageFallback', paths: Array.isArray(paths) ? paths : [] };
}

/**
 * 文件指纹（去重键）：name:size:lastModified；关键字段缺失返回 null。
 * 用于附件捕获时对同一文件去重，避免重复落盘。
 */
export function imageCacheKey(fileLike) {
  if (!fileLike || typeof fileLike !== 'object') return null;
  const name = typeof fileLike.name === 'string' ? fileLike.name : '';
  const size = typeof fileLike.size === 'number' ? fileLike.size : 0;
  const lm = typeof fileLike.lastModified === 'number' ? fileLike.lastModified : 0;
  return name === '' ? null : name + ':' + size + ':' + lm;
}

/**
 * 解包 RPC 请求体 → 业务 payload。
 * DSH 的 fetch 请求体是 { rpcId, payload }（RpcRequest），content 等业务字段在 payload 下；
 * 兼容「直传 payload」的测试形态。v0.3.0 图片降级的拦截/重发都要经它对齐线格式。
 */
export function unwrapRpcPayload(body) {
  if (body && typeof body === 'object' && body.payload && typeof body.payload === 'object') return body.payload;
  return body;
}

/**
 * 以纯文本内容重构 RPC 请求：保留原 body 的 rpcId? 不——换新 rpcId（与已拒请求不撞车），
 * payload 保留原 sessionId/mode/clientTimeZone 等并把 content 替换为纯文本内容。
 */
export function buildTextResendRequest(originalBody, content) {
  const payload = unwrapRpcPayload(originalBody);
  return {
    rpcId: 'vsc-fb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    payload: { ...payload, content },
  };
}

