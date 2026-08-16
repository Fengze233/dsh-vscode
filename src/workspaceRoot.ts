// src/workspaceRoot.ts — 工作区根目录解析（纯函数，可单测）
// 职责：从 VS Code 的工作区文件夹列表中按索引取出目标根目录的绝对路径。
// 该函数与 vscode 模块解耦，仅依赖结构化的只读视图（只读取 uri.fsPath），
// 既便于 node:test 单测，也便于被多个装配点复用。
//
// 当前唯一消费方：extension.ts 的 toManagerOptions —— 用它解析出 dsh web 子进程的
// 工作目录（cwd 兜底），让 `dsh web` 以 VS Code 工作区根目录作为进程工作目录启动。
// 注意：本函数只负责"选哪一个根目录"，不负责任何工作区同步/实体创建等副作用；
// 工作区自动同步功能已按用户决定移除，本函数作为 spawn cwd 兜底的基础能力保留。

/**
 * 多根工作区按索引取根目录。
 * 规则：空工作区返回 undefined；索引越界（含负索引）回退第一个根目录。
 * @param folders VS Code 工作区文件夹列表（只读视图，仅需 uri.fsPath）
 * @param index 目标根目录索引（多根工作区时由 dsh.workspaceRootIndex 决定）
 * @returns 选中根目录的绝对路径；空工作区返回 undefined
 */
export function resolveWorkspaceRoot(
  folders: readonly { uri: { fsPath: string } }[],
  index: number,
): string | undefined {
  if (folders.length === 0) return undefined;
  const f = folders[index] ?? folders[0];
  return f.uri.fsPath;
}
