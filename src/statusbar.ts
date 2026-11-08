// src/statusbar.ts — 状态栏项：显示服务状态，点击打开面板
import * as vscode from 'vscode';
import { ServiceManager, type ServiceSnapshot } from './service/manager';
import { t } from './i18n';

/** 五种状态的图标 + 文案键 + 颜色主题 ID（绿/黄/橙/红/灰） */
const PRESETS = {
  running: { icon: '$(check)', color: 'charts.green', textKey: 'status.running' },
  starting: { icon: '$(sync~spin)', color: 'charts.yellow', textKey: 'status.starting' },
  stopping: { icon: '$(sync~spin)', color: 'charts.orange', textKey: 'status.stopping' },
  failed: { icon: '$(error)', color: 'charts.red', textKey: 'status.failed' },
  stopped: { icon: '$(circle-outline)', color: 'descriptionForeground', textKey: 'status.stopped' },
} as const;

type PresetKey = keyof typeof PRESETS;

export class StatusBarController {
  private item: vscode.StatusBarItem;

  constructor(manager: ServiceManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'dsh.openPanel';
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
    this.item.text = `${p.icon} ${t(p.textKey)}`;
    this.item.color = new vscode.ThemeColor(p.color);
    this.item.tooltip = s.error ? t(s.error, s.errorVars) : '';
  }

  dispose(): void {
    this.item.dispose();
  }
}
