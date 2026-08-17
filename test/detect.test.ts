// test/detect.test.ts — 端口探测的单元测试（用本地假 HTTP 服务器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { probeService, findFreePort } from '../src/service/detect';

/** 启动本地 HTTP 服务器并返回 { server, port } */
async function serve(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

const DSH_HTML = '<!doctype html><html><head><script>window.__DSH_BOOT__ = {}</script></head><body></body></html>';
const OTHER_HTML = '<!doctype html><html><head><title>Nginx</title></head><body>hi</body></html>';

test('首页含 __DSH_BOOT__ 标记 → dsh', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(DSH_HTML);
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000), 'dsh');
  } finally {
    server.close();
  }
});

test('有响应但不是 DSH → foreign', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(OTHER_HTML);
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000), 'foreign');
  } finally {
    server.close();
  }
});

test('端口无监听 → down', async () => {
  // 先占一个端口再释放，确保该端口此刻无人监听
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  assert.equal(await probeService('127.0.0.1', port, 1000), 'down');
});

test('响应超时 → down', async () => {
  // 只接受连接、永不响应，验证 AbortController 超时生效
  const srv = net.createServer(() => {
    /* 挂起连接，不发任何数据 */
  });
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as AddressInfo).port;
  try {
    assert.equal(await probeService('127.0.0.1', port, 200), 'down');
  } finally {
    srv.close();
  }
});

test('findFreePort：从 startPort+1 起找到第一个空闲端口', async () => {
  const calls: number[] = [];
  const probe = async (_host: string, port: number): Promise<'dsh' | 'foreign' | 'down'> => {
    calls.push(port);
    // 模拟 3081/3082 被占用，3083 空闲
    return port === 3083 ? 'down' : 'foreign';
  };
  const found = await findFreePort('127.0.0.1', 3080, 50, probe);
  assert.equal(found, 3083);
  assert.deepEqual(calls, [3081, 3082, 3083]); // 依序探测，找到即停
});

test('findFreePort：全部候选被占用返回 null', async () => {
  const probe = async (): Promise<'dsh' | 'foreign' | 'down'> => 'foreign';
  assert.equal(await findFreePort('127.0.0.1', 3080, 3, probe), null);
});

test('findFreePort：候选超出 65535 提前停止并返回 null', async () => {
  let calls = 0;
  const probe = async (): Promise<'dsh' | 'foreign' | 'down'> => {
    calls += 1;
    return 'foreign';
  };
  assert.equal(await findFreePort('127.0.0.1', 65535, 10, probe), null);
  assert.equal(calls, 0); // 65536 超出合法范围，一次都不探测
});
