// src/bridge/status.ts — 桥接状态评估（纯函数）
// 职责：综合「安装结果」与「握手回执」判定桥接的最终状态，并给出对应的警告文案键。
// 纯函数、无副作用、不依赖 vscode，便于单测。
import type { BridgeInstallResult } from './installer';
import type { MsgKey } from '../i18n';

/** 桥接最终状态：
 * - ok：握手成功，功能可用；
 * - pending-restart：安装成功但握手尚未发生（面板未打开/超时未回执），需重启服务或等待；
 * - degraded：安装失败或握手失败，功能降级不可用。 */
export type BridgeStatus = 'ok' | 'pending-restart' | 'degraded';

/**
 * 综合安装结果与握手结果判定最终状态。
 * 规则（按优先级）：
 * 1. install degraded → degraded（安装/IO 失败，无论握手如何）；
 * 2. handshakeOk === true → ok（握手回执确认成功）；
 * 3. handshakeOk === undefined（握手未发生/超时）且 install ok → pending-restart；
 * 4. install ok 且 handshakeOk === false → degraded（握手明确失败）。
 */
export function evaluateBridgeStatus(
  install: BridgeInstallResult,
  handshakeOk: boolean | undefined,
): BridgeStatus {
  if (install.status === 'degraded') return 'degraded';
  if (handshakeOk === true) return 'ok';
  if (handshakeOk === undefined) return 'pending-restart';
  return 'degraded';
}

/**
 * 警告文案键：仅 degraded 状态给出文案（说明不可用功能），其余状态无需警告返回 null。
 */
export function bridgeWarningText(status: BridgeStatus): MsgKey | null {
  return status === 'degraded' ? 'bridge.warnDegraded' : null;
}
