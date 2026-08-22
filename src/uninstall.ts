// src/uninstall.ts — VS Code 卸载扩展时的自动清理钩子（package.json "uninstall" 字段）
// 约束：VS Code 在卸载扩展时用 Node 执行本脚本（不经过扩展宿主、无法 import 'vscode'），
// 只能使用 Node 内建 API；任何失败都不影响 VS Code 卸载流程（尽力而为、吞异常并打印诊断）。
// 职责：复用 installer 的 uninstallBridge，从 DSH 用户目录（$DSH_HOME/profiles/web）移除
// 桥接包目录并按 begin/end 标记还原 cordis.patch.yml，实现「卸载插件即卸载桥接」。
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createNodeFs, uninstallBridge } from './bridge/installer';

function main(): void {
  // DSH 用户目录：$DSH_HOME 优先，缺省 ~/.dsh（与扩展激活时 installOpts 的解析保持一致）
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  // 随附桥接包目录：本脚本编译产物位于 <扩展目录>/out/uninstall.js，桥接在 out/bridge-client
  const bridgeSourceDir = join(__dirname, 'bridge-client');
  try {
    uninstallBridge({ dshHome, bridgeSourceDir, fs: createNodeFs() });
    console.log('[dsh-uninstall] 已清理 DSH profile 中的桥接包（若存在）');
  } catch (err) {
    // 卸载钩子失败不应阻塞 VS Code 卸载流程：打印诊断后静默退出
    console.error('[dsh-uninstall] 清理桥接失败（不影响扩展卸载，可手动执行 DSH: 卸载桥接）:', String(err));
  }
}

main();
