// src/config.ts — dsh.* 设置项读取与规范化
// 纯函数（normalizeConfig / isLoopbackHost）不依赖 vscode，可直接单测；
// readConfig 是 vscode 设置的薄封装，供 extension.ts 使用。
import * as vscode from 'vscode';

/** 用户可配置的原始值（可能缺失/非法） */
export interface RawDshConfig {
  host?: string;
  port?: number;
  autoStart?: boolean;
  stopOnExit?: boolean;
  extraArgs?: string[];
  /** 是否启用桥接（dsh.bridge.enabled） */
  bridgeEnabled?: boolean;
  /** 多根工作区取第几个根目录（dsh.workspaceRootIndex） */
  workspaceRootIndex?: number;
  /** 是否抑制桥接警告（dsh.bridge.silenceWarning） */
  silenceWarning?: boolean;
}

/** 规范化后的配置（均有合法默认值） */
export interface DshConfig {
  host: string;
  port: number;
  autoStart: boolean;
  stopOnExit: boolean;
  extraArgs: string[];
  /** 是否启用桥接（dsh.bridge.enabled） */
  bridgeEnabled: boolean;
  /** 多根工作区取第几个根目录（dsh.workspaceRootIndex） */
  workspaceRootIndex: number;
  /** 是否抑制桥接警告（dsh.bridge.silenceWarning） */
  silenceWarning: boolean;
}

/** 默认配置 */
export const DEFAULTS: DshConfig = {
  host: '127.0.0.1',
  port: 3080,
  autoStart: true,
  stopOnExit: true,
  extraArgs: [],
  bridgeEnabled: true,
  workspaceRootIndex: 0,
  silenceWarning: false,
};

/** 安全边界：仅允许回环地址 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 判断是否为回环地址 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * 规范化原始配置：非法值回退默认并记录错误描述
 * （安全规则：host 只允许回环地址，端口必须为 0..65535 的整数）
 */
export function normalizeConfig(raw: RawDshConfig): { config: DshConfig; errors: string[] } {
  const errors: string[] = [];

  // 缺失与非法需区分：字段未配置时静默回退默认（不算错误），
  // 只有提供了非法值才记录错误并回退默认。
  let host: string;
  if (typeof raw.host !== 'string') {
    host = DEFAULTS.host;
  } else {
    host = raw.host.trim();
    if (!isLoopbackHost(host)) {
      errors.push(`dsh.host must be a loopback address, got ${JSON.stringify(raw.host)}`);
      host = DEFAULTS.host;
    }
  }

  let port = raw.port;
  if (port === undefined) {
    port = DEFAULTS.port;
  } else if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push(`dsh.port must be an integer in 0..65535, got ${JSON.stringify(raw.port)}`);
    port = DEFAULTS.port;
  }

  const autoStart = typeof raw.autoStart === 'boolean' ? raw.autoStart : DEFAULTS.autoStart;
  const stopOnExit = typeof raw.stopOnExit === 'boolean' ? raw.stopOnExit : DEFAULTS.stopOnExit;
  const extraArgs = Array.isArray(raw.extraArgs)
    ? raw.extraArgs.filter((a): a is string => typeof a === 'string')
    : DEFAULTS.extraArgs;

  // 布尔设置沿用 autoStart 的缺省处理模式：仅接受布尔值，否则回退默认（不记错误）
  const bridgeEnabled = typeof raw.bridgeEnabled === 'boolean' ? raw.bridgeEnabled : DEFAULTS.bridgeEnabled;
  const silenceWarning = typeof raw.silenceWarning === 'boolean' ? raw.silenceWarning : DEFAULTS.silenceWarning;

  // workspaceRootIndex：必须为非负整数，非法值回退默认并记录错误
  let workspaceRootIndex: number;
  if (raw.workspaceRootIndex === undefined) {
    workspaceRootIndex = DEFAULTS.workspaceRootIndex;
  } else if (
    typeof raw.workspaceRootIndex !== 'number' ||
    !Number.isInteger(raw.workspaceRootIndex) ||
    raw.workspaceRootIndex < 0
  ) {
    errors.push(`dsh.workspaceRootIndex must be a non-negative integer, got ${JSON.stringify(raw.workspaceRootIndex)}`);
    workspaceRootIndex = DEFAULTS.workspaceRootIndex;
  } else {
    workspaceRootIndex = raw.workspaceRootIndex;
  }

  return {
    config: { host, port, autoStart, stopOnExit, extraArgs, bridgeEnabled, workspaceRootIndex, silenceWarning },
    errors,
  };
}

/** 从 VS Code 设置读取（薄封装，供 extension.ts 使用） */
export function readConfig(): { config: DshConfig; errors: string[] } {
  const ws = vscode.workspace.getConfiguration('dsh');
  return normalizeConfig({
    host: ws.get<string>('host'),
    port: ws.get<number>('port'),
    autoStart: ws.get<boolean>('autoStart'),
    stopOnExit: ws.get<boolean>('stopOnExit'),
    extraArgs: ws.get<string[]>('extraArgs'),
    bridgeEnabled: ws.get<boolean>('bridge.enabled'),
    workspaceRootIndex: ws.get<number>('workspaceRootIndex'),
    silenceWarning: ws.get<boolean>('bridge.silenceWarning'),
  });
}
