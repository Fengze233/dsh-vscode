// src/service/launchUrl.ts — 从 dsh web 子进程输出中解析「启动网址」（含一次性登录 token）
// 纯模块：不依赖 vscode/node:child_process，便于 node:test 单测。
//
// DSH ≥0.1.2 启动后在 stdout 打印一行（对真实 0.1.2-rc.1 实测）：
//   dsh web: http://127.0.0.1:3080/?token=<43字符base64url>
// 存在局域网候选时同行追加 ` (LAN: http://<lan-ip>:<port>/?token=…)` 后缀。
// ≤0.1.1 打印裸地址（无 token）：dsh web: http://127.0.0.1:3080/
//
// 解析出的 URL 用于：① DSH ≥0.1.2 时向服务兑换浏览器会话 cookie（带 cookie 访问 303 落点）；
// ② 向用户展示可点击的登录地址。

/** 环回主机名集合（优先选它作为兑换目标；局域网候选 host 在本地不可达场景不可靠） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 从一行 dsh 输出中提取「dsh web: 」前缀的启动网址。
 * 只认 http(s)，忽略 LAN 后缀与其它输出行。
 *
 * @param line 子进程 stdout 的一整行（已去行尾换行）
 * @returns 命中的启动网址（可能带 token，也可能是不带 token 的裸地址——由调用方按 DSH 版本语义使用），
 *          不匹配返回 null
 */
export function parseLaunchUrlLine(line: string): string | null {
  // 形如 `dsh web: <url>`；URL 取到空白处为止（LAN 后缀与下一个空格分段不会被并入）。
  const m = /^dsh web: (https?:\/\/[^\s]+)/.exec(line.trim());
  if (m === null) return null;
  try {
    const url = new URL(m[1]);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname === '') return null;
    return url.href;
  } catch {
    return null; // 非法 URL：视为噪音行
  }
}

/**
 * 判定启动网址是否带登录 token（DSH ≥0.1.2：`?token=<43字符>`）。
 * @param url 解析出的启动网址
 * @returns token 值（base64url 字符串）；不带 token 返回 null
 */
export function tokenFromLaunchUrl(url: string): string | null {
  try {
    const token = new URL(url).searchParams.get('token');
    if (token === null || token === '') return null;
    // 与 DSH 服务端格式对齐：SECRET_BYTES=32 → base64url 恰好 43 字符（防御性校验，防噪音误配）
    return /^[A-Za-z0-9_-]{20,64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * 在一组候选启动网址里挑选「本次会话应兑换 cookie 的目标网址」：
 * 优先环回主机（127.0.0.1/localhost）且与目标端口一致者；无环回命中时取第一个。
 *
 * 排序理由：DSH 会额外打印局域网候选（`(LAN: http://192.168.x.x:PORT/?token=…)`），
 * 扩展宿主若不在该局域网段则不可达；环回地址在本机必然可达，且 cookie 按 Host 头
 * authority 签发（见 dsh-client-connection），用环回兑换后转发时 Host 一致。
 *
 * @param urls       候选启动网址（通常 1~2 个：环回 + 可选 LAN）
 * @param expectedPort 目标服务端口（不匹配的候选直接排除；0/undefined 表示不限）
 * @returns 首选网址；无匹配返回 null
 */
export function pickLaunchUrl(urls: string[], expectedPort?: number): string | null {
  const portOk = (u: URL): boolean => {
    if (expectedPort === undefined || expectedPort <= 0) return true;
    const port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
    return port === expectedPort;
  };
  const normalized = urls
    .map((u) => {
      try {
        return new URL(u);
      } catch {
        return null;
      }
    })
    .filter((u): u is URL => u !== null && portOk(u));
  if (normalized.length === 0) return null;
  // 稳定排序：环回优先，其次按原顺序
  const hostScore = (u: URL): number => (LOOPBACK_HOSTS.has(u.hostname) ? 0 : 1);
  const best = [...normalized].sort((a, b) => hostScore(a) - hostScore(b))[0];
  return best.href;
}
