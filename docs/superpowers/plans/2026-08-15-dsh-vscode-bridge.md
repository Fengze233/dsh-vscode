# DSH 页面桥接修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 dsh-vscode-panel v0.1.0 新增 DSH 页面桥接：面板内点击外链在系统浏览器打开、点击文件路径在 VS Code 打开、打开面板自动把 VS Code 工作区同步为 DSH 工作区；桥接失败时优雅降级并弹可关闭警告。

**Architecture:** 三模块：`src/bridge/installer.ts`（Node 侧，把桥接包安装进 `~/.dsh/profiles/web/` 的官方扩展点并管理卸载）、`bridge-client/`（纯 ESM 小包，作为 DSH 官方 client 插件运行在 DSH 网页内，拦截点击并 postMessage、接收工作区同步）、`src/bridge/`（webview 顶层握手/转发 + DSH HTTP API 信封客户端 + 消息处理）。既有 ServiceManager 增加 spawn cwd 兜底。

**Tech Stack:** TypeScript + VS Code Extension API；桥接包为手写纯 ESM JS（无构建）；测试 node:test + esbuild（scripts/build.mjs 自动收集 test/**/*.test.ts）；打包 vsce。

## Global Constraints

- 代码注释必须为完整中文；git 提交信息为中文；提交身份 `Fengze233` / `ni125803@163.com`。
- i18n 规则：VS Code 语言以 `zh-` 开头 → 简体中文，其余一律英文（动态文案走 `src/i18n.ts`，静态文案走 `package.nls.json` / `package.nls.zh-cn.json`）。
- 全平台代码兼容（Windows 本地 / WSL / macOS / Linux）：路径一律 `node:path`，命令名按平台 `dsh` / `dsh.cmd`（沿用 `src/service/process.ts` 模式）。
- 绝不写 DSH 安装目录；只允许写用户目录 `$DSH_HOME`（默认 `~/.dsh`）下 `profiles/web/`。
- 桥接失败必须优雅降级：面板、服务管理、状态栏、占位页、"在浏览器打开"按钮全部照常；仅外链跳转、文件跳转、自动切工作区三类功能不可用。
- 测试后清理残留进程与测试期对 `cordis.patch.yml` 的改动，恢复测试前状态。
- 测试运行方式：`npm test`（build.mjs --test 构建全部 test/*.test.ts → `node --test "out/test/**/*.test.js"`）。
- VS Code engines 保持 `^1.91.0`；扩展名/publisher 不变（`dsh-vscode-panel` / `Fengze233`）。

---

## 文件结构

**新增：**
- `bridge-client/package.json` — 桥接包清单（`dsh.client` 声明 + `./client` 导出）
- `bridge-client/lib/index.js` — host 侧 cordis 空插件（满足注册，无业务）
- `bridge-client/lib/client.js` — 浏览器侧桥接（DOM 事件拦截 + postMessage + 工作区同步 + 握手回执）
- `bridge-client/lib/core.js` — 桥接纯逻辑（协议白名单、消息构造、路径解析），供 node:test 单测
- `src/bridge/installer.ts` — DSH 探测 + 幂等安装/卸载（fs 依赖注入，可单测）
- `src/bridge/api.ts` — DSH HTTP API 信封客户端（workspace.list / workspace.create）
- `src/bridge/host.ts` — 桥接消息处理（openExternal / openFile / 工作区同步编排）
- `src/bridge/status.ts` — 桥接状态评估纯函数
- `test/bridge/installer.test.ts`、`test/bridge/api.test.ts`、`test/bridge/host.test.ts`、`test/bridge/status.test.ts`、`test/bridge/core.test.ts`

**修改：**
- `src/panel/html.ts` — readyPage 注入握手/转发脚本；PanelMessage 联合类型扩展
- `src/panel/provider.ts` — 桥接消息路由
- `src/service/process.ts` — `StartOptions`/spawn 支持 `cwd`
- `src/service/manager.ts` — `ManagerOptions` 增加 `cwd`，透传给 processRunner
- `src/config.ts` — 新增 `bridgeEnabled` / `workspaceRootIndex` / `silenceWarning` 规范化
- `src/extension.ts` — 装配桥接安装、状态评估、警告弹窗、syncWorkspace 触发
- `src/i18n.ts` — 新增文案键
- `package.json` — contributes.configuration 新设置项、版本 0.2.0
- `package.nls.json` / `package.nls.zh-cn.json` — 静态文案
- `test/config.test.ts`、`test/process.test.ts`、`test/html.test.ts` — 增补用例
- `test/vscode-stub.ts` — 按需扩充桩（workspaceFolders 等）

---

### Task 0: 验证 DSH client 插件注册机制（spike，不写生产代码）

**Files:**
- 只操作 `~/.dsh/profiles/web/` 下的临时验证文件，完成后删除；结论记入 `docs/superpowers/specs/2026-08-15-dsh-vscode-bridge-design.md` 第 5.3 节。

**Interfaces:**
- Produces: 三个验证结论，供 Task 1/5/9 使用：
  1. `cordis.patch.yml` 追加条目是否被配置树接受（条目形状）；
  2. `/plugins/<id>/client.js` 是否按 `package.json` 的 `exports["./client"]` 提供、浏览器端脚本是否真实执行；
  3. profile 的 `pnpm-workspace.yaml` 内容（判断 `node_modules/` 是否受 pnpm 管理）。

- [ ] **Step 1: 查看 web profile 的 pnpm-workspace.yaml 与当前 cordis.patch.yml**

```bash
cat ~/.dsh/profiles/web/pnpm-workspace.yaml
cat ~/.dsh/profiles/web/cordis.patch.yml
```

记录内容（判断 node_modules 是否被 pnpm 当作 workspace 包扫描）。

- [ ] **Step 2: 创建最小桥接验证包**

```bash
B=~/.dsh/profiles/web/node_modules/dsh-vscode-bridge
mkdir -p $B/lib
cat > $B/package.json <<'EOF'
{
  "name": "dsh-vscode-bridge",
  "version": "0.0.1",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "dsh": { "client": { "inject": [], "platform": "web" } },
  "license": "MIT"
}
EOF
cat > $B/lib/index.js <<'EOF'
// host 侧空插件：仅用于配置树注册，无业务
import { Service } from "@deepseek-ai/cordis";
export const name = "dsh-vscode-bridge";
export default class extends Service {
  constructor(ctx) { super(ctx, name); }
}
EOF
cat > $B/lib/client.js <<'EOF'
// 验证用客户端脚本：标记执行结果
window.__dshVscodeBridgeSpike = true;
console.log("[dsh-vscode-bridge spike] client.js executed");
EOF
```

- [ ] **Step 3: 备份并追加 cordis.patch.yml 条目**

```bash
cp ~/.dsh/profiles/web/cordis.patch.yml /tmp/cordis.patch.yml.bak
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'
# dsh-vscode-bridge: begin
- id: dsh-vscode-bridge
  name: dsh-vscode-bridge
# dsh-vscode-bridge: end
EOF
cat ~/.dsh/profiles/web/cordis.patch.yml
```

- [ ] **Step 4: 验证配置树接受条目**

```bash
cd /tmp && dsh --profile web --dump-config 2>&1 | grep -A3 'dsh-vscode-bridge'
```

Expected: 输出中出现 `- id: dsh-vscode-bridge` 且无报错。若报错：记录错误信息，尝试去掉 `# dsh-vscode-bridge: begin` 注释行后重试（确认 patch 数组是否支持注释），把可用形状记入结论。

