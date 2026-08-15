// src/bridge/host.ts — 桥接消息处理：外链打开 / 文件跳转（工作区同步编排见 Task 5）
// 职责：把 webview 顶层转发来的桥接消息（bridgeOpenExternal / bridgeOpenFile）落地为
// VS Code 动作（打开外部浏览器 / 打开文本文档），并做协议白名单与路径解析的纵深防御。
// 依赖注入设计：生产侧接 vscode API（openExternal / showTextDocument），测试侧注入假实现，
// 保证纯逻辑可被 node:test 直接验证。
import { isAbsolute, resolve } from 'node:path';
import type { PanelMessage } from '../panel/html';

/** 桥接消息处理依赖（生产接 vscode API，测试注入假实现） */
export interface BridgeMessageDeps {
  /** 打开外部链接（生产接 vscode.env.openExternal，返回是否成功） */
  openExternal(url: string): Thenable<boolean>;
  /** 打开文本文档（生产接 vscode.window.showTextDocument） */
  openTextDocument(path: string): Thenable<void>;
  /** 弹用户可见提示（生产接 vscode.window.showWarningMessage，测试注入假实现以断言） */
  showWarning(msg: string): void;
  /** 工作区根目录（相对路径解析的兜底基准，生产由 Task 5 注入） */
  workspaceRoot?: string;
}

/**
 * 提取错误摘要：优先取 Error.message，其余类型做保守的字符串化，兜底空串。
 * 用于把打开失败原因并入用户提示，避免把内部错误对象原样展示。
 */
function errSummary(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === null || err === undefined) return '';
  return String(err);
}

/**
 * 解析文件路径：绝对路径直接采用；相对路径依次按 会话 cwd → 工作区根 作为基准解析。
 * 安全规则：形似 URL 的协议串（如 https://、javascript:）一律拒绝，
 * 但 Windows 盘符（C:\ 或 C:/）不是协议，需要放行。
 */
export function resolveBridgePath(raw: string, sessionCwd: string | undefined, workspaceRoot: string | undefined):
  { kind: 'abs'; path: string } | { kind: 'invalid' } {
  // 路径形似 URL 一律拒绝（协议串）；Windows 盘符不属于协议，予以放行
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    return { kind: 'invalid' };
  }
  // 绝对路径直接采用（跨平台：Windows 盘符与 POSIX / 开头都算绝对）
  if (isAbsolute(raw)) return { kind: 'abs', path: raw };
  // 相对路径：优先用会话 cwd，缺失时退回工作区根；两者都无则无法解析
  const base = sessionCwd ?? workspaceRoot;
  if (base === undefined) return { kind: 'invalid' };
  return { kind: 'abs', path: resolve(base, raw) };
}

/**
 * 处理桥接消息：外链打开走协议白名单，文件跳转走路径解析。
 * 工作区同步（syncWorkspace）等其余消息类型由 Task 5 在此扩展，本任务只处理跳转两类。
 */
export async function handleBridgeMessage(msg: PanelMessage, deps: BridgeMessageDeps): Promise<void> {
  if (msg.type === 'bridgeOpenExternal') {
    // 协议白名单：仅 http/https（与桥接侧白名单双重校验，纵深防御）
    if (/^https?:\/\//i.test(msg.url)) {
      try {
        await deps.openExternal(msg.url);
      } catch (err) {
        // 打开外链可能失败（如无默认浏览器），捕获后给用户可见反馈而非未处理拒绝
        deps.showWarning(`无法打开链接：${msg.url}（${errSummary(err)}）`);
      }
    }
    return;
  }
  if (msg.type === 'bridgeOpenFile') {
    const r = resolveBridgePath(msg.path, msg.cwd, deps.workspaceRoot);
    if (r.kind === 'abs') {
      try {
        // 打开文档可能因文件不存在/无权限等失败，捕获后给用户可见反馈而非未处理拒绝
        await deps.openTextDocument(r.path);
      } catch (err) {
        // 文案内联固定提示（本模块纯逻辑，直接断言，与 Task 7 的 i18n 无关）
        deps.showWarning(`无法打开文件：${r.path}（${errSummary(err)}）`);
      }
    } else {
      // 路径无法解析（危险协议或缺少基准目录）：仅弹提示，不打断面板与桥接流程
      deps.showWarning(`无法解析路径：${msg.path}`);
    }
    return;
  }
}
