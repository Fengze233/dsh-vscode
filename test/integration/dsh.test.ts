// test/integration/dsh.test.ts — 真实 dsh web 集成测试
// 无 dsh 命令的环境自动跳过；测试用随机空闲端口，避免打扰 3080。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
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

test('真实 dsh web：启动/复用/停止/意外退出全流程', { skip: !hasDsh && 'dsh 命令不可用，跳过' }, async () => {
  const port = await freePort();
  const runner = createProcessRunner();
  const manager = new ServiceManager(
    { host: '127.0.0.1', port, extraArgs: [], autoStart: true, timeoutMs: 3000, pollMs: 300 },
    { probeService, processRunner: runner, log: () => {}, startTimeoutMs: 20000 },
  );
  try {
    // 1) 自动启动
    const s1 = await manager.ensureRunning();
    assert.equal(s1.state, 'ready');
    assert.equal(s1.owned, true);
    assert.equal(s1.url, `http://127.0.0.1:${port}/`);
    assert.equal(await probeService('127.0.0.1', port, 3000), 'dsh');

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