- [ ] **Step 5: 重启服务并验证浏览器端执行**

停掉插件自启的服务（在 VS Code 面板执行停止，或 `kill` 该 dsh web 进程）→ 重新打开 VS Code 面板触发自启 → 用浏览器打开 `http://127.0.0.1:3080/`：

```bash
curl -s http://127.0.0.1:3080/ | grep -o 'dsh-vscode-bridge[^"]*'
curl -si http://127.0.0.1:3080/plugins/dsh-vscode-bridge/client.js | head -5
```

再用浏览器实际打开首页，在 DevTools Console 执行 `window.__dshVscodeBridgeSpike`：
Expected: `true`（client.js 被真实执行）。若 `/plugins/...` 404 或标记为 undefined：记录首页 `__DSH_BOOT__.entries` 中该条目形状与报错，调整注册方式（例如在 package.json 补 `"dsh": {"client": {"inject": ["@deepseek-ai/dsh-client-runtime"]}}`）后重试。

- [ ] **Step 6: 清理并记录结论**

```bash
rm -rf ~/.dsh/profiles/web/node_modules/dsh-vscode-bridge
mv /tmp/cordis.patch.yml.bak ~/.dsh/profiles/web/cordis.patch.yml
```

把三条结论（含最终可用形状的完整文件内容样例）追加到设计文档第 5.3 节，并 commit：

```bash
git add docs/superpowers/specs/2026-08-15-dsh-vscode-bridge-design.md
git commit -m "docs: 记录 DSH 客户端插件注册机制验证结论"
```

---

### Task 1: 桥接客户端包 bridge-client（纯逻辑 core.js 先行）

**Files:**
- Create: `bridge-client/package.json`、`bridge-client/lib/index.js`、`bridge-client/lib/client.js`、`bridge-client/lib/core.js`
- Test: `test/bridge/core.test.ts`

**Interfaces:**
- Produces（core.js，node 环境可直接 import）：
  - `isAllowedExternalUrl(url: string): boolean` — 仅 `http:`/`https:` 且非空返回 true
  - `buildOpenExternalMessage(url: string): { kind: 'openExternal'; url: string }`
  - `buildOpenFileMessage(path: string, cwd: string | undefined): { kind: 'openFile'; path: string; cwd?: string }`
  - `buildSyncWorkspaceAck(ok: boolean, path?: string): { kind: 'bridgeAck'; ok: boolean; path?: string }`
  - `isBridgeMessage(data: unknown, token: string): boolean` — 校验 `data.token === token`
  - `WORKSPACE_MESSAGE_KIND = 'syncWorkspace'`、`HANDSHAKE_TOKEN_KEY = 'token'`（桥接消息字段名，握手/同步消息一律用 `token` 字段承载）
- Consumes: Task 0 的注册形状结论（package.json 的 dsh.client 字段）。

- [ ] **Step 1: 写失败测试**

`test/bridge/core.test.ts`：

```ts
// test/bridge/core.test.ts — 桥接纯逻辑单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedExternalUrl,
  buildOpenExternalMessage,
  buildOpenFileMessage,
  isBridgeMessage,
} from '../../bridge-client/lib/core.js';

test('isAllowedExternalUrl 仅放行 http/https', () => {
  assert.equal(isAllowedExternalUrl('https://example.com/a'), true);
  assert.equal(isAllowedExternalUrl('http://127.0.0.1:3080/x'), true);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedExternalUrl(''), false);
});

test('buildOpenExternalMessage 构造消息', () => {
  assert.deepEqual(buildOpenExternalMessage('https://a.b/c'), { kind: 'openExternal', url: 'https://a.b/c' });
});

test('buildOpenFileMessage 携带可选 cwd', () => {
  assert.deepEqual(buildOpenFileMessage('src/main.ts', '/proj'), { kind: 'openFile', path: 'src/main.ts', cwd: '/proj' });
  assert.deepEqual(buildOpenFileMessage('/abs/a.ts', undefined), { kind: 'openFile', path: '/abs/a.ts' });
});

test('isBridgeMessage 校验 token', () => {
  assert.equal(isBridgeMessage({ token: 't1' }, 't1'), true);
  assert.equal(isBridgeMessage({ token: 't2' }, 't1'), false);
  assert.equal(isBridgeMessage(null, 't1'), false);
});
```

注意：esbuild 测试收集基于 `test/**/*.test.ts`，本文件 import 的是 `.js` 后缀 ESM 源文件——esbuild bundle 会把它打包进测试产物，`node --test` 产物为 CJS 亦可运行；若运行时报 ESM 加载错误，改 import 路径为 `../../bridge-client/lib/core` 并在 core.js 顶部写 `// @ts-nocheck`（无 TS 类型时）。实际以 `npm test` 运行为准。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在 / 函数未定义）

- [ ] **Step 3: 实现 core.js**

`bridge-client/lib/core.js`（完整中文注释）：

```js
// bridge-client/lib/core.js — 桥接纯逻辑（无 DOM，可在 node 环境单测）
// 外链协议白名单：只允许 http/https，杜绝 javascript:/file: 等危险协议
export function isAllowedExternalUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

// 构造"打开外链"消息
export function buildOpenExternalMessage(url) {
  return { kind: 'openExternal', url };
}

// 构造"打开文件"消息（cwd 为会话工作目录，可选）
export function buildOpenFileMessage(path, cwd) {
  return cwd === undefined ? { kind: 'openFile', path } : { kind: 'openFile', path, cwd };
}

// 校验来自父页面的消息 token（握手防伪）
export function isBridgeMessage(data, token) {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof data.token === 'string' &&
    data.token === token &&
    data.token !== ''
  );
}

// 工作区同步消息类型（父页面 → iframe）
export const WORKSPACE_MESSAGE_KIND = 'syncWorkspace';
// 握手 token 字段名（父页面发来的消息里携带）
export const HANDSHAKE_TOKEN_KEY = 'token';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS（新增 4 条）

- [ ] **Step 5: 实现 package.json 与 index.js**

`bridge-client/package.json`（dsh.client 形状以 Task 0 结论为准，inject 若验证需要 client-runtime 则填 `["@deepseek-ai/dsh-client-runtime"]`）：

```json
{
  "name": "dsh-vscode-bridge",
  "version": "0.2.0",
  "description": "VS Code panel bridge for DeepSeek Harness (installed by the dsh-vscode-panel extension)",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": { "client": { "inject": [], "platform": "web" } },
  "license": "MIT"
}
```

`bridge-client/lib/index.js`：

```js
// bridge-client/lib/index.js — host 侧空插件：满足配置树注册即可，业务全在 client.js
import { Service } from "@deepseek-ai/cordis";
export const name = "dsh-vscode-bridge";
export default class extends Service {
  constructor(ctx) { super(ctx, name); }
}
```

- [ ] **Step 6: 提交**

```bash
git add bridge-client/ test/bridge/core.test.ts
git commit -m "feat: 新增桥接客户端包与核心纯逻辑（协议白名单/消息构造）"
```

---

### Task 2: 桥接安装器 installer.ts

**Files:**
- Create: `src/bridge/installer.ts`
- Test: `test/bridge/installer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BridgeInstallOptions {
    dshHome: string;            // $DSH_HOME 或 ~/.dsh
    bridgeSourceDir: string;    // 插件随附 bridge-client 目录绝对路径
    fs: InstallerFs;            // 注入的 fs 子集
  }
  export interface InstallerFs {
    exists(p: string): boolean;
    readFile(p: string): string;
    writeFile(p: string, content: string): void;
    mkdir(p: string): void;
    copyDir(src: string, dest: string): void;
    rmDir(p: string): void;
    readdir(p: string): string[];
  }
  export type BridgeInstallStatus = 'ok' | 'pending-restart' | 'degraded';
  export interface BridgeInstallResult {
    status: BridgeInstallStatus;
    reason?: string;   // degraded 时的原因（英文短句，日志用）
    profileDir?: string;
    bridgeDir?: string; // 安装目标目录（profile node_modules/dsh-vscode-bridge）
  }
  export function detectProfileDir(dshHome: string, fs: InstallerFs): string | null; // 返回 profiles/web 路径
  export function installBridge(opts: BridgeInstallOptions): BridgeInstallResult;    // 幂等
  export function uninstallBridge(opts: BridgeInstallOptions): void;                 // 按标记清理并还原
  export const BRIDGE_BEGIN_MARK = '# dsh-vscode-bridge: begin';
  export const BRIDGE_END_MARK = '# dsh-vscode-bridge: end';
  ```

- [ ] **Step 1: 写失败测试**

`test/bridge/installer.test.ts` 用内存对象实现 `InstallerFs`（`makeMemFs()` 帮助函数：Map<path,string> 存文件、Set 存目录），覆盖：

```ts
// test/bridge/installer.test.ts — 桥接安装器单测（内存 fs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBridge, uninstallBridge, detectProfileDir, BRIDGE_BEGIN_MARK, BRIDGE_END_MARK, type InstallerFs } from '../src/bridge/installer';

