// src/context/injector.ts — 上下文注入编排(纯模块,不依赖 vscode)
// 职责:定位目标会话(按 cwd 找项目下最近活动会话,无则新建)→ 构造消息文本 → prompt 注入。
import type { DshApi, SessionSummary } from './dshApi';

/** 上下文式注入文案:抑制 AI 回复,仅供后续对话参考 */
export function buildContextMessage(ref: string): string {
  return `上下文:当前文件 \`${ref}\`(仅供参考,无需回复)`;
}

/** 提问式文案:携带问题与文件引用(AI 正常回复) */
export function buildQuestionMessage(question: string, ref: string): string {
  const q = question.trim();
  return q === '' ? `请看这个文件:\`${ref}\`` : `${q}\n\n文件:\`${ref}\``;
}

/** 选区消息:附言 + 文件:行号 + 代码块 */
export function buildSelectionMessage(note: string, ref: string, startLine: number, code: string): string {
  const n = note.trim();
  const head = n === '' ? `选中内容来自 \`${ref}:${startLine}\`:` : `${n}\n\n选自 \`${ref}:${startLine}\`:`;
  return `${head}\n\n\`\`\`\n${code}\n\`\`\``;
}

/** 定位目标会话:按 cwd 过滤(无工作区根则不过滤),updatedAt 降序取最近活动 */
export function findTargetSession(sessions: SessionSummary[], workspaceRoot?: string): SessionSummary | undefined {
  const candidates = workspaceRoot !== undefined ? sessions.filter((s) => s.cwd === workspaceRoot) : sessions;
  return [...candidates].sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export interface InjectResult {
  sessionId: string;
  created: boolean;
}

/** 注入任意文本:定位/新建会话后 prompt(注入编排核心) */
export async function injectText(
  api: DshApi,
  opts: { workspaceRoot?: string; text: string },
): Promise<InjectResult> {
  if (opts.workspaceRoot !== undefined) {
    await api.workspaceCreate(opts.workspaceRoot); // 幂等注册工作区
  }
  const sessions = await api.sessionList();
  const target = findTargetSession(sessions, opts.workspaceRoot);
  if (target) {
    await api.sessionPrompt({ sessionId: target.sessionId, text: opts.text });
    return { sessionId: target.sessionId, created: false };
  }
  const created = await api.sessionCreate({ cwd: opts.workspaceRoot });
  await api.sessionPrompt({ sessionId: created.sessionId, text: opts.text });
  return { sessionId: created.sessionId, created: true };
}

/** 上下文式注入(当前文件引用) */
export function injectContext(
  api: DshApi,
  opts: { workspaceRoot?: string; ref: string },
): Promise<InjectResult> {
  return injectText(api, { workspaceRoot: opts.workspaceRoot, text: buildContextMessage(opts.ref) });
}

/** 提问式注入(问题 + 文件引用) */
export function injectQuestion(
  api: DshApi,
  opts: { workspaceRoot?: string; question: string; ref: string },
): Promise<InjectResult> {
  return injectText(api, { workspaceRoot: opts.workspaceRoot, text: buildQuestionMessage(opts.question, opts.ref) });
}
