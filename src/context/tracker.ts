// src/context/tracker.ts — 当前文件跟踪与路径引用(纯模块,不依赖 vscode)
// 职责:①把绝对路径转成注入引用(工作区内 → 相对路径,区外 → 绝对路径);
//       ②带防抖的当前文件跟踪(编辑器快速切换时只结算最终停留的文件)。
import { isAbsolute, relative, sep } from 'node:path';

export interface FileRef {
  absPath: string;
  ref: string;
  relToWorkspace: boolean;
}

/** 判断 p 是否严格位于 root 目录内部(root 本身不算 inside) */
function isInside(p: string, root: string): boolean {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 把绝对路径转成注入引用:
 * - workspaceRoot 存在且 absPath 在其内部 → 相对路径(统一正斜杠,跨平台稳定)
 * - 其余情况(无工作区/区外文件/等于根)→ 绝对路径
 */
export function describeFileRef(absPath: string, workspaceRoot?: string): FileRef {
  if (workspaceRoot !== undefined && isAbsolute(workspaceRoot) && isInside(absPath, workspaceRoot)) {
    return { absPath, ref: relative(workspaceRoot, absPath).split(sep).join('/'), relToWorkspace: true };
  }
  return { absPath, ref: absPath, relToWorkspace: false };
}

export interface TrackerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: TrackerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface CurrentFileTracker {
  /** 记录一次编辑器切换(undefined = 全部编辑器关闭);防抖后结算 */
  setFile(absPath: string | undefined): void;
  /** 防抖结算后的当前文件 */
  getCurrent(): string | undefined;
  /** 订阅结算事件,返回退订函数 */
  onSettled(cb: (absPath: string | undefined) => void): () => void;
  /** 更新防抖窗口(设置项变更时调用) */
  setDebounceMs(ms: number): void;
  dispose(): void;
}

export function createCurrentFileTracker(opts: { debounceMs: number; timers?: TrackerTimers }): CurrentFileTracker {
  const timers = opts.timers ?? realTimers;
  let debounceMs = opts.debounceMs;
  let pending: string | undefined;
  let current: string | undefined;
  let handle: unknown;
  const listeners = new Set<(absPath: string | undefined) => void>();

  function settle(): void {
    current = pending;
    pending = undefined;
    for (const cb of listeners) cb(current);
  }

  return {
    setFile(absPath) {
      pending = absPath;
      if (handle !== undefined) timers.clearTimeout(handle);
      handle = timers.setTimeout(settle, debounceMs);
    },
    getCurrent: () => current,
    onSettled(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setDebounceMs(ms) {
      debounceMs = ms;
    },
    dispose() {
      if (handle !== undefined) timers.clearTimeout(handle);
      listeners.clear();
    },
  };
}