// 内存 fs：files 是路径→内容，dirs 是目录集合
function makeMemFs(init: Record<string, string> = {}): InstallerFs {
  const files = new Map(Object.entries(init));
  const dirs = new Set<string>();
  return {
    exists: (p) => files.has(p) || dirs.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error(`no such file: ${p}`); return v; },
    writeFile: (p, c) => { files.set(p, c); },
    mkdir: (p) => { dirs.add(p); },
    copyDir: (src, dest) => { dirs.add(dest); files.set(`${dest}/package.json`, `{"copied":"${src}"}`); },
    rmDir: (p) => { dirs.delete(p); },
    readdir: () => [],
  };
}

test('detectProfileDir 返回 profiles/web 路径', () => {
  const fs = makeMemFs();
  fs.mkdir('/home/u/.dsh/profiles/web');
  assert.equal(detectProfileDir('/home/u/.dsh', fs), '/home/u/.dsh/profiles/web');
  assert.equal(detectProfileDir('/home/u/.dsh2', fs), null);
});

test('installBridge 幂等：第二次安装不重复追加条目', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const fs = makeMemFs({ [patchPath]: '# 用户自己的内容\n- id: user-plugin\n  name: user-plugin\n' });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  const r1 = installBridge(opts);
  const after1 = fs.readFile(patchPath);
  const r2 = installBridge(opts);
  assert.equal(r1.status, 'ok');
  assert.equal(r2.status, 'ok');
  assert.equal(fs.readFile(patchPath), after1); // 幂等
  assert.ok(after1.includes(BRIDGE_BEGIN_MARK));
  assert.ok(after1.includes('- id: dsh-vscode-bridge'));
  assert.ok(after1.includes('# 用户自己的内容')); // 不覆盖用户内容
});

test('uninstallBridge 还原用户内容并删除桥接目录', () => {
  const profile = '/home/u/.dsh/profiles/web';
  const patchPath = `${profile}/cordis.patch.yml`;
  const original = '# 用户自己的内容\n';
  const fs = makeMemFs({ [patchPath]: original });
  fs.mkdir(profile);
  const opts = { dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs };
  installBridge(opts);
  uninstallBridge(opts);
  assert.equal(fs.readFile(patchPath), original);
  assert.equal(fs.exists(`${profile}/node_modules/dsh-vscode-bridge`), false);
});

test('profile 目录缺失时返回 degraded 并带原因', () => {
  const fs = makeMemFs({});
  const r = installBridge({ dshHome: '/home/u/.dsh', bridgeSourceDir: '/ext/bridge-client', fs });
  assert.equal(r.status, 'degraded');
  assert.ok(r.reason);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 installer.ts**

关键实现（完整中文注释；所有 fs 操作走注入的 `opts.fs`；`patch 追加` 用 `\n${BRIDGE_BEGIN_MARK}\n- id: dsh-vscode-bridge\n  name: dsh-vscode-bridge\n${BRIDGE_END_MARK}\n`；`卸载` 用字符串定位 begin/end 标记段删除，文件其余内容原样保留；`copyDir` 由注入实现负责递归复制——生产注入用 Node `fs.cpSync(recursive)` 封装）：

```ts
// src/bridge/installer.ts — DSH 桥接包的探测与幂等安装/卸载
// 只写用户目录（$DSH_HOME/profiles/web），绝不触碰 DSH 安装目录。
import { join } from 'node:path';

/** 桥接条目在 cordis.patch.yml 中的包裹标记（卸载时按标记精确删除） */
export const BRIDGE_BEGIN_MARK = '# dsh-vscode-bridge: begin';
export const BRIDGE_END_MARK = '# dsh-vscode-bridge: end';
/** 桥接包在 profile node_modules 下的目录名 */
export const BRIDGE_PACKAGE_NAME = 'dsh-vscode-bridge';

/** 注入的 fs 子集（生产用 Node fs 封装，测试用内存实现） */
export interface InstallerFs { /* 见 Interfaces */ }
export type BridgeInstallStatus = 'ok' | 'pending-restart' | 'degraded';
export interface BridgeInstallResult { /* 见 Interfaces */ }
export interface BridgeInstallOptions { /* 见 Interfaces */ }

/** 定位 web profile 目录：dshHome/profiles/web，不存在返回 null */
export function detectProfileDir(dshHome: string, fs: InstallerFs): string | null {
  const dir = join(dshHome, 'profiles', 'web');
  return fs.exists(dir) ? dir : null;
}

/** 幂等安装：已装（条目存在）→ ok；profile 缺失 → degraded */
export function installBridge(opts: BridgeInstallOptions): BridgeInstallResult {
  const profileDir = detectProfileDir(opts.dshHome, opts.fs);
  if (profileDir === null) {
    return { status: 'degraded', reason: 'web profile not found' };
  }
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const patch = opts.fs.readFile(patchPath);
  const bridgeDir = join(profileDir, 'node_modules', BRIDGE_PACKAGE_NAME);
  if (patch.includes(BRIDGE_BEGIN_MARK)) {
    // 已安装：幂等返回（目录可能被 pnpm 清理，顺手补回）
    if (!opts.fs.exists(bridgeDir)) opts.fs.copyDir(opts.bridgeSourceDir, bridgeDir);
    return { status: 'ok', profileDir, bridgeDir };
  }
  const entry = `${BRIDGE_BEGIN_MARK}\n- id: ${BRIDGE_PACKAGE_NAME}\n  name: ${BRIDGE_PACKAGE_NAME}\n${BRIDGE_END_MARK}`;
  opts.fs.writeFile(patchPath, `${patch.trimEnd()}\n${entry}\n`);
  opts.fs.copyDir(opts.bridgeSourceDir, bridgeDir);
  return { status: 'ok', profileDir, bridgeDir };
}

/** 卸载：删除带标记条目段（其余内容原样保留）+ 删除桥接目录 */
export function uninstallBridge(opts: BridgeInstallOptions): void {
  const profileDir = detectProfileDir(opts.dshHome, opts.fs);
  if (profileDir === null) return;
  const patchPath = join(profileDir, 'cordis.patch.yml');
  if (!opts.fs.exists(patchPath)) return;
  const patch = opts.fs.readFile(patchPath);
  const begin = patch.indexOf(BRIDGE_BEGIN_MARK);
  const end = patch.indexOf(BRIDGE_END_MARK);
  if (begin === -1 || end === -1) return;
  // 删除 begin 行到 end 行（含两个标记行），并吃掉后随的换行
  const restored = patch.slice(0, begin) + patch.slice(end + BRIDGE_END_MARK.length + 1);
  opts.fs.writeFile(patchPath, restored.trimEnd() + '\n');
  const bridgeDir = join(profileDir, 'node_modules', BRIDGE_PACKAGE_NAME);
  if (opts.fs.exists(bridgeDir)) opts.fs.rmDir(bridgeDir);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS（含 Task 1 的 4 条）

- [ ] **Step 5: 提交**

```bash
git add src/bridge/installer.ts test/bridge/installer.test.ts
git commit -m "feat: 桥接安装器（探测/幂等安装/标记卸载）"
```

---

### Task 3: DSH HTTP API 信封客户端 api.ts

**Files:**
- Create: `src/bridge/api.ts`
- Test: `test/bridge/api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WorkspaceItem { workspaceId: string; path: string; title?: string; sessionIds?: string[] }
  export interface DshApiClient {
    workspaceList(): Promise<WorkspaceItem[]>;
    workspaceCreate(path: string): Promise<WorkspaceItem>;
  }
  export function createDshApiClient(baseUrl: string, fetchImpl?: typeof fetch): DshApiClient;
  export function buildRequest(rpcId: string, method: string, payload: unknown): object;
  // 响应形状：{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
  ```

- [ ] **Step 1: 写失败测试**

`test/bridge/api.test.ts`（fake fetch 按 URL 与请求体返回预设响应）：

```ts
// test/bridge/api.test.ts — DSH API 信封客户端单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshApiClient, buildRequest } from '../src/bridge/api';

test('buildRequest 构造信封', () => {
  assert.deepEqual(buildRequest('r1', 'workspace.list', {}), {
    type: 'client-request', rpcId: 'r1', method: 'workspace.list', payload: {},
  });
});

test('workspaceList 解析 value.items', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    type: 'server-response', rpcId: 'r1',
    result: { ok: true, value: { items: [{ workspaceId: 'w1', path: '/proj', title: 'proj' }] } },
  }), { status: 200 });
  const api = createDshApiClient('http://127.0.0.1:3080', fetchImpl as unknown as typeof fetch);
  const items = await api.workspaceList();
  assert.deepEqual(items, [{ workspaceId: 'w1', path: '/proj', title: 'proj' }]);
});

