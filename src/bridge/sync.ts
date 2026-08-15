// src/bridge/sync.ts — VS Code 工作区与 DSH workspace 的同步（纯编排，可单测）
// 职责：把 VS Code 当前工作区根目录幂等地映射为 DSH 的 workspace 实体——
// 列表命中（path 相同）直接复用，否则创建。纯函数不依赖 vscode，便于 node:test 单测。
// 生产装配见 extension.ts 的 syncOnce 流程（调用 Task 3 的 DSH API 信封客户端）。
import type { DshApiClient, WorkspaceItem } from './api';

/**
 * 多根工作区按索引取根目录。
 * 规则：空工作区返回 undefined；索引越界（含负索引）回退第一个根目录。
 * @param folders VS Code 工作区文件夹列表（只读视图，仅需 uri.fsPath）
 * @param index 目标根目录索引（多根工作区时由 dsh.workspaceRootIndex 决定，Task 6 接入）
 */
export function resolveWorkspaceRoot(
  folders: readonly { uri: { fsPath: string } }[],
  index: number,
): string | undefined {
  if (folders.length === 0) return undefined;
  const f = folders[index] ?? folders[0];
  return f.uri.fsPath;
}

/**
 * 幂等同步：list 命中（path 相同）复用，否则 create。
 * @param api DSH API 客户端（Task 3 的 createDshApiClient 产物）
 * @param workspaceRoot VS Code 工作区根目录的绝对路径
 * @returns 命中复用或新建的 workspace 条目
 */
export async function syncWorkspace(api: DshApiClient, workspaceRoot: string): Promise<WorkspaceItem> {
  const items = await api.workspaceList();
  const hit = items.find((w) => w.path === workspaceRoot);
  if (hit !== undefined) return hit;
  return api.workspaceCreate(workspaceRoot);
}
