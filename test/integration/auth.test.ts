// test/integration/auth.test.ts — 真实 dsh（≥0.1.2 鉴权）端到端：启动 → 捕获启动网址 →
// 兑换会话 cookie → 经本地代办访问 200（对照：无 cookie 直连 401）
// 与 dsh.test.ts 相同的运行门控：需要 PATH 上的 dsh + 可写 DSH_HOME（见 dsh.test.ts 头注释）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { probeService } from '../../src/service/detect';
import { parseLaunchUrlLine } from '../../src/service/launchUrl';
import { exchangeSession, getValidSession, probeSession, type SessionStore, type StoredSession } from '../../src/service/session';
import { createDshProxy } from '../../src/service/proxy';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 取一个当前空闲的随机端口 */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** 内存会话存储 */
function memStore(): SessionStore {
  const map = new Map<string, StoredSession>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
  };
}

/** 门控：dsh 可用且 DSH_HOME 可写（与 dsh.test.ts 一致） */
function usable(): boolean {
  const home = process.env.DSH_HOME;
  if (home === undefined) return false;
  try {
    const probeFile = join(home, `.auth-probe-${process.pid}`);
    writeFileSync(probeFile, 'x');
    rmSync(probeFile, { force: true }); // 探测即删，不残留
    return true;
  } catch {
    return false;
  }
}

const skipReason = usable() ? false : '需要 PATH 上的 dsh 与可写 DSH_HOME（真机跑法见 dsh.test.ts 头注释），跳过';

/** 原始 HTTP 请求（可设置 Origin / Sec-Fetch-* 等 fetch 会过滤的头），只取状态码 */
function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 原始 POST（RPC envelope），返回状态码与响应体文本 */
function rawPost(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
      },
      (res) => {
        let out = '';
        res.on('data', (d) => (out += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test(
  '真实 dsh 0.1.2 鉴权全链路：启动→解析启动网址→兑换→代理访问 200（直连 401）',
  { skip: skipReason },
  async () => {
    const port = await freePort();
    const store = memStore();
    // stdio 数组的 null/pipe 组合会让 TS 推导成 ChildProcessByStdio<null,…>，
    // 实际运行时 stdout/stderr 均为可读流：经 unknown 断言（类型与运行时不符仅限声明层）
    const child = spawn(
      'dsh',
      ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'],
      { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    ) as unknown as ChildProcessWithoutNullStreams;
    let stderrTail = '';
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    /** 从 stdout 行里等启动网址（dsh web: http://…/?token=…） */
    const launchUrl = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`等待启动网址超时；stderr 尾部: ${stderrTail}`)), 60000);
      child.stdout.on('data', (d) => {
        buffer += d.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const url = parseLaunchUrlLine(line);
          if (url !== null) {
            clearTimeout(timer);
            resolve(url);
            return;
          }
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`dsh 提前退出 code=${code}; stderr 尾部: ${stderrTail}`));
      });
    });
    assert.ok(launchUrl.includes('/?token='), '启动网址应带一次性 token');

    try {
      // 1) 探测：鉴权 401 被识别为 dsh（修复的核心断言）
      assert.equal(await probeService('127.0.0.1', port, 3000), 'dsh');

      // 2) 兑换：带 token 的启动网址 → 303 → 签名 cookie 落存储
      const exch = await exchangeSession(launchUrl, { fetchImpl: fetch, store });
      assert.equal(exch.status, 'ok', '真实 dsh 兑换应成功');
      const authority = new URL(launchUrl).host;
      const session = getValidSession(authority, { fetchImpl: fetch, store });
      assert.ok(session, '会话应已存储');
      assert.ok(session!.cookie.startsWith('dsh-auth-'), 'cookie 名应以 dsh-auth- 开头');

      // 3) 对照：无 cookie 直连 → 401；带 cookie 健康探测 → ok
      const bare = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
      assert.equal(bare.status, 401, '无 cookie 直连必须 401（鉴权真实存在）');
      assert.equal(await probeSession(authority, { fetchImpl: fetch, store }), 'ok');

      // 4) 经本地代办访问：代理注入 cookie + Host 重写 → 200 且首页是 DSH
      const proxy = createDshProxy({
        getTarget: () => ({ url: `http://127.0.0.1:${port}`, cookie: session!.cookie }),
      });
      await proxy.start();
      try {
        const viaProxy = await fetch(proxy.baseUrl, { redirect: 'manual' });
        assert.equal(viaProxy.status, 200, '经代办访问应拿到 DSH 首页');
        const html = await viaProxy.text();
        assert.ok(html.includes('<!doctype html') || html.includes('<html'), '应返回真实 HTML 页面');

        // 4.5) 浏览器式 /api 请求（Origin=代理 origin + Sec-Fetch-Site=cross-site）必须通过
        // DSH 的 browser-trust fence：403 是拦截信号（用户实测「加载提供方目录失败…HTTP 403」），
        // 404 表示已放行到路由层（本用例只验证未拦截）。
        const apiStatus = await rawStatus(`${proxy.baseUrl}api/whatever`, {
          origin: proxy.baseUrl.slice(0, -1),
          'sec-fetch-site': 'cross-site',
        });
        assert.notEqual(apiStatus, 403, '代办必须让 /api 通过 DSH 的 browser-trust fence（403 回归）');
        assert.equal(apiStatus, 404, '无匹配路由时应为 404（说明已通过 fence）');

        // 4.6) 会话列表可读（用户症状「主页面看不到之前的工作区和对话」）：
        // 0.1.2 的 RPC 走 /api/<channel>/<method> 斜杠端点 + {type,rpcId,method,payload:{args:{…}}} envelope，
        // session/list 的参数名是 _request（不可省略，否则 gateway/arguments-invalid）。
        const list = await rawPost(
          `${proxy.baseUrl}api/session/list`,
          { type: 'client-request', rpcId: 'it-1', method: 'session/list', payload: { args: { _request: {} } } },
          { origin: proxy.baseUrl.slice(0, -1), 'sec-fetch-site': 'cross-site' },
        );
        assert.equal(list.status, 200, '会话列表接口应可达');
        const parsed = JSON.parse(list.body) as { result?: { ok?: boolean; value?: { items?: unknown[] } } };
        assert.equal(parsed.result?.ok, true, `会话列表应返回成功（响应：${list.body.slice(0, 200)}）`);
        assert.ok(Array.isArray(parsed.result?.value?.items), '会话列表应包含 items 数组');
      } finally {
        await proxy.stop();
      }

      // 5) 代理目标缺会话时明确 503（而非挂起/误报占用）
      const proxyNoSession = createDshProxy({ getTarget: () => null });
      await proxyNoSession.start();
      try {
        const res = await fetch(proxyNoSession.baseUrl);
        assert.equal(res.status, 503);
      } finally {
        await proxyNoSession.stop();
      }
    } finally {
      // 清理：杀子进程，恢复现场
      child.kill('SIGTERM');
      await new Promise((r) => {
        child.once('exit', r);
        setTimeout(r, 3000);
      });
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  },
);