test('workspaceCreate 发送 path 并解析响应', async () => {
  let capturedBody: unknown;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      type: 'server-response', rpcId: 'r1',
      result: { ok: true, value: { workspaceId: 'w2', path: '/proj2' } },
    }), { status: 200 });
  };
  const api = createDshApiClient('http://127.0.0.1:3080', fetchImpl as unknown as typeof fetch);
  const ws = await api.workspaceCreate('/proj2');
  assert.equal(ws.workspaceId, 'w2');
  assert.deepEqual((capturedBody as { method: string; payload: { path: string } }).method, 'workspace.create');
  assert.equal((capturedBody as { payload: { path: string } }).payload.path, '/proj2');
});

test('ok:false 时抛错并携带 code', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    type: 'server-response', rpcId: 'r1',
    result: { ok: false, error: { code: 'workspace-not-found', message: 'x' } },
  }), { status: 200 });
  const api = createDshApiClient('http://127.0.0.1:3080', fetchImpl as unknown as typeof fetch);
  await assert.rejects(() => api.workspaceList(), /workspace-not-found/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现 api.ts**

```ts
// src/bridge/api.ts — DSH HTTP API 信封客户端（实测：Node 直连不受浏览器信任栅栏限制）
// 信封：请求 {type:'client-request', rpcId, method, payload}
//       响应 {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
export interface WorkspaceItem { workspaceId: string; path: string; title?: string; sessionIds?: string[] }

export interface DshApiClient {
  workspaceList(): Promise<WorkspaceItem[]>;
  workspaceCreate(path: string): Promise<WorkspaceItem>;
}

export function buildRequest(rpcId: string, method: string, payload: unknown): object {
  return { type: 'client-request', rpcId, method, payload };
}

/** 发一次信封请求并解包 result（ok:false 或协议异常一律抛错） */
async function call(baseUrl: string, fetchImpl: typeof fetch, method: string, payload: unknown): Promise<unknown> {
  const rpcId = `dsh-vscode-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify(buildRequest(rpcId, method, payload));
  const res = await fetchImpl(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const json = (await res.json()) as {
    result?: { ok: boolean; value?: unknown; error?: { code?: string; message?: string } };
  };
  const result = json?.result;
  if (result === undefined || !result.ok) {
    const code = result?.error?.code ?? 'http-error';
    const message = result?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`dsh api ${method} failed: ${code}: ${message}`);
  }
  return result.value;
}

export function createDshApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): DshApiClient {
  return {
    async workspaceList(): Promise<WorkspaceItem[]> {
      const value = (await call(baseUrl, fetchImpl, 'workspace.list', {})) as { items?: WorkspaceItem[] };
      return value?.items ?? [];
    },
    async workspaceCreate(path: string): Promise<WorkspaceItem> {
      const value = (await call(baseUrl, fetchImpl, 'workspace.create', { path })) as WorkspaceItem;
      return value;
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/bridge/api.ts test/bridge/api.test.ts
git commit -m "feat: DSH HTTP API 信封客户端（workspace 列表/创建）"
```

---

### Task 4: webview 握手与消息路由（html.ts + provider.ts + host.ts 的跳转处理）

**Files:**
- Modify: `src/panel/html.ts`（PanelMessage 扩展、readyPage 握手脚本）、`src/panel/provider.ts`（消息路由）、`src/bridge/host.ts`（新建，先实现跳转处理）、`test/html.test.ts`（增补）、`test/bridge/host.test.ts`（新建）

**Interfaces:**
- PanelMessage 扩展：
  ```ts
  | { type: 'bridgeOpenExternal'; url: string }
  | { type: 'bridgeOpenFile'; path: string; cwd?: string }
  | { type: 'bridgeAck'; ok: boolean }
  ```
- `readyPage(url, ctx, bridge?: { token: string; enabled: boolean })` — 第三参可选，向后兼容既有调用
- host.ts Produces:
  ```ts
  export function resolveBridgePath(raw: string, sessionCwd: string | undefined, workspaceRoot: string | undefined): { kind: 'abs'; path: string } | { kind: 'invalid' };
  export async function handleBridgeMessage(msg: PanelMessage, deps: { openExternal: (u: string) => Thenable<boolean>; openTextDocument: (p: string) => Thenable<void>; workspaceRoot?: string }): Promise<void>;
  ```

- [ ] **Step 1: 写失败测试（host 路径解析 + html 握手脚本）**

`test/bridge/host.test.ts`：

```ts
// test/bridge/host.test.ts — 桥接消息处理与路径解析单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBridgePath, handleBridgeMessage } from '../src/bridge/host';

test('resolveBridgePath 处理绝对/相对/危险协议', () => {
  assert.deepEqual(resolveBridgePath('/a/b.ts', undefined, '/proj'), { kind: 'abs', path: '/a/b.ts' });
  assert.deepEqual(resolveBridgePath('src/main.ts', '/proj', '/other'), { kind: 'abs', path: '/proj/src/main.ts' });
  assert.deepEqual(resolveBridgePath('src/main.ts', undefined, '/proj'), { kind: 'abs', path: '/proj/src/main.ts' });
  assert.deepEqual(resolveBridgePath('..\\evil.ts', undefined, undefined), { kind: 'invalid' });
  assert.deepEqual(resolveBridgePath('https://x.com/a', undefined, '/proj'), { kind: 'invalid' });
});

test('handleBridgeMessage 转发 openExternal 到外部浏览器', async () => {
  const calls: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'https://a.b' }, {
    openExternal: async (u) => { calls.push(u); return true; },
    openTextDocument: async () => {},
  });
  assert.deepEqual(calls, ['https://a.b']);
});

test('handleBridgeMessage 拒绝危险协议的 openExternal', async () => {
  let called = false;
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'javascript:alert(1)' }, {
    openExternal: async () => { called = true; return true; },
    openTextDocument: async () => {},
  });
  assert.equal(called, false);
});

