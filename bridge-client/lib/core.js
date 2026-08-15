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

// 工作区同步消息类型（父页面 → iframe）
export const WORKSPACE_MESSAGE_KIND = 'syncWorkspace';
// 握手 token 字段名（父页面发来的消息里携带）
export const HANDSHAKE_TOKEN_KEY = 'token';
