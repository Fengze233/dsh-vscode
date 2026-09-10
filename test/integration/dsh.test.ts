// test/integration/dsh.test.ts — 真实 dsh web 集成测试
// 无 dsh 命令 / 无可用 dsh home 的环境自动跳过（真机跑法见 dshHomeWritable 注释）；
// 测试用随机空闲端口，避免打扰 3080。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { probeService } from '../../src/service/detect';
import { createProcessRunner } from '../../src/service/process';
import { ServiceManager } from '../../src/service/manager';

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

/** dsh 命令是否可用 */
const hasDsh = spawnSync('dsh', ['--version'], { timeout: 5000 }).status === 0;

/**
 * 真机集成测试的可运行性门控：dsh 命令在 PATH 上 **且** 当前 dsh home 可写。
 * dsh web 启动会写 profile 配置；沙箱/只读 home（CI runner 或受限环境）下
 * 服务起不来，跑真机测试只会得到误导性的失败。
 * 推荐真机跑法（工作区内自带的干净副本）：
 *   HOME=$PWD/.dsh-e2e-home DSH_HOME=$PWD/.dsh-e2e-home npm test
 */
function dshHomeWritable(): boolean {
  const home = process.env.DSH_HOME;
  if (home === undefined) return false; // 未显式指定 DSH_HOME 的普通环境不强跑真机集成
  try {
    const probeFile = join(home, `.integ-probe-${process.pid}`);
    writeFileSync(probeFile, 'x');
    rmSync(probeFile, { force: true }); // 探测即删，不残留
    return true;
  } catch {
    return false;
  }
}

const skipReason = !hasDsh
  ? 'dsh 命令不可用，跳过'
  : !dshHomeWritable()
    ? 'dsh home 不可写（真机集成需可写 home，见文件头注释），跳过'
    : false;

test('真实 dsh web：启动/复用/停止/意外退出全流程', { skip: skipReason }, async () => {
  const port = await freePort();
  const launchUrls: string[] = [];
  const runner = createProcessRunner();
  const manager = new ServiceManager(
    { host: '127.0.0.1', port, extraArgs: [], autoStart: true, timeoutMs: 3000, pollMs: 300 },
    { probeService, processRunner: runner, log: () => {}, startTimeoutMs: 20000, onLaunchUrl: (u) => launchUrls.push(u) },
  );
  try {
    // 1) 自动启动
    const s1 = await manager.ensureRunning();
    assert.equal(s1.state, 'ready');
    assert.equal(s1.owned, true);
    assert.equal(s1.url, `http://127.0.0.1:${port}/`);
    assert.equal(await probeService('127.0.0.1', port, 3000), 'dsh');

    // 1.5) stdout 启动网址捕获：0.1.2 必打印 dsh web: …/?token=…（含 LAN 后缀同行也取主 URL）
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 10000;
      const poll = setInterval(() => {
        if (launchUrls.length > 0) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          throw new Error('未捕获到 dsh web 启动网址');
        }
      }, 100);
    });
    assert.equal(launchUrls.length, 1, '启动网址应恰好捕获一次');
    assert.ok(new URL(launchUrls[0]).searchParams.has('token'), '启动网址应携带登录 token（0.1.2 鉴权）');

    // 2) 幂等复用（不重复启动）：第二次 ensureRunning 后 lastChild 仍指向同一子进程
    const firstChild = runner.lastChild;
    const s2 = await manager.ensureRunning();
    assert.equal(s2.state, 'ready');
    assert.equal(runner.lastChild, firstChild);

    // 3) 停止：服务消失
    await manager.stop();
    assert.equal(await probeService('127.0.0.1', port, 3000), 'down');

    // 4) 再次启动（自愈）
    const s3 = await manager.ensureRunning();
    assert.equal(s3.state, 'ready');

    // 5) 意外退出检测：直接杀进程 → 状态回 idle
    runner.lastChild?.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(manager.getSnapshot().state, 'idle');
    assert.equal(await probeService('127.0.0.1', port, 3000), 'down');
  } finally {
    await manager.stop(); // 清理：确保不残留 dsh 进程
    manager.dispose();
  }
});
