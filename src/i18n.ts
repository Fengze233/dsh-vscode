// src/i18n.ts — 动态文案字典
// 规则：VS Code 显示语言（vscode.env.language）以 zh- 开头 → 简体中文；
//       其余任何语言 → 英文。静态文案（package.nls.*.json）由 VS Code 自行处理，
//       本模块只负责运行时动态文案（状态栏、占位页、错误提示、日志等）。
const messages = {
  en: {
    // 面板占位页
    'panel.loading': 'Starting DSH service…',
    'panel.errorTitle': 'Failed to start DSH service',
    'panel.disconnectedTitle': 'DSH service disconnected',
    'panel.reconnect': 'Reconnect',
    'panel.retry': 'Retry',
    'panel.openExternal': 'Open in Browser',
    'panel.restart': 'Restart Service',
    'panel.stop': 'Stop Service',
    'panel.copyUrl': 'Copy URL',
    'panel.showLogs': 'Show Logs',
    // 错误原因（error 字段存的 i18n 键）
    'err.portOccupied': 'Port {port} is occupied by another program. Change dsh.port in settings, then retry.',
    'err.dshNotFound': 'The dsh command was not found. Install DeepSeek Harness first.',
    'err.nodeNotFound': 'Node.js (node.exe) was not found in PATH. Install Node.js or add it to PATH, then restart VS Code.',
    'err.spawnEinval': 'Failed to start dsh: invalid spawn parameters (working directory: {cwd}). Try opening a local folder, or set dsh.executablePath in settings.',
    'err.startTimeout': 'Service did not become ready within {seconds}s. See the DSH log for details.',
    'err.startCrashed': 'The DSH service exited unexpectedly. See the DSH log for details.',
    'err.notRunning': 'DSH service is not running and auto-start is disabled.',
    'err.loadFailed': 'Unable to load the DSH page.',
    // 状态栏
    'status.running': 'DSH: Running',
    'status.starting': 'DSH: Starting',
    'status.failed': 'DSH: Failed',
    'status.stopped': 'DSH: Stopped',
    // 辅助侧边栏引导
    'guide.secondaryTitle': 'DSH: Two Sidebar Entrances',
    'guide.secondaryText':
      'The DSH panel is available from both the Activity Bar and the Secondary Side Bar icons. Click either to open it.',
    'guide.gotIt': 'Got it',
    // 通知
    'info.urlCopied': 'URL copied: {url}',
    'info.notReady': 'DSH service is not ready yet.',
    'info.stopped': 'DSH service stopped.',
    // 桥接状态与警告
    'bridge.warnDegraded':
      'DSH bridge is not active. These features are unavailable: 1) click links to open in browser 2) click file paths to open in VS Code. You can retry installing the bridge or silence this warning.',
    'bridge.retryNow': 'Retry Install',
    'bridge.neverAgain': "Don't Show Again",
    'bridge.uninstalled': 'DSH bridge uninstalled. Restart the DSH service for the change to take effect.',
    'bridge.uninstallFailed': 'Failed to uninstall DSH bridge: {message}',
  },
  zh: {
    'panel.loading': '正在启动 DSH 服务…',
    'panel.errorTitle': 'DSH 服务启动失败',
    'panel.disconnectedTitle': 'DSH 服务已断开',
    'panel.reconnect': '重新连接',
    'panel.retry': '重试',
    'panel.openExternal': '在浏览器中打开',
    'panel.restart': '重启服务',
    'panel.stop': '停止服务',
    'panel.copyUrl': '复制网址',
    'panel.showLogs': '查看日志',
    'err.portOccupied': '端口 {port} 被其他程序占用。请在设置中修改 dsh.port 后重试。',
    'err.dshNotFound': '未找到 dsh 命令，请先安装 DeepSeek Harness。',
    'err.nodeNotFound': 'PATH 中未找到 Node.js（node.exe）。请安装 Node.js 或将其加入 PATH 后重启 VS Code。',
    'err.spawnEinval': 'dsh 启动失败：启动参数无效（工作目录：{cwd}）。请改用本地路径打开项目，或在设置中指定 dsh.executablePath。',
    'err.startTimeout': '服务在 {seconds} 秒内未就绪，详见 DSH 日志。',
    'err.startCrashed': 'DSH 服务异常退出，详见 DSH 日志。',
    'err.notRunning': 'DSH 服务未运行，且已关闭自动启动。',
    'err.loadFailed': '无法加载 DSH 页面。',
    'status.running': 'DSH: 运行中',
    'status.starting': 'DSH: 启动中',
    'status.failed': 'DSH: 失败',
    'status.stopped': 'DSH: 已停止',
    'guide.secondaryTitle': 'DSH：双侧栏入口',
    'guide.secondaryText':
      'DSH 面板可通过左侧活动栏或右侧辅助侧边栏的 DSH 图标打开，点击任意一个即可使用。',
    'guide.gotIt': '知道了',
    'info.urlCopied': '已复制网址：{url}',
    'info.notReady': 'DSH 服务尚未就绪。',
    'info.stopped': 'DSH 服务已停止。',
    'bridge.warnDegraded':
      'DSH 桥接未生效，以下功能不可用：①点击链接跳转浏览器 ②点击文件路径在 VS Code 打开。可重试安装桥接，或不再显示本警告。',
    'bridge.retryNow': '重试安装',
    'bridge.neverAgain': '不再提示',
    'bridge.uninstalled': 'DSH 桥接已卸载，重启 DSH 服务后生效。',
    'bridge.uninstallFailed': '卸载 DSH 桥接失败：{message}',
  },
} as const;

/** 文案键联合类型（en 为键的来源） */
export type MsgKey = keyof typeof messages.en;

let current: 'zh' | 'en' = 'en';

/** 按语言规则初始化（扩展激活时调用一次） */
export function initI18n(language: string): void {
  current = language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 当前语言 */
export function getLang(): 'zh' | 'en' {
  return current;
}

/** 取文案；vars 中的 {key} 会被替换 */
export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  let s: string = messages[current][key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