test('handleBridgeMessage openFile 调用打开文档', async () => {
  const opened: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'src/main.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { opened.push(p); },
    workspaceRoot: '/proj',
  });
  assert.deepEqual(opened, ['/proj/src/main.ts']);
});
```

`test/html.test.ts` 增补：

```ts
test('readyPage 启用桥接时注入握手脚本', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  assert.ok(html.includes('dsh-bridge-handshake'));
  assert.ok(html.includes('tok123'));
});

test('readyPage 未启用桥接时不注入握手脚本', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(!html.includes('dsh-bridge-handshake'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现 resolveBridgePath 与 handleBridgeMessage（host.ts）**

```ts
// src/bridge/host.ts — 桥接消息处理：外链打开 / 文件跳转（工作区同步编排见 Task 5）
import * as vscode from 'vscode';
import { isAbsolute, resolve, isPathAbsolute } from 'node:path';
import type { PanelMessage } from '../panel/html';

/** 桥接消息处理依赖（生产接 vscode API，测试注入假实现） */
export interface BridgeMessageDeps {
  openExternal(url: string): Thenable<boolean>;
  openTextDocument(path: string): Thenable<void>;
  workspaceRoot?: string;
}

/** 解析文件路径：绝对路径直接用；相对路径依次按 会话cwd → 工作区根 解析 */
export function resolveBridgePath(raw: string, sessionCwd: string | undefined, workspaceRoot: string | undefined):
  { kind: 'abs'; path: string } | { kind: 'invalid' } {
  // 路径形似 URL 一律拒绝（协议串）
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) return { kind: 'invalid' };
  if (isAbsolute(raw)) return { kind: 'abs', path: raw };
  const base = sessionCwd ?? workspaceRoot;
  if (base === undefined) return { kind: 'invalid' };
  return { kind: 'abs', path: resolve(base, raw) };
}

export async function handleBridgeMessage(msg: PanelMessage, deps: BridgeMessageDeps): Promise<void> {
  if (msg.type === 'bridgeOpenExternal') {
    // 协议白名单：仅 http/https（与桥接侧白名单双重校验，纵深防御）
    if (/^https?:\/\//i.test(msg.url)) await deps.openExternal(msg.url);
    return;
  }
  if (msg.type === 'bridgeOpenFile') {
    const r = resolveBridgePath(msg.path, msg.cwd, deps.workspaceRoot);
    if (r.kind === 'abs') await deps.openTextDocument(r.path);
    else void vscode.window.showWarningMessage(`无法解析路径：${msg.path}`);
    return;
  }
}
```

（`import { isPathAbsolute } from 'node:path'` 不存在则删除该导入，只保留 `isAbsolute/resolve`；TS 编译以 `npm run typecheck` 为准。）

- [ ] **Step 4: 修改 html.ts（PanelMessage + readyPage 握手脚本）**

PanelMessage 联合类型加入三条；`readyPage` 签名改为 `(url: string, ctx: PageCtx, bridge?: { token: string; enabled: boolean })`，HTML 部分：

```ts
const BRIDGE_HANDSHAKE_SCRIPT = (token: string) => `
// DSH 页面桥接握手：向 iframe 发 hello，收 bridgeAck 回执；转发 iframe 的上行消息给扩展
window.addEventListener('message', (e) => {
  if (e.source !== iframeEl.contentWindow) return;
  const d = e.data;
  if (d && d.kind === 'bridgeAck') { vscode.postMessage({ type: 'bridgeAck', ok: d.ok === true }); return; }
  if (d && d.kind === 'openExternal' && typeof d.url === 'string') { vscode.postMessage({ type: 'bridgeOpenExternal', url: d.url }); return; }
  if (d && d.kind === 'openFile' && typeof d.path === 'string') {
    vscode.postMessage({ type: 'bridgeOpenFile', path: d.path, cwd: typeof d.cwd === 'string' ? d.cwd : undefined });
  }
});
iframeEl.addEventListener('load', () => {
  iframeEl.contentWindow.postMessage({ kind: 'bridgeHello', token: '${token}' }, iframeSrc);
});
`;
```

`readyPage` 内把 iframe 元素赋给 `iframeEl`、地址赋给 `iframeSrc`（脚本放 `BUTTON_SCRIPT` 之后、`</body>` 前，共用同一 nonce）。CSP 不变（`script-src 'nonce-...'` 已覆盖）。

- [ ] **Step 5: 修改 provider.ts 路由**

在 `onMessage` switch 增：

```ts
case 'bridgeOpenExternal':
  void handleBridgeMessage(msg, {
    openExternal: (u) => vscode.env.openExternal(vscode.Uri.parse(u)),
    openTextDocument: (p) => vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false }),
    workspaceRoot: this.workspaceRoot(), // 见 Task 5 的 resolveWorkspaceRoot 结果
  });
  break;
case 'bridgeOpenFile':
  // 与上同一条处理（handleBridgeMessage 内部分流），可合并为一个 case 列表
case 'bridgeAck':
  this.onBridgeAck?.(msg.ok);
  break;
```

provider 构造器新增可选回调 `onBridgeAck?: (ok: boolean) => void` 与 `workspaceRoot: () => string | undefined`（由 extension.ts 注入，Task 5/7 使用）。

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS、类型检查通过

- [ ] **Step 7: 提交**

```bash
git add src/bridge/host.ts src/panel/html.ts src/panel/provider.ts test/bridge/host.test.ts test/html.test.ts
git commit -m "feat: webview 握手脚本与桥接消息路由（外链/文件跳转）"
```

---

### Task 5: 工作区自动同步（扩展编排 + 桥接侧接收）

**Files:**
- Modify: `src/bridge/host.ts`（syncWorkspace 编排）、`src/extension.ts`（触发装配）、`src/panel/provider.ts`（转发下行 syncWorkspace 消息）、`bridge-client/lib/client.js`（实现 DOM 逻辑 + 接收同步）、`src/bridge/sync.ts`（新建：resolveWorkspaceRoot 纯函数 + 编排）
- Test: `test/bridge/sync.test.ts`（新建）、`test/bridge/core.test.ts`（增补 cwd 同步相关纯逻辑）

**Interfaces:**
- sync.ts Produces:
  ```ts
  export function resolveWorkspaceRoot(folders: readonly { uri: { fsPath: string } }[], index: number): string | undefined;
  export async function syncWorkspace(api: DshApiClient, workspaceRoot: string): Promise<WorkspaceItem>; // 幂等：list 命中复用，否则 create
  ```
- client.js 桥接行为：收到父页面 `{kind:'syncWorkspace', path, token}` 且 token 校验通过 → 通过桥接包持有的 DSH client API 创建/复用 workspace 并触发前端选中（Task 0 已验证的具体调用形状）；若 Task 0 结论为"无法触发选中"，改用兜底：包装 `window.fetch`，对 `POST /api/session.create` 请求体（信封）在无 `cwd`/`workspaceId` 时注入 `cwd: path`。

- [ ] **Step 1: 写失败测试（resolveWorkspaceRoot + syncWorkspace 编排）**

`test/bridge/sync.test.ts`：

```ts
// test/bridge/sync.test.ts — 工作区同步编排单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspaceRoot, syncWorkspace } from '../src/bridge/sync';
import type { DshApiClient } from '../src/bridge/api';

test('resolveWorkspaceRoot 按索引取根', () => {
  const folders = [{ uri: { fsPath: '/a' } }, { uri: { fsPath: '/b' } }];
  assert.equal(resolveWorkspaceRoot(folders, 0), '/a');
  assert.equal(resolveWorkspaceRoot(folders, 1), '/b');
  assert.equal(resolveWorkspaceRoot(folders, 5), '/a'); // 越界回退第一个
  assert.equal(resolveWorkspaceRoot([], 0), undefined);
});

test('syncWorkspace 命中已有 workspace 时复用不创建', async () => {
  const calls: string[] = [];
  const api: DshApiClient = {
    workspaceList: async () => [{ workspaceId: 'w1', path: '/proj' }],
    workspaceCreate: async (p) => { calls.push(p); return { workspaceId: 'w2', path: p }; },
  };
  const ws = await syncWorkspace(api, '/proj');
  assert.equal(ws.workspaceId, 'w1');
  assert.deepEqual(calls, []);
});

test('syncWorkspace 未命中时创建', async () => {
  const api: DshApiClient = {
    workspaceList: async () => [],
    workspaceCreate: async (p) => ({ workspaceId: 'w2', path: p }),
  };
  const ws = await syncWorkspace(api, '/proj');
  assert.equal(ws.workspaceId, 'w2');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现 src/bridge/sync.ts**

```ts
// src/bridge/sync.ts — VS Code 工作区与 DSH workspace 的同步（纯编排，可单测）
import type { DshApiClient, WorkspaceItem } from './api';

/** 多根工作区按索引取根；越界/空回退第一个；无工作区返回 undefined */
export function resolveWorkspaceRoot(
  folders: readonly { uri: { fsPath: string } }[],
  index: number,
): string | undefined {
  if (folders.length === 0) return undefined;
  const f = folders[index] ?? folders[0];
  return f.uri.fsPath;
}

/** 幂等同步：list 命中（path 相同）复用，否则 create */
export async function syncWorkspace(api: DshApiClient, workspaceRoot: string): Promise<WorkspaceItem> {
  const items = await api.workspaceList();
  const hit = items.find((w) => w.path === workspaceRoot);
  if (hit !== undefined) return hit;
  return api.workspaceCreate(workspaceRoot);
}
```

- [ ] **Step 4: 实现 bridge-client/lib/client.js（DOM 桥接 + 工作区接收）**

结构（完整中文注释；Task 0 结论决定"选中触发"段的具体 API，若验证未果采用 fetch 拦截兜底，两者都实现、运行时按能力切换）：

```js
// bridge-client/lib/client.js — DSH 页面内的桥接（浏览器环境）
import { isAllowedExternalUrl, buildOpenExternalMessage, buildOpenFileMessage, isBridgeMessage } from './core.js';

// —— 状态 ——
let bridgeToken = '';            // 握手 token（父页面下发）
let sessionCwd = undefined;      // 当前会话 cwd（从 DSH UI 状态或兜底记录）

// —— 入口：立即绑定，等待父页面握手 ——
function bindLinkInterception() {
  document.addEventListener('click', (e) => {
    if (bridgeToken === '') return; // 未握手（普通浏览器打开）不激活
    const anchor = e.target && e.target.closest ? e.target.closest('a') : null;
    if (anchor && isAllowedExternalUrl(anchor.href)) {
      e.preventDefault();
      e.stopPropagation();
      parent.postMessage(buildOpenExternalMessage(anchor.href), '*');
      return;
    }
    // 文件路径按钮（DSH fileMention 渲染为 button.fileMention）
    const btn = e.target && e.target.closest ? e.target.closest('button[title], button[aria-label]') : null;
    if (btn && btn.classList && btn.classList.contains('fileMention')) {
      e.preventDefault();
      e.stopPropagation();
      const label = btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '';
      parent.postMessage(buildOpenFileMessage(label, sessionCwd), '*');
    }
  }, true); // 捕获阶段：先于 DSH 自身处理器
}

function onParentMessage(e) {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.kind === 'bridgeHello' && isBridgeMessage(d, d.token) === false) return;
  if (d.kind === 'bridgeHello') {
    bridgeToken = d.token;
    parent.postMessage({ kind: 'bridgeAck', ok: true, token: bridgeToken }, '*');
    return;
  }
  if (!isBridgeMessage(d, bridgeToken)) return;
  if (d.kind === 'syncWorkspace' && typeof d.path === 'string') {
    void syncWorkspaceFromParent(d.path);
  }
}

// —— 工作区同步：Task 0 验证的"选中"路径；不可用时走 fetch 拦截兜底 ——
async function syncWorkspaceFromParent(path) {
  // 方式 A（Task 0 结论支持时）：调用 DSH 前端 runtime 的 workspace API 并触发选中
  // 方式 B（兜底）：拦截 session.create 信封注入 cwd（服务端已实证接受 cwd 字段）
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    try {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/api/session.create') && init && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body && body.method === 'session.create' && body.payload && body.payload.cwd === undefined && body.payload.workspaceId === undefined) {
          body.payload.cwd = path;
          init = { ...init, body: JSON.stringify(body) };
        }
      }
    } catch { /* 非 JSON 请求体忽略 */ }
    return originalFetch(input, init);
  };
  sessionCwd = path;
}

