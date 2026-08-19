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

