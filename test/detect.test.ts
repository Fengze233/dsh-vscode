// test/detect.test.ts — 端口探测的单元测试（用本地假 HTTP 服务器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { probeService } from '../src/service/detect';

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
