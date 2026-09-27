// test/vscode-stub.ts — 测试专用的 vscode 运行时桩
// 测试环境（node --test）没有 VS Code 宿主，被单测间接引用的模块（config.ts、
// panel/provider.ts 等）顶层 `import * as vscode` 需要在本模块作用域内解析。
// 这里只提供最小可用对象：接口形状以"被引用的那几个模块实际读到的成员"为准
// （v0.4.2 撤回 PR #11 后仍需 env/window/commands/Uri，因为 provider 会读它们）。
export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
  }),
};

export const window = {
  showTextDocument: async () => undefined,
  showWarningMessage: () => undefined,
};

export const env = {
  // 远程分类（classifyRemote）读它：undefined 视为本地窗口
  remoteName: undefined,
  openExternal: async () => true,
  clipboard: {
    writeText: async () => undefined,
    readText: async () => '',
  },
};

export const commands = {
  executeCommand: async () => undefined,
};

export const Uri = {
  file: (p: string) => ({ fsPath: p }),
  parse: (s: string) => ({ toString: () => s }),
};

export default { workspace, window, env, commands, Uri };
