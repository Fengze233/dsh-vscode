// src/statusbar.ts — 状态栏项：显示服务状态，点击打开面板
//
// 视觉风格对齐 Claude Code 的状态栏项（真机对照：`✻ Claude Code`，无自定义颜色）：
// 只留「一个符号 + 产品名」，具体状态放进 tooltip；只有失败/已停止才用主题色，
// 免得状态栏被一个常驻的绿色/橙色条目抢注意力。
import * as vscode from 'vscode';
import { ServiceManager, type ServiceSnapshot } from './service/manager';
import { t } from './i18n';

/** 各状态的图标与提示文案；颜色只在「需要被注意到」的状态下给 */
const PRESETS = {
  // 不做产品图标：`StatusBarItem.text` 只支持纯文本与 codicon（`$(...)`），不支持图片；
  // codicon 里也没有鲸鱼。真机确认「用 emoji 代鲸鱼」也不可接受，于是按用户要求去掉图标，
  // 只在「进行中/失败」这两种需要被注意到的状态用 codicon 表达状态。
  running: { icon: '', textKey: 'status.running', color: undefined },
  starting: { icon: '$(sync~spin)', textKey: 'status.starting', color: undefined },
  stopping: { icon: '$(sync~spin)', textKey: 'status.stopping', color: undefined },
  failed: { icon: '$(error)', textKey: 'status.failed', color: 'charts.red' },
  stopped: { icon: '', textKey: 'status.stopped', color: 'descriptionForeground' },
} as const;

type PresetKey = keyof typeof PRESETS;

/** 状态栏上短名（Claude Code 用 `✻ Claude Code`，我们保持一致只显示产品名） */
const SHORT_NAME = 'DSH';

export class StatusBarController {
  private item: vscode.StatusBarItem;

  constructor(manager: ServiceManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    // 点击状态栏 = 在编辑区新开一个 DSH 标签页（与编辑器标题栏图标同一入口，可多开）。
    // v0.5.0 指向 dsh.openPanel（聚焦侧边栏），真机反馈"点开后不在编辑区"。
    this.item.command = 'dsh.openFromTitle';
    this.item.show();
    manager.onChange((s) => this.update(s));
    this.update(manager.getSnapshot());
  }

  private update(s: ServiceSnapshot): void {
    let key: PresetKey;
    switch (s.state) {
      case 'ready':
        key = 'running';
        break;
      case 'failed':
        key = 'failed';
        break;
      case 'idle':
        key = 'stopped';
        break;
      case 'stopping':
        key = 'stopping';
        break;
      case 'detecting':
      case 'starting':
      case 'waiting':
        key = 'starting';
        break;
    }
    const p = PRESETS[key];
    // icon 为空时只显示产品名（不留多余空格）
    this.item.text = p.icon === '' ? SHORT_NAME : `${p.icon} ${SHORT_NAME}`;
    this.item.color = p.color === undefined ? undefined : new vscode.ThemeColor(p.color);
    // 具体状态与错误都放 tooltip：状态栏本身保持安静（对齐 Claude Code 的观感）
    this.item.tooltip = s.error ? t(s.error, s.errorVars) : t(p.textKey);
  }

  dispose(): void {
    this.item.dispose();
  }
}