bindLinkInterception();
window.addEventListener('message', onParentMessage);
```

（`sessionCwd` 的实时来源：Task 0 若能取到 DSH 会话 store，则订阅其变化；否则保持 fetch 兜底写入的值。）

- [ ] **Step 5: extension.ts 装配 sync 流程**

在 `activate` 里 provider 注入 `workspaceRoot: () => resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], config.workspaceRootIndex)`；manager 就绪后（onChange state==='ready' 首次）触发一次：

```ts
let syncedOnce = false;
manager.onChange((s) => {
  if (s.state === 'ready' && !syncedOnce) {
    syncedOnce = true;
    void syncOnce();
  }
});
async function syncOnce(): Promise<void> {
  const root = resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], readConfig().config.workspaceRootIndex);
  if (root === undefined) return;
  try {
    await syncWorkspace(createDshApiClient(manager!.getSnapshot().url!), root);
  } catch (err) { /* 同步失败只记日志，不打断面板 */ output?.appendLine(`[bridge] sync workspace failed: ${String(err)}`); }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS、类型检查通过

- [ ] **Step 7: 提交**

```bash
git add src/bridge/sync.ts src/bridge/host.ts src/extension.ts src/panel/provider.ts bridge-client/lib/client.js test/bridge/sync.test.ts
git commit -m "feat: 工作区自动同步（list 复用/create + 桥接接收与兜底注入）"
```

