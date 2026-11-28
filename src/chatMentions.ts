// src/chatMentions.ts — 把资源管理器选中的文件/文件夹格式化成 DSH 输入框里的 @ 引用
//
// 语法来源（DSH 源码，不是猜测）：
//   - `@deepseek-ai/dsh-file-reference/grammar` 的 formatFileMention：文件夹的引用文本必须以 '/'
//     结尾（编辑器靠这个区分文件与文件夹）；路径含空白时用 `@"路径"` 引号形态。
//   - `@deepseek-ai/dsh-client-ui-reference` 的 user-text-rules：`@"..."` 必须成对闭合，
//     否则整段会被当成普通文本（v0.5.0 只发 `@路径`，文件夹被当成文件 → 打不开、也应用不上）。
// 因此这里只负责生成"最终可提交"的引用文本：文件夹补尾斜杠、含空白加成对引号、分隔符统一 '/'。
//
// 相对基准是 DSH 会话的工作目录（自启时由 dsh.workspaceRootIndex 选出的工作区根，
// 见 extension.ts 的 resolveWorkspaceRoot）；工作区外的路径无法相对表示，退回绝对路径
// （DSH 的 resolveWorkspacePath 接受绝对路径）。

/** 一个待插入的引用目标 */
export interface MentionTarget {
  /** 文件系统路径（Uri.fsPath，Windows 下是反斜杠形式） */
  readonly path: string;
  /** 是否为文件夹：决定是否补尾斜杠 */
  readonly isDirectory: boolean;
}

/** Windows 反斜杠统一成正斜杠（DSH 侧一律按 '/' 解析） */
export function toPosixPath(p: string): string {
  return p.replace(/\\/gu, '/');
}

/**
 * 计算引用里使用的路径：在工作区根内 → 相对路径；否则 → 绝对路径（正斜杠）。
 *
 * 工作区根按字面前缀比较（与 DSH 的 relativizeToCwd 口径一致，不做 realpath）；
 * 根目录自身没有有意义的相对写法，保留绝对路径。
 */
export function relativeToRoot(fsPath: string, root: string | undefined): string {
  const normalized = toPosixPath(fsPath);
  if (root === undefined || root === '') return normalized;
  const rootPosix = toPosixPath(root).replace(/\/+$/u, '');
  if (rootPosix === '') return normalized;
  if (normalized === rootPosix) return normalized;
  if (normalized.startsWith(`${rootPosix}/`)) return normalized.slice(rootPosix.length + 1);
  return normalized;
}

/**
 * 生成单个 @ 引用文本；路径含双引号或控制字符时返回 null。
 *
 * 返回 null 而不是硬拼：DSH 的 formatFileMention 对这些字符同样直接放弃，
 * 插入一段无法解析的引用只会让用户以为"添加成功"却什么都带不进去。
 */
export function formatMention(target: MentionTarget, root?: string): string | null {
  let path = relativeToRoot(target.path, root);
  if (target.isDirectory && !path.endsWith('/')) path += '/';
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return null;
  // 成对引号同样适用于文件夹：`@"dir with space/"` 才能被 user-text-rules 识别为文件夹引用
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}

/** 批量生成引用文本；无法表示的路径被跳过（调用方按数量提示） */
export function formatMentions(targets: readonly MentionTarget[], root?: string): string[] {
  const mentions: string[] = [];
  for (const target of targets) {
    const mention = formatMention(target, root);
    if (mention !== null) mentions.push(mention);
  }
  return mentions;
}
