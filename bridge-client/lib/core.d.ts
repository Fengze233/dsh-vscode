// bridge-client/lib/core.d.ts — core.js 的类型声明（供 TS 侧 import 获得类型）
// 与 core.js 的运行时导出保持一致；纯逻辑无 DOM，可在 node 环境 import。

/** 外链协议白名单：仅 http/https 且非空返回 true */
export function isAllowedExternalUrl(url: string): boolean;

/** 构造"打开外链"消息 */
export function buildOpenExternalMessage(url: string): { kind: 'openExternal'; url: string };

/** 构造"打开文件"消息（cwd 为会话工作目录，可选） */
export function buildOpenFileMessage(path: string, cwd: string | undefined): { kind: 'openFile'; path: string; cwd?: string };

/** 构造"工作区同步回执"消息（bridgeAck，path 可选） */
export function buildSyncWorkspaceAck(ok: boolean, path?: string): { kind: 'bridgeAck'; ok: boolean; path?: string };

/** 校验来自父页面的消息 token（握手防伪） */
export function isBridgeMessage(data: unknown, token: string): boolean;

/** 握手 token 字段名（父页面发来的消息里携带） */
export const HANDSHAKE_TOKEN_KEY: string;