---

### Task 6: spawn cwd 兜底 + 新设置项

**Files:**
- Modify: `src/service/process.ts`、`src/service/manager.ts`、`src/config.ts`、`package.json`（configuration 三新项）、`test/process.test.ts`、`test/config.test.ts`

**Interfaces:**
- `StartOptions` 增 `cwd?: string`；`ManagerOptions` 增 `cwd?: string`；`DshConfig` 增 `bridgeEnabled: boolean`、`workspaceRootIndex: number`、`silenceWarning: boolean`（DEFAULTS 对应 `true` / `0` / `false`）。

- [ ] **Step 1: 写失败测试**

`test/config.test.ts` 增补：

```ts
test('normalizeConfig 处理桥接新设置项的缺省与非法值', () => {
  const r1 = normalizeConfig({});
  assert.equal(r1.config.bridgeEnabled, true);
  assert.equal(r1.config.workspaceRootIndex, 0);
  assert.equal(r1.config.silenceWarning, false);
  const r2 = normalizeConfig({ bridgeEnabled: false, workspaceRootIndex: 2, silenceWarning: true });
  assert.equal(r2.config.bridgeEnabled, false);
  assert.equal(r2.config.workspaceRootIndex, 2);
  assert.equal(r2.config.silenceWarning, true);
  const r3 = normalizeConfig({ workspaceRootIndex: -1 });
  assert.equal(r3.config.workspaceRootIndex, 0); // 非法回退默认
  assert.equal(r3.errors.length, 1);
});
```

`test/process.test.ts` 增补：

```ts
test('startDsh 透传 cwd 到 spawn 选项', () => {
  const calls: unknown[] = [];
  const runner = createProcessRunner(((cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild(); }) as SpawnFn, 'linux');
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [], cwd: '/proj' });
  const c = calls[0] as { opts: SpawnOptions };
  assert.equal(c.opts.cwd, '/proj');
});
```

（沿用该文件既有 fakeChild/SpwanFn 导入方式；无则按文件内现有模式补齐。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/service/process.ts`：`StartOptions` 加 `cwd?: string`；`startDsh` 的 spawn 选项加 `...(cwd === undefined ? {} : { cwd })`。
`src/service/manager.ts`：`ManagerOptions` 加 `cwd?: string`；`doStart` 里 `this.deps.processRunner.startDsh({..., cwd: this.opts.cwd})`。
`src/config.ts`：`RawDshConfig`/`DshConfig`/`DEFAULTS`/`normalizeConfig`/`readConfig` 同步加三字段（`workspaceRootIndex` 非负整数否则回退 0 并记 error；布尔沿用 autoStart 的缺省处理模式）。
`package.json` configuration.properties 增：

```json
"dsh.bridge.enabled": {
  "type": "boolean", "default": true,
  "markdownDescription": "%dsh.config.bridgeEnabled%"
},
"dsh.workspaceRootIndex": {
  "type": "number", "default": 0, "minimum": 0,
  "markdownDescription": "%dsh.config.workspaceRootIndex%"
},
"dsh.bridge.silenceWarning": {
  "type": "boolean", "default": false,
  "markdownDescription": "%dsh.config.bridgeSilenceWarning%"
}
```

并在 `extension.ts` 的 `toManagerOptions` 里传 `cwd: resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], config.workspaceRootIndex)`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/service/process.ts src/service/manager.ts src/config.ts src/extension.ts package.json test/process.test.ts test/config.test.ts
git commit -m "feat: spawn cwd 兜底与新设置项（bridge.enabled/workspaceRootIndex/silenceWarning）"
```

---

### Task 7: 桥接状态评估与降级警告

**Files:**
- Create: `src/bridge/status.ts`
- Modify: `src/extension.ts`（激活时安装桥接 → 状态评估 → 警告弹窗与重试命令）、`src/panel/provider.ts`（onBridgeAck 接状态）、`src/i18n.ts`（文案）、`package.json`（`dsh.bridge.retry` 命令）、`test/bridge/status.test.ts`（新建）

**Interfaces:**
- Produces:
  ```ts
  export type BridgeStatus = 'ok' | 'pending-restart' | 'degraded';
  export function evaluateBridgeStatus(install: BridgeInstallResult, handshakeOk: boolean | undefined): BridgeStatus;
  // 规则：degraded → degraded；handshakeOk===true → ok；undefined（握手未发生/超时）且 install ok → pending-restart；install ok 且 handshakeOk===false → degraded
  export function bridgeWarningText(status: BridgeStatus): MsgKey;
  ```
- 命令 `dsh.bridge.retry`：重装桥接（installBridge）+ 重启服务 + 清警告静默。

- [ ] **Step 1: 写失败测试**

`test/bridge/status.test.ts`：

```ts
// test/bridge/status.test.ts — 桥接状态评估单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBridgeStatus } from '../src/bridge/status';

test('安装失败即 degraded', () => {
  assert.equal(evaluateBridgeStatus({ status: 'degraded', reason: 'x' }, undefined), 'degraded');
});

test('握手成功为 ok', () => {
  assert.equal(evaluateBridgeStatus({ status: 'ok' }, true), 'ok');
});

test('安装成功但握手未发生为 pending-restart', () => {
  assert.equal(evaluateBridgeStatus({ status: 'ok' }, undefined), 'pending-restart');
});

test('握手失败为 degraded', () => {
  assert.equal(evaluateBridgeStatus({ status: 'ok' }, false), 'degraded');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现 status.ts**

```ts
// src/bridge/status.ts — 桥接状态评估（纯函数）
import type { BridgeInstallResult } from './installer';
import type { MsgKey } from '../i18n';

export type BridgeStatus = 'ok' | 'pending-restart' | 'degraded';

/** 综合安装结果与握手结果判定最终状态 */
export function evaluateBridgeStatus(
  install: BridgeInstallResult,
  handshakeOk: boolean | undefined,
): BridgeStatus {
  if (install.status === 'degraded') return 'degraded';
  if (handshakeOk === true) return 'ok';
  if (handshakeOk === undefined) return 'pending-restart';
  return 'degraded';
}

/** 警告文案键（degraded 时展示，说明不可用功能） */
export function bridgeWarningText(status: BridgeStatus): MsgKey | null {
  return status === 'degraded' ? 'bridge.warnDegraded' : null;
}
```

- [ ] **Step 4: extension.ts 装配（安装、警告、重试）**

- `activate` 中：`const install = installBridge({ dshHome: process.env.DSH_HOME ?? homedir() + '/.dsh', bridgeSourceDir: join(__dirname, '..', 'bridge-client'), fs: nodeFsAdapter() })`（`nodeFsAdapter` 在 installer 同文件导出：exists/readFile/writeFile/mkdir/copyDir(cpSync recursive)/rmDir(rmSync recursive)/readdir——写入 installer.ts 的 `createNodeFs(): InstallerFs`，本任务一并实现）。
- 记录 `handshakeOk`（provider onBridgeAck 回调写入，握手超时 3 秒未回执置 false）；
- 激活后 3.5 秒定时器：`const status = evaluateBridgeStatus(install, handshakeOk)`；若 `status==='degraded'` 且 `!config.silenceWarning` 且 globalState 未标记静默 → `showWarningMessage(t('bridge.warnDegraded'), t('bridge.retryNow'), t('bridge.neverAgain'))`：
  - `重试` → `installBridge(...)` + `manager.restart()`；
  - `不再提示` → `context.globalState.update('dsh.bridgeWarningSilenced', true)`；
  - `dsh.bridge.silenceWarning` 设置为 true 时同样不再弹；
- 注册命令 `dsh.bridge.retry`（title `%dsh.cmd.bridgeRetry%`）。
- `deactivate` 中**不**自动 uninstall（避免用户卸载窗口场景反复装卸；卸载清理走卸载事件 `context.subscriptions` 的 dispose 钩子：仅在 `vscode.ExtensionContext` 卸载时执行——实现为注册 `vscode.workspace.onDidChangeConfiguration` 之外的 `{ dispose: () => { if (process.env.VSCODE_EXTENSION_UNINSTALL === '1') uninstallBridge(...) } }` 不可靠，改为：不自动清理，README 说明手动清理路径 + 设置项 `dsh.bridge.uninstall` 命令手动触发，本任务实现命令 `dsh.bridge.uninstall`）。

- [ ] **Step 5: i18n 文案（i18n.ts 中英各加）**

```
en:
  'bridge.warnDegraded': 'DSH bridge is not active. These features are unavailable: 1) click links to open in browser 2) click file paths to open in VS Code 3) auto-switch to the current workspace. You can retry installing the bridge or silence this warning.',
  'bridge.retryNow': 'Retry Install',
  'bridge.neverAgain': "Don't Show Again",
  'bridge.syncFailed': 'Failed to sync DSH workspace: {message}',
