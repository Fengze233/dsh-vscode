// test/session.test.ts — DSH 0.1.2 浏览器会话兑换/持有/健康检查的单元测试
// 用本地 HTTP 假服务器复刻 dsh-client-connection 的兑换协议（303 + 签名 cookie）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  exchangeSession,
  getValidSession,
  dropSession,
  probeSession,
  parseLaunchTarget,
  type SessionStore,
  type StoredSession,
} from '../src/service/session';

/** 内存会话存储（测试用） */
function memStore(): SessionStore & { map: Map<string, StoredSession> } {
  const map = new Map<string, StoredSession>();
  return {
    map,
    get: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
  };
}

/** 启动本地 HTTP 服务器 */
async function serve(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

/** 复刻 dsh 0.1.2 的 303 兑换响应 */
const DSH_SET_COOKIE =
  'dsh-auth-aG9zdDoxMjM0NTY3OA==.v1.payload.signature; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict';

test('exchangeSession：303 + dsh cookie → ok 并写入存储（30 天）', async () => {
  const { server, port } = await serve((req, res) => {
    if (req.url === '/?token=abc123') {
      res.writeHead(303, { location: '/', 'set-cookie': DSH_SET_COOKIE, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const store = memStore();
  try {
    const r = await exchangeSession(`http://127.0.0.1:${port}/?token=abc123`, {
      fetchImpl: fetch,
      store,
      now: () => 1_000_000_000_000,
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.authority, `127.0.0.1:${port}`);
    assert.equal(r.expiresAt, 1_000_000_000_000 + 2_592_000_000);
    const saved = store.map.get(`auth-session:127.0.0.1:${port}`);
    assert.ok(saved, '会话应写入存储');
    assert.equal(saved!.cookie.startsWith('dsh-auth-'), true);
    assert.equal(saved!.cookie.includes(';'), false, '存储的 cookie 值不应带属性（注入 Cookie 头用 name=value）');
  } finally {
    server.close();
  }
});

test('exchangeSession：200（0.1.1 及更早无鉴权）→ no-auth', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>old dsh</html>');
  });
  const store = memStore();
  try {
    const r = await exchangeSession(`http://127.0.0.1:${port}/?token=abc123`, { fetchImpl: fetch, store });
    assert.equal(r.status, 'no-auth');
    assert.equal(store.map.size, 0, '无鉴权不应写 cookie');
  } finally {
    server.close();
  }
});

test('exchangeSession：401（token 已失效）→ rejected', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  const store = memStore();
  try {
    const r = await exchangeSession(`http://127.0.0.1:${port}/?token=stale`, { fetchImpl: fetch, store });
    assert.equal(r.status, 'rejected');
    assert.ok(r.reason.includes('401'));
  } finally {
    server.close();
  }
});

test('exchangeSession：303 无 dsh cookie / 无法解析的 URL → rejected', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(303, { location: '/elsewhere' }); // 非 dsh 语义的 303
    res.end();
  });
  const store = memStore();
  try {
    const r1 = await exchangeSession(`http://127.0.0.1:${port}/?token=abc`, { fetchImpl: fetch, store });
    assert.equal(r1.status, 'rejected');
    const r2 = await exchangeSession('not-a-url', { fetchImpl: fetch, store });
    assert.equal(r2.status, 'rejected');
    const r3 = await exchangeSession(`http://127.0.0.1:${port}/`, { fetchImpl: fetch, store }); // 无 token
    assert.equal(r3.status, 'rejected');
  } finally {
    server.close();
  }
});

test('getValidSession：未过期返回记录；已过期删除并返回 undefined', () => {
  const store = memStore();
  const now = 10_000_000_000_000;
  store.set('auth-session:127.0.0.1:3080', {
    cookie: 'dsh-auth-x=v1', expiresAt: now + 1000, authority: '127.0.0.1:3080', issuedAt: now,
  });
  const deps = { fetchImpl: fetch, store, now: () => now };
  assert.equal(getValidSession('127.0.0.1:3080', deps)?.cookie, 'dsh-auth-x=v1');
  // 过期后：返回 undefined 且记录被清理
  assert.equal(getValidSession('127.0.0.1:3080', { ...deps, now: () => now + 2000 }), undefined);
  assert.equal(store.map.size, 0, '过期记录应被删除');
});

test('dropSession：删除指定 authority 的会话', () => {
  const store = memStore();
  store.set('auth-session:h:1', { cookie: 'x=y', expiresAt: 9e15, authority: 'h:1', issuedAt: 0 });
  dropSession('h:1', { fetchImpl: fetch, store });
  assert.equal(store.map.size, 0);
});

test('probeSession：200=ok / 401=expired / 连接失败=down', async () => {
  const { server, port } = await serve((req, res) => {
    const hasCookie = (req.headers.cookie ?? '').includes('dsh-auth-');
    if (!hasCookie) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('dsh web authentication required\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>ok</html>');
  });
  const store = memStore();
  try {
    const deps = { fetchImpl: fetch, store };
    // 无会话 → 不带 cookie → 401 → expired
    assert.equal(await probeSession(`127.0.0.1:${port}`, deps), 'expired');
    // 写入有效会话 → 200 → ok
    store.set(`auth-session:127.0.0.1:${port}`, {
      cookie: 'dsh-auth-x=v1', expiresAt: 9e15, authority: `127.0.0.1:${port}`, issuedAt: 0,
    });
    assert.equal(await probeSession(`127.0.0.1:${port}`, deps), 'ok');
  } finally {
    server.close();
  }
  // 无人监听 → down
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const p = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  assert.equal(await probeSession(`127.0.0.1:${p}`, { fetchImpl: fetch, store: memStore() }, 300), 'down');
});

test('parseLaunchTarget：提取 authority 与 token', () => {
  const t = parseLaunchTarget('http://127.0.0.1:3080/?token=ZQpcwOGassFgG-SOxgnI4JSqJp5UmgVUqeo2rZzNYAI');
  assert.deepEqual(t, { authority: '127.0.0.1:3080', token: 'ZQpcwOGassFgG-SOxgnI4JSqJp5UmgVUqeo2rZzNYAI' });
  assert.equal(parseLaunchTarget('http://127.0.0.1:3080/'), null);
  assert.equal(parseLaunchTarget('垃圾'), null);
});
