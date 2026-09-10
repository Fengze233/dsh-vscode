// DSH 0.1.2 鉴权协议最小模拟器（仅本地验证用，不属于扩展产物）
// 复刻 dsh-client-connection 的关键行为：
// - GET /?token=abc 且 Host 匹配 → 303 /after + Set-Cookie（HttpOnly; SameSite=Strict; Path=/）
// - 无有效 cookie 的其他请求 → 401 "dsh web authentication required; ..."
// - 带有效 cookie → 正常 200（回显服务器是否收到 cookie，用于观察浏览器是否回送）
// 监听 127.0.0.1:3939（IPv6/主机名访问会因 Host 不匹配拒绝，模拟 authority 绑定）
import { createServer } from 'node:http';

const PORT = 3939;
const COOKIE_NAME = 'dsh-auth-mock';

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cookie = req.headers.cookie ?? '';
  const hasCookie = cookie.includes(`${COOKIE_NAME}=v1.`);
  const token = url.searchParams.get('token');
  console.log(`[req] ${req.method} ${req.url} host=${req.headers.host} cookie=${hasCookie ? 'YES' : 'no'}`);

  // 首页：iframe 目标（用于导航 token URL → 303 + Set-Cookie）
  if (url.pathname === '/' && req.method === 'GET') {
    if (url.searchParams.has('token')) {
      if (token === 'abc') {
        // 模拟 dsh：合法 token → 303 到干净 /，种 Strict cookie
        res.writeHead(303, {
          'cache-control': 'no-store',
          location: '/after',
          'referrer-policy': 'no-referrer',
          'set-cookie': `${COOKIE_NAME}=v1.mock; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
      return;
    }
    if (hasCookie) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>mock index ok (cookie received)</h1>');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
    return;
  }

  // /after：303 落点，回显服务器是否收到 cookie
  if (url.pathname === '/after') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<h1>after 303</h1><p id="cookiestate">${hasCookie ? 'SERVER SAW COOKIE: YES' : 'SERVER SAW COOKIE: NO'}</p>`);
    return;
  }

  // /top：模拟“宿主页面”的顶层文档（用 localhost 访问以与 127.0.0.1 构成跨站）
  if (url.pathname === '/top') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <h1>top page (localhost:${PORT}) — 模拟 vscode-webview 宿主</h1>
      <iframe id="dsh" src="http://127.0.0.1:${PORT}/?token=abc" width="600" height="400"></iframe>
    </body></html>`);
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`mock listening on http://localhost:${PORT} and http://127.0.0.1:${PORT}`));