zh:
  'bridge.warnDegraded': 'DSH 桥接未生效，以下功能不可用：①点击链接跳转浏览器 ②点击文件路径在 VS Code 打开 ③自动切换到当前工作区。可重试安装桥接，或不再显示本警告。',
  'bridge.retryNow': '重试安装',
  'bridge.neverAgain': '不再提示',
  'bridge.syncFailed': 'DSH 工作区同步失败：{message}',
```

package.nls 同步增 `dsh.cmd.bridgeRetry.title`（DSH: 重试桥接安装 / Retry Bridge Install）、`dsh.cmd.bridgeUninstall.title`（DSH: 卸载桥接 / Uninstall Bridge）及三个设置项描述。

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add src/bridge/status.ts src/bridge/installer.ts src/extension.ts src/panel/provider.ts src/i18n.ts package.json package.nls.json package.nls.zh-cn.json test/bridge/status.test.ts
git commit -m "feat: 桥接状态评估、降级警告与重试/卸载命令"
```

---

### Task 8: 集成实测（WSL 真实环境）与修复

**Files:** 无固定文件；按发现的问题修改对应模块并补测试。

- [ ] **Step 1: 构建并安装本地版**

```bash
cd /home/fengze233/dsh_vs && npm run compile && npm test
npx vsce package -o /tmp/dsh-vscode-bridge.vsix
# 用 ~/.vscode-server/bin/<commit>/node .../out/server-main.js --install-extension 装到 WSL 侧（沿用既有安装命令）
```

- [ ] **Step 2: 逐项验证**（每项记录结果）
1. 面板点外链 → 系统浏览器打开，面板页面不动；
2. 点文件路径 → VS Code 打开文件；相对路径正确解析；不存在的文件弹提示；
3. 打开面板 → DSH 自动选中 VS Code 工作区（会话树出现该工作区分组，新建会话 cwd 正确）；
4. 浏览器直接开 `http://127.0.0.1:3080/` → 桥接不激活（点击链接走浏览器原生新标签、无报错）；
5. 备份 profile 后跑 `dsh plugin --profile web add <任意可卸载包>` → 检查 `node_modules/dsh-vscode-bridge` 是否被清（若被清：实现备选——把桥接包放 profile 同级的独立目录 `~/.dsh/dsh-vscode-bridge-pkg/` 并在 cordis.patch.yml 条目中注明解析路径，具体以实测可行方式为准，改 installer 与对应测试）；
6. `dsh.bridge.enabled=false` → 桥接不安装不注入，面板一切正常；改回 true 恢复；
7. 故意破坏安装（改名桥接目录）→ 警告弹出、功能降级、点"不再提示"后不再弹、点"重试安装"恢复；
8. 执行 `dsh.bridge.uninstall` → cordis.patch.yml 还原、桥接目录删除；
9. 多根工作区（临时 .code-workspace 加两个文件夹）→ workspaceRootIndex 生效。

- [ ] **Step 3: 修复发现的问题**（TDD：先补失败测试再改实现），重复 Step 1 构建验证。

- [ ] **Step 4: 清理**：停止测试起的服务；恢复 profile 到测试前状态（cordis.patch.yml 备份还原、删除测试用 workspace 之外的残留）；确认 `git status` 干净。

- [ ] **Step 5: 提交修复**

```bash
git add -A && git commit -m "fix: 集成实测问题修复"
```

---

### Task 9: 文档、版本与发布

**Files:**
- Modify: `README.md`（桥接说明、披露、设置项、卸载说明）、`CHANGELOG.md`（如有；否则新建）、`package.json`（version 0.2.0）、`.vscodeignore`（核对：`bridge-client/` 不排除、`docs/superpowers/` 已排除）

- [ ] **Step 1: 更新 README**：新增"桥接与工作区联动"章节（功能说明 + 安装/卸载机制披露 + 三个新设置项表 + 降级行为说明）；中英双语与现有结构一致。
- [ ] **Step 2: 版本 0.2.0 + CHANGELOG**：`package.json` version 改 `0.2.0`；CHANGELOG 记录本次三项能力与修复。
- [ ] **Step 3: 打包并核对内容**

```bash
npx vsce package -o /tmp/dsh-vscode-0.2.0.vsix
unzip -l /tmp/dsh-vscode-0.2.0.vsix | grep -E 'bridge-client|out/|extension' | head -20
```

Expected: vsix 内含 `bridge-client/` 与 `out/extension.js`，不含 `src/`、`docs/`、`test/`。

- [ ] **Step 4: 发布**：商店更新（沿用既有 vsce 流程或网页上传）；GitHub Release v0.2.0 + 推送代码与 tag；讨论帖 #1908 跟进说明新能力。
- [ ] **Step 5: 提交**

```bash
git add README.md CHANGELOG.md package.json && git commit -m "docs: README 桥接说明与 v0.2.0 发布"
git tag v0.2.0 && git push origin main --tags
```

---

## 自审记录

- **Spec 覆盖**：§4 三模块 → Task 1/2/3/4；§5.1 链接/文件跳转 → Task 1/4；§5.2 工作区同步 → Task 5；§5.3 验证点 → Task 0；§6 降级警告 → Task 7；§7 设置项 → Task 6；§8 安全（白名单/握手 token）→ Task 1/4；§9 测试计划单测 → 各 Task Step1；§9 实测 → Task 8；§10 发布 → Task 9。§11 风险缓解（能力探测 → Task 0/7；pnpm 清理 → Task 0/8；兜底注入 → Task 5）。
- **类型一致性**：`BridgeInstallResult`/`BridgeInstallOptions`/`InstallerFs`（Task 2）被 Task 7 原样引用；`DshApiClient`/`WorkspaceItem`（Task 3）被 Task 5 引用；`resolveWorkspaceRoot`（Task 5）被 Task 6 extension.ts 引用；`PanelMessage` 新成员（Task 4）被 host.ts switch 完整覆盖；`readyPage` 第三参可选（向后兼容既有测试）。
- **占位符扫描**：无 TBD/TODO；Task 5 的"选中触发"依赖 Task 0 结论，已同时给出兜底实现与切换策略；Task 8 步骤 5 的备选方案已写明改法范围。
