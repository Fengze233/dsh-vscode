// test/vscode-stub.ts — 测试专用的 vscode 运行时桩
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
  openExternal: async () => true,
};

export const commands = {
  executeCommand: async () => undefined,
};

export const Uri = {
  file: (p: string) => ({ fsPath: p }),
};

export default { workspace, window, env, commands, Uri };
