// src/service/detect.ts — 端口探测：判断目标地址上是否运行着 DSH web 服务
// 纯模块：不依赖 vscode，可用 node:test 直接单测。

/** 探测结果 */
export type ProbeResult = 'dsh' | 'foreign' | 'down';

/** DSH 首页的稳定识别特征（首页 HTML 内联了 window.__DSH_BOOT__ 启动数据，已实测确认） */
const DSH_MARKER = '__DSH_BOOT__';

/**
 * 探测 host:port 上运行的服务：
 * - 200 且首页含 DSH 标记 → 'dsh'
 * - 有 HTTP 响应但不是 DSH → 'foreign'（端口被其他程序占用）
 * - 连接失败/超时/拒绝 → 'down'（视为未运行）
 */
export async function probeService(
  host: string,
  port: number,
  timeoutMs = 3000,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${host}:${port}/`, {
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!res.ok) return 'foreign';
    const body = await res.text();
    return body.includes(DSH_MARKER) ? 'dsh' : 'foreign';
  } catch {
    // 网络错误 / 超时中断：一律视为未运行
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/** 端口被占用时自动替换的候选尝试次数（从原端口 +1 起依次探测） */
export const PORT_FALLBACK_ATTEMPTS = 50;

/**
 * 从 startPort+1 开始依次探测，返回第一个「未运行」的端口号（探测结果为 down 视为空闲）。
 * 全部候选都被占用或超出 65535 时返回 null，由调用方保持原「端口被占用」错误。
 *
 * @param host       目标主机（与 probeService 一致）
 * @param startPort  被占用端口（候选从其 +1 开始）
 * @param attempts   最多尝试的候选数
 * @param probeImpl  探测实现（默认 probeService；单测可注入假实现）
 * @param timeoutMs  单次探测超时（透传给 probeImpl）
 */
export async function findFreePort(
  host: string,
  startPort: number,
  attempts: number,
  probeImpl: (host: string, port: number, timeoutMs?: number) => Promise<ProbeResult> = probeService,
  timeoutMs?: number,
): Promise<number | null> {
  for (let offset = 1; offset <= attempts; offset++) {
    const candidate = startPort + offset;
    if (candidate > 65535) break; // 超出合法端口范围，停止
    const result = await probeImpl(host, candidate, timeoutMs);
    if (result === 'down') return candidate;
  }
  return null;
}
