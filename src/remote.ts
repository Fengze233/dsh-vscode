// src/remote.ts — 远程（SSH Remote/WSL/Dev Container/Codespaces）场景检测与 URL 隧道解析
// 纯逻辑 + 注入式 vscode API（asExternalUri），便于 node:test 单测。
// 设计背景（v0.3.0 需求 1）：在远程窗口中，扩展宿主运行在远端，spawn 的 dsh 跑在远端
// 127.0.0.1:<port>；而面板 iframe 在本地浏览器里无法直接访问远端回环地址。
// 做法：调用 vscode.env.asExternalUri 让 VS Code 自动在「远端 127.0.0.1:<port> ↔ 本地」建立
// 端口转发隧道，返回本地可达的 URI；本地（非远程）时 asExternalUri 原样返回，无需分支。

/** 最小 Uri 形状（兼容 vscode.Uri 与测试桩） */
export type UriLike = { toString(): string };

/**
 * 判断窗口是否为远程窗口：vscode.env.remoteName 非空即远程。
 * 空串/未定义视为本地。
 */
export function isRemoteName(name: string | undefined): boolean {
  return typeof name === 'string' && name.trim() !== '';
}

/** asExternalUri 注入接口（生产接 vscode.env，测试注入假实现） */
export interface ExternalUriApp {
  asExternalUri(uri: UriLike): Promise<UriLike>;
}

/**
 * 构造「URL → 本地可达 URL」的解析器。
 * - 本地：asExternalUri 原样返回；
 * - 远程：VS Code 自动建隧道并返回本地 URI；
 * - asExternalUri 抛错时回退原 URL（不中断面板，本地可达场景仍可用）。
 */
export function createUrlResolver(app: ExternalUriApp) {
  return async (url: string): Promise<string> => {
    try {
      const r = await app.asExternalUri({ toString: () => url } as UriLike);
      return r.toString();
    } catch {
      return url;
    }
  };
}
