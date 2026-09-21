// test/integration/dsh-context.test.ts — 真实 dsh 的上下文注入链路（DSH ≥0.1.2）
//
// 门控：PATH 上有 dsh 且 DSH_HOME 可写（真机跑法与 dsh.test.ts 一致，见其头注释）：
//   HOME=$PWD/.dsh-e2e-home DSH_HOME=$PWD/.dsh-e2e-home npm test
//
// 鉴权（0.1.2 起 /api 需要会话 cookie）：
//   测试在启动后解析子进程 stdout 打印的启动网址、兑换会话 cookie，再以 headers 注入给 dshApi——
//   生产路径由扩展的「本地代办代理」完成同样的注入（见 src/service/proxy.ts）。
//
// 线格式：dshApi 默认按 0.1.2 的斜杠端点 + payload.args 包装请求，遇 404 自动回退旧点分端点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { probeService } from '../../src/service/detect';
import { createProcessRunner } from '../../src/service/process';
import { ServiceManager } from '../../src/service/manager';
import { createDshApi, DshApiError, type DshApi, type WorkspaceView } from '../../src/context/dshApi';
import { findTargetSession, injectContext } from '../../src/context/injector';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const hasDsh = spawnSync('dsh', ['--version'], { timeout: 5000 }).status === 0;

/**
 * 门控：dsh 可用 + DSH_HOME 指向**隔离目录**且可写。
 * 本测试会创建 workspace/会话并注入上下文消息——绝不能在用户真实 `~/.dsh` 上运行，
 * 否则会污染用户自己的会话数据，因此真实 home 一律跳过。
 * 真机跑法：HOME=$PWD/.dsh-e2e-home DSH_HOME=$PWD/.dsh-e2e-home npm test
 */
function isolatedDshHome(): boolean {
  const home = process.env.DSH_HOME;
  if (home === undefined) return false;
  if (resolve(home) === resolve(join(homedir(), '.dsh'))) return false; // 真实 home：跳过
  try {
    const probeFile = join(home, `.ctx-integ-probe-${process.pid}`);
    writeFileSync(probeFile, 'x');
    rmSync(probeFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

const skipReason = !hasDsh
  ? 'dsh 命令不可用，跳过'
  : !isolatedDshHome()
    ? '需要指向隔离目录的可写 DSH_HOME（避免污染真实会话，见文件头注释），跳过'
    : false;

/** 轮询等待条件成立（支持异步条件） */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// dsh 启动时序（实测）：首页（含 __DSH_BOOT__）在 /api 路由注册之前就可访问，二者相差约 1 秒。
// ensureRunning 基于首页探测，返回 ready 后立即调用可能撞上 404 窗口（kind=unsupported）→ 轮询重试。
async function waitApiReady(
  api: DshApi,
  root: string,
  timeoutMs = 10000,
): Promise<{ workspace: WorkspaceView; created: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await api.workspaceCreate(root);
    } catch (err) {
      if (err instanceof DshApiError && err.kind === 'unsupported') {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw err;
    }
  }
  assert.fail(`等待 dsh API 就绪超时(${timeoutMs}ms)：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

test(
  '上下文注入全链路：workspace 幂等 → 会话新建/复用 → prompt 生效（0.1.2 鉴权 + 斜杠端点）',
  { skip: skipReason },
  async () => {
    const port = await freePort();
    let launchUrl: string | null = null;
    const manager = new ServiceManager(
      { host: '127.0.0.1', port, extraArgs: ['--no-open'], autoStart: true, timeoutMs: 3000, pollMs: 300 },
      {
        probeService,
        processRunner: createProcessRunner(),
        log: () => {},
        startTimeoutMs: 20000,
        onLaunchUrl: (u) => {
          launchUrl = u;
        },
      },
    );
    try {
      const s = await manager.ensureRunning();
      assert.equal(s.state, 'ready');

      // —— 会话兑换（0.1.2 鉴权）：带 token 的启动网址 → 303 + 签名 cookie ——
      await waitFor(() => launchUrl !== null, 15000, '未捕获到 dsh 启动网址');
      const tokenUrl = launchUrl as unknown as string;
      const auth = await fetch(tokenUrl, { redirect: 'manual' });
      const setCookies = auth.headers.getSetCookie?.() ?? [auth.headers.get('set-cookie') ?? ''];
      const cookie = (setCookies[0] ?? '').split(';')[0];
      assert.equal(auth.status, 303, '启动网址应返回 303 并下发会话 cookie');
      assert.ok(cookie.startsWith('dsh-auth-'), `会话 cookie 名应以 dsh-auth- 开头，实际 ${cookie.slice(0, 20)}`);

      // 未带会话的请求应被拒（鉴权真实存在），带会话的请求应可用
      const bareApi = createDshApi(`http://127.0.0.1:${port}`);
      await assert.rejects(bareApi.sessionList(), '无会话的 /api 调用必须失败（401）');
      const api = createDshApi(`http://127.0.0.1:${port}`, { headers: { cookie } });

      const root = process.cwd();
      // workspace.create 幂等（首次经 waitApiReady 等到 /api 就绪）
      const w1 = await waitApiReady(api, root);
      const w2 = await api.workspaceCreate(root);
      assert.equal(w1.workspace.workspaceId, w2.workspace.workspaceId, 'workspace.create 应幂等');
      assert.equal(w2.created, false, '二次注册同一路径应返回 created=false');

      // 首次注入：定位/新建会话并注入上下文
      const r1 = await injectContext(api, { workspaceRoot: root, ref: 'src/extension.ts' });
      assert.ok(typeof r1.sessionId === 'string' && r1.sessionId !== '', '应返回有效会话 id');
      // 消息落库：会话 blank 由 true 变为 false（0.1.2 的 history 读取改为 follow/page，
      // 这里用会话索引判定消息已被接受并固化，等价且更稳定）
      await waitFor(
        async () => {
          const list = await api.sessionList();
          const target = list.find((x) => x.sessionId === r1.sessionId);
          return target !== undefined && target.blank === false;
        },
        20000,
        '注入后会话未变为非空白（消息未固化）',
      );

      // 二次注入：复用同一会话（同 cwd 下定位到最近活动会话）
      const r2 = await injectContext(api, { workspaceRoot: root, ref: 'src/i18n.ts' });
      assert.equal(r2.sessionId, r1.sessionId, '二次注入应复用同一会话');

      // 会话定位：按 cwd 找到该会话
      const sessions = await api.sessionList();
      const found = findTargetSession(sessions, root);
      assert.equal(found?.sessionId, r1.sessionId);
    } finally {
      await manager.stop();
      manager.dispose();
    }
  },
);
