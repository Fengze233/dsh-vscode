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

/** 构造"复制文本"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板） */
export function buildCopyTextMessage(text: string, requestId: string): { kind: 'copyText'; text: string; requestId: string };

/** 构造"复制文本回执"消息（父页面 → iframe 页面） */
export function buildCopyTextAck(requestId: string, ok: boolean): { kind: 'copyTextAck'; requestId: string; ok: boolean };

/** 校验来自父页面的消息 token（握手防伪） */
export function isBridgeMessage(data: unknown, token: string): boolean;

/** 握手 token 字段名（父页面发来的消息里携带） */
export const HANDSHAKE_TOKEN_KEY: string;

/** 键盘事件关键字段（getShortcutCommand 的输入，兼容真实 KeyboardEvent 与测试桩） */
interface ShortcutEventLike {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/** 编辑命令枚举（getShortcutCommand 的返回） */
type EditCommand = 'copy' | 'paste' | 'cut' | 'selectAll' | 'undo' | 'redo';

/**
 * 从键盘事件判定"标准编辑快捷键"命令（VS Code 吞掉 iframe 内 Cmd+C/V/A 的修复）。
 * 命中返回对应编辑命令；未命中返回 null（调用方应放行原事件）。
 */
export function getShortcutCommand(e: ShortcutEventLike | null | undefined): EditCommand | null;

/** 判定元素是否为可编辑元素（textarea / 可输入 input / contenteditable） */
export function isEditableElement(el: unknown): boolean;

/** 计算在 [start, end) 选区插入 text 后的新值（越界/负值归一） */
export function computeInsertedValue(
  value: string | null | undefined,
  start: number,
  end: number,
  text: string,
): string;

/** 构造"读取剪贴板"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板读取，粘贴兜底用） */
export function buildReadTextMessage(requestId: string): { kind: 'readText'; requestId: string };

/** 构造"读取剪贴板回执"消息（父页面 → iframe 页面）；成功带 text，失败省略 text */
export function buildReadTextAck(
  requestId: string,
  ok: boolean,
  text?: string,
): { kind: 'readTextAck'; requestId: string; ok: boolean; text?: string };
