# DSH VS Code 插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开发一个 VS Code 扩展（DSH），点击侧边栏图标即可在 VS Code 内嵌使用 DeepSeek Harness 网页，自动探测/启动/复用 `dsh web` 服务，最终打包成 `.vsix`。

**Architecture:** 纯 TypeScript VS Code 扩展。核心是"服务管理器"状态机（vscode 无关、依赖注入、可单测），它编排端口探测（复用或拉起 `dsh web` 子进程并轮询就绪）。侧边栏面板（WebviewViewProvider）只负责 iframe 加载真实 DSH 网页与三态占位页。状态栏显示服务状态。所有文案走 i18n 规则（`zh-*` 中文、其余英文）。

**Tech Stack:** TypeScript、VS Code Extension API（`engines.vscode: ^1.85.0`）、esbuild 打包、`@vscode/vsce` 打 .vsix、Node 内置 `node:test` 测试（Node ≥ 22，本机 22.22.1）。

## Global Constraints

（以下条目取自设计规格，逐字固定；每个任务隐含遵守全部条目。）

- **不做任何 git 操作**（用户暂未决定是否用 Git；各任务的"提交"步骤已省略，任务完成标准=该任务测试通过）。
- **代码注释**：所有代码必须写完整的中文注释。
- **文案规则**：取 `vscode.env.language`；`zh-*` 开头 → 简体中文；其余任何语言 → 英文。静态文案用 `package.nls.json`（英文默认）+ `package.nls.zh-cn.json`（中文）；动态文案用 `src/i18n.ts` 的 `t(key)`。
- **安全边界**：只连接 loopback（`127.0.0.1` / `localhost` / `[::1]`），`dsh.host` 非法值回退默认；不读取/传输 `~/.dsh` 下凭据；不向 DSH 网页注入脚本；iframe 不加 `sandbox` 属性。
- **配置项**（`dsh.*`，默认值）：`dsh.host`=`127.0.0.1`、`dsh.port`=3080、`dsh.autoStart`=true、`dsh.stopOnExit`=true、`dsh.extraArgs`=[]。
- **时间参数**：探测超时 3000ms；启动等待 15000ms、轮询间隔 500ms。
- **进程规则**：只停止插件自己启动的服务；用户手动启动的服务永不干预；父进程退出钩子杀掉子进程防僵尸（`stopOnExit`=false 时移除钩子保持运行）。
- **平台**：Linux / macOS / Windows 三平台（Windows 命令名为 `dsh.cmd`，不 detached）。
- **命名**：显示名 `DSH`；目录 `dsh-vscode`（本地路径 `/home/fengze233/dsh_vs`）；Extension ID `dsh.dsh-vscode`；命令前缀 `dsh.*`。
- **测试后清理**：测试产生的 `dsh web` 进程必须全部停止，恢复测试前状态。

---

## 文件结构总览

```
dsh_vs/
├── package.json                  # 扩展清单（视图容器、命令、菜单、配置项）
├── package.nls.json              # 静态文案（英文默认）
├── package.nls.zh-cn.json        # 静态文案（中文）
├── tsconfig.json                 # typecheck 用（esbuild 不依赖它）
├── .vscodeignore                 # vsce 打包排除清单
├── .gitignore                    # 备将来启用 git
├── README.md                     # 简短使用说明（中英）
├── assets/icon.svg               # 活动栏图标
├── scripts/build.mjs             # esbuild：扩展包 + 测试包
├── src/
│   ├── extension.ts              # 入口：装配与命令注册
│   ├── i18n.ts                   # 动态文案字典（纯模块）
│   ├── config.ts                 # 设置读取与规范化（纯函数 + vscode 薄封装）
│   ├── service/
│   │   ├── detect.ts             # 端口探测 probeService（纯模块）
│   │   ├── process.ts            # 子进程封装 createProcessRunner（纯模块）
│   │   └── manager.ts            # ServiceManager 状态机（纯模块，注入依赖）
│   ├── panel/
│   │   ├── html.ts               # 占位页模板（纯函数）
│   │   └── provider.ts           # DshPanelProvider（vscode WebviewViewProvider）
│   └── statusbar.ts              # 状态栏控制器
└── test/
    ├── i18n.test.ts
    ├── config.test.ts
    ├── detect.test.ts
    ├── process.test.ts
    ├── manager.test.ts
    ├── html.test.ts
    └── integration/dsh.test.ts   # 真实 dsh 集成测试
```

**模块边界原则**：`src/i18n.ts`、`src/config.ts`（纯函数部分）、`src/service/*`、`src/panel/html.ts` 不 import `vscode`，可用 `node:test` 直接单测；`src/extension.ts`、`src/panel/provider.ts`、`src/statusbar.ts` 依赖 `vscode`，靠人工验收清单验证。

---

### Task 1: 工程脚手架

**Files:**
- Create: `package.json`、`package.nls.json`、`package.nls.zh-cn.json`、`tsconfig.json`、`.vscodeignore`、`.gitignore`、`README.md`、`assets/icon.svg`、`scripts/build.mjs`、`src/extension.ts`（占位版）、`test/placeholder.test.ts`（占位测试，Task 2 删除）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `npm run compile` 可产出 `out/extension.js`；`npm test` 命令骨架；后续任务在此工程上叠加

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "dsh-vscode",
  "displayName": "DSH",
  "description": "在 VS Code 侧边栏中使用 DeepSeek Harness（DSH）网页界面",
  "version": "0.1.0",
  "publisher": "fengze233",
  "license": "MIT",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "main": "./out/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "dsh", "title": "%dsh.container.title%", "icon": "assets/icon.svg" }
      ]
    },
    "views": {
      "dsh": [
        { "id": "dsh.panel", "name": "%dsh.view.panel.name%", "type": "webview" }
      ]
    },
    "commands": [
      { "command": "dsh.openPanel", "title": "%dsh.cmd.openPanel.title%", "icon": "$(panel)" },
      { "command": "dsh.openSecondary", "title": "%dsh.cmd.openSecondary.title%", "icon": "$(layout-sidebar-right)" },
      { "command": "dsh.openExternal", "title": "%dsh.cmd.openExternal.title%", "icon": "$(link-external)" },
      { "command": "dsh.restart", "title": "%dsh.cmd.restart.title%", "icon": "$(refresh)" },
      { "command": "dsh.stop", "title": "%dsh.cmd.stop.title%", "icon": "$(debug-stop)" },
      { "command": "dsh.copyUrl", "title": "%dsh.cmd.copyUrl.title%", "icon": "$(copy)" },
      { "command": "dsh.showLogs", "title": "%dsh.cmd.showLogs.title%", "icon": "$(output)" }
    ],
    "menus": {
      "view/title": [
        { "command": "dsh.openExternal", "when": "view == dsh.panel", "group": "navigation@1" },
        { "command": "dsh.restart", "when": "view == dsh.panel", "group": "navigation@2" },
        { "command": "dsh.stop", "when": "view == dsh.panel", "group": "navigation@3" },
        { "command": "dsh.copyUrl", "when": "view == dsh.panel", "group": "navigation@4" },
        { "command": "dsh.showLogs", "when": "view == dsh.panel", "group": "navigation@5" }
      ]
    },
    "configuration": {
      "title": "DSH",
      "properties": {
        "dsh.host": {
          "type": "string",
          "default": "127.0.0.1",
          "enum": ["127.0.0.1", "localhost", "[::1]"],
          "markdownDescription": "%dsh.config.host%"
        },
        "dsh.port": {
          "type": "number",
          "default": 3080,
          "minimum": 0,
          "maximum": 65535,
          "markdownDescription": "%dsh.config.port%"
        },
        "dsh.autoStart": {
          "type": "boolean",
          "default": true,
          "markdownDescription": "%dsh.config.autoStart%"
        },
        "dsh.stopOnExit": {
          "type": "boolean",
          "default": true,
          "markdownDescription": "%dsh.config.stopOnExit%"
        },
        "dsh.extraArgs": {
          "type": "array",
          "items": { "type": "string" },
          "default": [],
          "markdownDescription": "%dsh.config.extraArgs%"
        }
      }
    }
  },
  "scripts": {
    "compile": "node scripts/build.mjs",
    "watch": "node scripts/build.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "node scripts/build.mjs --test && node --test \"out/test/**/*.test.js\"",
    "package": "npm run compile && vsce package -o dsh-vscode.vsix"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/vscode": "^1.85.0",
    "@vscode/vsce": "^3.0.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: 创建 package.nls.json（英文默认文案）**

```json
{
  "dsh.container.title": "DSH",
  "dsh.view.panel.name": "DSH Panel",
  "dsh.cmd.openPanel.title": "DSH: Open Panel",
  "dsh.cmd.openSecondary.title": "DSH: Open in Secondary Side Bar",
  "dsh.cmd.openExternal.title": "Open in Browser",
  "dsh.cmd.restart.title": "Restart Service",
  "dsh.cmd.stop.title": "Stop Service",
  "dsh.cmd.copyUrl.title": "Copy URL",
  "dsh.cmd.showLogs.title": "Show Logs",
  "dsh.config.host": "Service host. Only loopback values (`127.0.0.1` / `localhost` / `[::1]`) are allowed; invalid values fall back to the default.",
  "dsh.config.port": "Expected port for the DSH web service (used for both detection and startup).",
  "dsh.config.autoStart": "Automatically start `dsh web` when the service is not running.",
  "dsh.config.stopOnExit": "Stop the plugin-started service when the last VS Code window closes.",
  "dsh.config.extraArgs": "Extra arguments appended when the plugin starts `dsh web` (e.g. `--trusted-host`)."
}
```

- [ ] **Step 3: 创建 package.nls.zh-cn.json（中文文案）**

```json
{
  "dsh.container.title": "DSH",
  "dsh.view.panel.name": "DSH 面板",
  "dsh.cmd.openPanel.title": "DSH: 打开面板",
  "dsh.cmd.openSecondary.title": "DSH: 在辅助侧边栏打开",
  "dsh.cmd.openExternal.title": "在浏览器中打开",
  "dsh.cmd.restart.title": "重启服务",
  "dsh.cmd.stop.title": "停止服务",
  "dsh.cmd.copyUrl.title": "复制网址",
  "dsh.cmd.showLogs.title": "查看日志",
  "dsh.config.host": "服务地址。仅允许回环地址（`127.0.0.1` / `localhost` / `[::1]`），非法值回退默认。",
  "dsh.config.port": "DSH web 服务的期望端口（探测与启动共用）。",
  "dsh.config.autoStart": "服务未运行时自动启动 `dsh web`。",
  "dsh.config.stopOnExit": "关闭最后一个 VS Code 窗口时停止插件启动的服务。",
  "dsh.config.extraArgs": "插件启动 `dsh web` 时附加的参数（如 `--trusted-host`）。"
}
```

- [ ] **Step 4: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node", "vscode"],
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "out"
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 5: 创建 .vscodeignore、.gitignore、README.md、assets/icon.svg**

`.vscodeignore`：

```
.vscode/**
.superpowers/**
src/**
test/**
scripts/**
docs/**
out/test/**
**/*.map
tsconfig.json
```

`.gitignore`（备将来启用 git）：

```
node_modules/
out/
*.vsix
```

`README.md`（简短）：

```markdown
# DSH — DeepSeek Harness for VS Code

在 VS Code 侧边栏中直接使用 DeepSeek Harness（DSH）网页界面。

## 使用

1. 安装本扩展（.vsix）。
2. 点击活动栏 DSH 图标，侧边栏会自动启动（或复用）`dsh web` 并内嵌显示 DSH 网页。
3. 面板标题栏按钮：在浏览器中打开 / 重启服务 / 停止服务 / 复制网址 / 查看日志。
4. 如需固定在右侧：执行命令 `DSH: 在辅助侧边栏打开`，并把面板视图移到辅助侧边栏（位置会永久保持）。

## 设置

见 VS Code 设置中的 `dsh.*` 项（端口、自动启动等）。

## 多语言

界面文案跟随 VS Code 显示语言：中文环境显示中文，其余语言显示英文。
```

`assets/icon.svg`：

```svg
<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4D6BFE"/>
      <stop offset="1" stop-color="#3B4FE0"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="116" height="116" rx="26" fill="url(#g)"/>
  <rect x="30" y="42" width="68" height="12" rx="6" fill="#ffffff"/>
  <rect x="30" y="64" width="68" height="12" rx="6" fill="#ffffff" opacity="0.85"/>
  <rect x="30" y="86" width="44" height="12" rx="6" fill="#ffffff" opacity="0.7"/>
</svg>
```

- [ ] **Step 6: 创建 scripts/build.mjs（esbuild 构建：扩展包 + 测试包）**

```js
// scripts/build.mjs — esbuild 构建脚本
// 用法：node scripts/build.mjs            # 构建扩展 + 测试
//       node scripts/build.mjs --test     # 只构建测试
//       node scripts/build.mjs --watch    # 监听模式
import { build, context } from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const testOnly = process.argv.includes('--test');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

// 扩展入口：external vscode（由 VS Code 宿主提供）
const ext = {
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  external: ['vscode'],
  ...common,
};

// 测试入口：递归收集 test 目录下的 *.test.ts
const testEntries = readdirSync('test', { recursive: true })
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join('test', f));
const tests = {
  entryPoints: testEntries,
  outdir: 'out/test',
  ...common,
};

const configs = testOnly ? [tests] : [ext, tests];
if (watch) {
  await Promise.all(configs.map((c) => context(c).then((ctx) => ctx.watch())));
  console.log('watch 模式已启动');
} else {
  await Promise.all(configs.map((c) => build(c)));
  console.log('构建完成');
}
```

- [ ] **Step 7: 创建占位版 src/extension.ts（本任务最小实现）**

```ts
// src/extension.ts — 插件入口（脚手架占位版，后续任务填充完整实现）
import * as vscode from 'vscode';

/** 插件激活入口：VS Code 启动完成后调用 */
export function activate(context: vscode.ExtensionContext): void {
  // 占位：注册一个最小命令证明激活链路可用
  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.openPanel', () => {
      void vscode.commands.executeCommand('dsh.panel.focus');
    }),
  );
}

/** 插件停用入口：VS Code 关闭时调用 */
export function deactivate(): void {
  // 占位：后续任务填充停止服务逻辑
}
```

- [ ] **Step 8: 创建占位测试、安装依赖、验证构建与测试管线**

先创建 `test/placeholder.test.ts`：

```ts
// test/placeholder.test.ts — 脚手架占位测试，验证测试管线可用（Task 2 删除）
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('脚手架测试管线可用', () => {
  assert.equal(1 + 1, 2);
});
```

Run: `npm install`
Expected: 依赖安装成功，无报错。

Run: `npm run compile`
Expected: 输出 `out/extension.js` 与 `out/test/placeholder.test.js`。

Run: `npm run test`
Expected: `# pass 1`，测试管线跑通。

- [ ] **Step 9: 验证 typecheck**

Run: `npm run typecheck`
Expected: 无类型错误。

---

### Task 2: i18n 动态文案模块

**Files:**
- Create: `src/i18n.ts`
- Test: `test/i18n.test.ts`
- Delete: `test/placeholder.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export type MsgKey = keyof typeof messages.en`（文案键联合类型）
  - `export function initI18n(language: string): void`（按 `zh-*` 规则选语言）
  - `export function getLang(): 'zh' | 'en'`
  - `export function t(key: MsgKey, vars?: Record<string, string | number>): string`（支持 `{var}` 替换）

- [ ] **Step 1: 编写失败测试 test/i18n.test.ts**

```ts
// test/i18n.test.ts — i18n 语言规则与变量替换的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initI18n, getLang, t } from '../src/i18n';

test('zh-* 语言使用中文文案', () => {
  initI18n('zh-cn');
  assert.equal(getLang(), 'zh');
  assert.equal(t('panel.loading'), '正在启动 DSH 服务…');
});

test('非 zh 语言一律使用英文文案', () => {
  initI18n('en');
  assert.equal(getLang(), 'en');
  assert.equal(t('panel.loading'), 'Starting DSH service…');
  initI18n('ja');
  assert.equal(getLang(), 'en');
  initI18n('de');
  assert.equal(getLang(), 'en');
});

test('大小写不敏感：ZH-cn 判定为中文', () => {
  initI18n('ZH-cn');
  assert.equal(getLang(), 'zh');
});

test('t() 支持 {变量} 替换', () => {
  initI18n('en');
  assert.equal(
    t('err.portOccupied', { port: 3080 }),
    'Port 3080 is occupied by another program. Change dsh.port in settings, then retry.',
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL——构建阶段报 `Could not resolve "../src/i18n"`（测试文件引用的模块尚不存在）。

- [ ] **Step 3: 编写最小实现 src/i18n.ts**

```ts
// src/i18n.ts — 动态文案字典
// 规则：VS Code 显示语言（vscode.env.language）以 zh- 开头 → 简体中文；
//       其余任何语言 → 英文。静态文案（package.nls.*.json）由 VS Code 自行处理，
//       本模块只负责运行时动态文案（状态栏、占位页、错误提示、日志等）。
const messages = {
  en: {
    // 面板占位页
    'panel.loading': 'Starting DSH service…',
    'panel.errorTitle': 'Failed to start DSH service',
    'panel.disconnectedTitle': 'DSH service disconnected',
    'panel.reconnect': 'Reconnect',
    'panel.retry': 'Retry',
    'panel.openExternal': 'Open in Browser',
    'panel.restart': 'Restart Service',
    'panel.stop': 'Stop Service',
    'panel.copyUrl': 'Copy URL',
    'panel.showLogs': 'Show Logs',
    // 错误原因（error 字段存的 i18n 键）
    'err.portOccupied': 'Port {port} is occupied by another program. Change dsh.port in settings, then retry.',
    'err.dshNotFound': 'The dsh command was not found. Install DeepSeek Harness first.',
    'err.startTimeout': 'Service did not become ready within {seconds}s. See the DSH log for details.',
    'err.startCrashed': 'The DSH service exited unexpectedly. See the DSH log for details.',
    'err.notRunning': 'DSH service is not running and auto-start is disabled.',
    'err.loadFailed': 'Unable to load the DSH page.',
    // 状态栏
    'status.running': 'DSH: Running',
    'status.starting': 'DSH: Starting',
    'status.failed': 'DSH: Failed',
    'status.stopped': 'DSH: Stopped',
    // 辅助侧边栏引导
    'guide.secondaryTitle': 'DSH: Secondary Side Bar',
    'guide.secondaryText':
      'Drag the DSH panel to the Secondary Side Bar (or right-click the view title → Move View), and it will stay there permanently.',
    'guide.gotIt': 'Got it',
    // 通知
    'info.urlCopied': 'URL copied: {url}',
    'info.notReady': 'DSH service is not ready yet.',
    'info.stopped': 'DSH service stopped.',
  },
  zh: {
    'panel.loading': '正在启动 DSH 服务…',
    'panel.errorTitle': 'DSH 服务启动失败',
    'panel.disconnectedTitle': 'DSH 服务已断开',
    'panel.reconnect': '重新连接',
    'panel.retry': '重试',
    'panel.openExternal': '在浏览器中打开',
    'panel.restart': '重启服务',
    'panel.stop': '停止服务',
    'panel.copyUrl': '复制网址',
    'panel.showLogs': '查看日志',
    'err.portOccupied': '端口 {port} 被其他程序占用。请在设置中修改 dsh.port 后重试。',
    'err.dshNotFound': '未找到 dsh 命令，请先安装 DeepSeek Harness。',
    'err.startTimeout': '服务在 {seconds} 秒内未就绪，详见 DSH 日志。',
    'err.startCrashed': 'DSH 服务异常退出，详见 DSH 日志。',
    'err.notRunning': 'DSH 服务未运行，且已关闭自动启动。',
    'err.loadFailed': '无法加载 DSH 页面。',
    'status.running': 'DSH: 运行中',
    'status.starting': 'DSH: 启动中',
    'status.failed': 'DSH: 失败',
    'status.stopped': 'DSH: 已停止',
    'guide.secondaryTitle': 'DSH：辅助侧边栏',
    'guide.secondaryText':
      '将 DSH 面板拖到右侧辅助侧边栏（或右键视图标题 → 移动视图），之后会永久保持在该位置。',
    'guide.gotIt': '知道了',
    'info.urlCopied': '已复制网址：{url}',
    'info.notReady': 'DSH 服务尚未就绪。',
    'info.stopped': 'DSH 服务已停止。',
  },
} as const;

/** 文案键联合类型（en 为键的来源） */
export type MsgKey = keyof typeof messages.en;

let current: 'zh' | 'en' = 'en';

/** 按语言规则初始化（扩展激活时调用一次） */
export function initI18n(language: string): void {
  current = language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 当前语言 */
export function getLang(): 'zh' | 'en' {
  return current;
}

/** 取文案；vars 中的 {key} 会被替换 */
export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  let s: string = messages[current][key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: `# pass 5`（i18n 4 个 + 占位 1 个）。

- [ ] **Step 5: 删除 test/placeholder.test.ts**

```bash
rm test/placeholder.test.ts
```

---

### Task 3: 配置读取与规范化

**Files:**
- Create: `src/config.ts`、`test/vscode-stub.ts`（测试用 vscode 运行时桩，因为 config.ts 顶层 import vscode 而 node --test 环境无 VS Code 宿主）
- Modify: `scripts/build.mjs`（tests 构建增加 alias：vscode → 测试桩）
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface RawDshConfig`（原始可空配置）
  - `export interface DshConfig { host: string; port: number; autoStart: boolean; stopOnExit: boolean; extraArgs: string[] }`
  - `export const DEFAULTS: DshConfig`（`127.0.0.1` / 3080 / true / true / []）
  - `export function isLoopbackHost(host: string): boolean`
  - `export function normalizeConfig(raw: RawDshConfig): { config: DshConfig; errors: string[] }`（非法值回退默认并记录错误）
  - `export function readConfig(): { config: DshConfig; errors: string[] }`（vscode 薄封装）

- [ ] **Step 1: 编写失败测试 test/config.test.ts**

```ts
// test/config.test.ts — 配置规范化与回环地址校验的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, isLoopbackHost, DEFAULTS } from '../src/config';

test('合法配置原样通过', () => {
  const { config, errors } = normalizeConfig({
    host: 'localhost', port: 4000, autoStart: false, stopOnExit: false, extraArgs: ['--trusted-host', 'x:1'],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(config, { host: 'localhost', port: 4000, autoStart: false, stopOnExit: false, extraArgs: ['--trusted-host', 'x:1'] });
});

test('缺省值回退默认', () => {
  const { config } = normalizeConfig({});
  assert.deepEqual(config, DEFAULTS);
});

test('非回环地址回退默认并记录错误', () => {
  const { config, errors } = normalizeConfig({ host: '192.168.1.5' });
  assert.equal(config.host, DEFAULTS.host);
  assert.equal(errors.length, 1);
});

test('端口非法（越界/非整数）回退默认并记录错误', () => {
  for (const bad of [-1, 65536, 1.5, NaN]) {
    const { config, errors } = normalizeConfig({ port: bad });
    assert.equal(config.port, DEFAULTS.port);
    assert.equal(errors.length, 1);
  }
});

test('extraArgs 非字符串元素被过滤', () => {
  const { config } = normalizeConfig({ extraArgs: ['--a', 1 as unknown as string, '--b'] });
  assert.deepEqual(config.extraArgs, ['--a', '--b']);
});

test('回环地址识别', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('192.168.0.1'), false);
  assert.equal(isLoopbackHost('example.com'), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL——构建阶段报 `Could not resolve "../src/config"`。

- [ ] **Step 3: 编写最小实现 src/config.ts**

```ts
// src/config.ts — dsh.* 设置项读取与规范化
// 纯函数（normalizeConfig / isLoopbackHost）不依赖 vscode，可直接单测；
// readConfig 是 vscode 设置的薄封装，供 extension.ts 使用。
import * as vscode from 'vscode';

/** 用户可配置的原始值（可能缺失/非法） */
export interface RawDshConfig {
  host?: string;
  port?: number;
  autoStart?: boolean;
  stopOnExit?: boolean;
  extraArgs?: string[];
}

/** 规范化后的配置（均有合法默认值） */
export interface DshConfig {
  host: string;
  port: number;
  autoStart: boolean;
  stopOnExit: boolean;
  extraArgs: string[];
}

/** 默认配置 */
export const DEFAULTS: DshConfig = {
  host: '127.0.0.1',
  port: 3080,
  autoStart: true,
  stopOnExit: true,
  extraArgs: [],
};

/** 安全边界：仅允许回环地址 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 判断是否为回环地址 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * 规范化原始配置：非法值回退默认并记录错误描述
 * （安全规则：host 只允许回环地址，端口必须为 0..65535 的整数）
 * 语义约定：字段「缺失」静默回退默认（不算错误）；字段「提供了非法值」才记录错误并回退默认。
 */
export function normalizeConfig(raw: RawDshConfig): { config: DshConfig; errors: string[] } {
  const errors: string[] = [];

  // 缺失与非法需区分：字段未配置时静默回退默认（不算错误），
  // 只有提供了非法值才记录错误并回退默认。
  let host: string;
  if (typeof raw.host !== 'string') {
    host = DEFAULTS.host;
  } else {
    host = raw.host.trim();
    if (!isLoopbackHost(host)) {
      errors.push(`dsh.host must be a loopback address, got ${JSON.stringify(raw.host)}`);
      host = DEFAULTS.host;
    }
  }

  let port = raw.port;
  if (port === undefined) {
    port = DEFAULTS.port;
  } else if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push(`dsh.port must be an integer in 0..65535, got ${JSON.stringify(raw.port)}`);
    port = DEFAULTS.port;
  }

  const autoStart = typeof raw.autoStart === 'boolean' ? raw.autoStart : DEFAULTS.autoStart;
  const stopOnExit = typeof raw.stopOnExit === 'boolean' ? raw.stopOnExit : DEFAULTS.stopOnExit;
  const extraArgs = Array.isArray(raw.extraArgs)
    ? raw.extraArgs.filter((a): a is string => typeof a === 'string')
    : DEFAULTS.extraArgs;

  return { config: { host, port, autoStart, stopOnExit, extraArgs }, errors };
}

/** 从 VS Code 设置读取（薄封装，供 extension.ts 使用） */
export function readConfig(): { config: DshConfig; errors: string[] } {
  const ws = vscode.workspace.getConfiguration('dsh');
  return normalizeConfig({
    host: ws.get<string>('host'),
    port: ws.get<number>('port'),
    autoStart: ws.get<boolean>('autoStart'),
    stopOnExit: ws.get<boolean>('stopOnExit'),
    extraArgs: ws.get<string[]>('extraArgs'),
  });
}
```

- [ ] **Step 3.5: 创建测试用 vscode 桩并给测试构建加别名**

说明：config.ts 顶层 `import * as vscode from 'vscode'`，而单测跑在 node --test 里没有 VS Code 宿主，测试打包必须把 `vscode` 解析到本地桩（扩展构建仍 external vscode，不受影响）。单测只覆盖纯函数，桩只需最小形状。

创建 `test/vscode-stub.ts`：

```ts
// test/vscode-stub.ts — 测试专用的 vscode 运行时桩
// 测试环境（node --test）没有 VS Code 宿主，config.ts 顶层 `import * as vscode`
// 需要在本模块作用域内解析。这里只提供一个最小可用对象，
// 因为单测只覆盖 normalizeConfig / isLoopbackHost 等纯函数，
// 不会真正调用 readConfig 里的 vscode.workspace.getConfiguration。
export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
  }),
};

export default { workspace };
```

修改 `scripts/build.mjs` 的 tests 配置块，增加 alias（`join` 已从 node:path 导入）：

```js
const tests = {
  entryPoints: testEntries,
  outdir: 'out/test',
  // 测试环境没有 VS Code 宿主，用本地桩替代 vscode 模块，
  // 使 config.ts 等引用 vscode 的模块可被 node --test 加载。
  alias: { vscode: join(process.cwd(), 'test/vscode-stub.ts') },
  ...common,
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS（i18n 4 个 + config 6 个）。

### Task 4: 端口探测模块

**Files:**
- Create: `src/service/detect.ts`
- Test: `test/detect.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export type ProbeResult = 'dsh' | 'foreign' | 'down'`
  - `export async function probeService(host: string, port: number, timeoutMs?: number, fetchImpl?: typeof fetch): Promise<ProbeResult>`
  - 识别依据：首页 HTML 内联 `window.__DSH_BOOT__`（已实测确认），响应 200 且含该标记 → `dsh`；响应 200 但无标记 → `foreign`；连接失败/超时 → `down`。

- [ ] **Step 1: 编写失败测试 test/detect.test.ts**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL——构建阶段报 `Could not resolve "../src/service/detect"`。

- [ ] **Step 3: 编写最小实现 src/service/detect.ts**

```ts
// src/service/detect.ts — 端口探测：判断目标地址上是否运行着 DSH web 服务
// 纯模块：不依赖 vscode，可用 node:test 直接单测。

/** 探测结果 */
export type ProbeResult = 'dsh' | 'foreign' | 'down';

/** DSH 首页的稳定识别特征（首页 HTML 内联了 window.__DSH_BOOT__ 启动数据，已实测确认） */
const DSH_MARKER = '__DSH_BOOT__';

/**
 * 探测 host:port 上运行的服务：
 * - 200 且首页含 DSH 标记 → 'dsh'
 * - 有 HTTP 响应但不是 DSH → 'foreign'（端口被其他程序占用）
 * - 连接失败/超时/拒绝 → 'down'（视为未运行）
 */
export async function probeService(
  host: string,
  port: number,
  timeoutMs = 3000,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${host}:${port}/`, {
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!res.ok) return 'foreign';
    const body = await res.text();
    return body.includes(DSH_MARKER) ? 'dsh' : 'foreign';
  } catch {
    // 网络错误 / 超时中断：一律视为未运行
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS（此前 10 个 + detect 4 个）。

---

### Task 5: 子进程封装模块

**Files:**
- Create: `src/service/process.ts`
- Test: `test/process.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface ChildProcessLike`（最小子进程接口：pid / stdout / stderr / on('exit'|'error') / kill）
  - `export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcessLike`
  - `export interface StartOptions { host: string; port: number; extraArgs: string[] }`
  - `export interface ProcessRunner { startDsh(opts: StartOptions): ChildProcessLike; stopChild(child: ChildProcessLike): Promise<void>; lastChild: ChildProcessLike | null }`
  - `export function createProcessRunner(spawnImpl?: SpawnFn, platform?: string, graceMs?: number): ProcessRunner`
  - 行为：Linux/macOS 用 `dsh` 且 `detached: true`；Windows 用 `dsh.cmd` 且不 detached；参数固定为 `['web', '--host', host, '--port', String(port), ...extraArgs]`；`stopChild` 先 SIGTERM，等待 graceMs（默认 3000）后 SIGKILL；`lastChild` 是测试钩子。

- [ ] **Step 1: 编写失败测试 test/process.test.ts**

```ts
// test/process.test.ts — 子进程封装的单元测试（注入假 spawn）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessRunner, type ChildProcessLike, type SpawnFn } from '../src/service/process';

/** 假子进程：记录 kill 调用、可手动触发 exit/error 事件 */
class FakeChild implements ChildProcessLike {
  pid = 1234;
  killed: string[] = [];
  exitCbs: ((code: number | null) => void)[] = [];
  errorCbs: ((err: Error) => void)[] = [];
  stdout = { on: (_e: 'data', _cb: (chunk: Buffer) => void) => {} };
  stderr = { on: (_e: 'data', _cb: (chunk: Buffer) => void) => {} };
  on(event: 'exit' | 'error', cb: (...args: never[]) => void): void {
    if (event === 'exit') this.exitCbs.push(cb as (code: number | null) => void);
    else this.errorCbs.push(cb as (err: Error) => void);
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
  emitExit(code: number | null = null): void {
    for (const cb of [...this.exitCbs]) cb(code);
  }
}

test('Linux/macOS：命令为 dsh，detached 为 true，参数顺序正确', () => {
  const calls: { cmd: string; args: string[]; opts: { detached?: boolean } }[] = [];
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return new FakeChild();
  };
  const runner = createProcessRunner(spawnImpl, 'linux');
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: ['--trusted-host', 'x:1'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'dsh');
  assert.deepEqual(calls[0].args, ['web', '--host', '127.0.0.1', '--port', '3080', '--trusted-host', 'x:1']);
  assert.equal(calls[0].opts.detached, true);
});

test('Windows：命令为 dsh.cmd，detached 为 false', () => {
  const calls: { cmd: string; args: string[]; opts: { detached?: boolean } }[] = [];
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return new FakeChild();
  };
  const runner = createProcessRunner(spawnImpl, 'win32');
  runner.startDsh({ host: '127.0.0.1', port: 0, extraArgs: [] });
  assert.equal(calls[0].cmd, 'dsh.cmd');
  assert.equal(calls[0].opts.detached, false);
});

test('stopChild 先发 SIGTERM，graceMs 后补 SIGKILL', async () => {
  const child = new FakeChild();
  const runner = createProcessRunner(undefined, 'linux', 20); // 缩短宽限期便于测试
  await runner.stopChild(child);
  assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL']);
});

test('lastChild 记录最近一次启动的子进程（测试钩子）', () => {
  const runner = createProcessRunner(() => new FakeChild(), 'linux');
  const child = runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  assert.equal(runner.lastChild, child);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL——构建阶段报 `Could not resolve "../src/service/process"`。

- [ ] **Step 3: 编写最小实现 src/service/process.ts**

```ts
// src/service/process.ts — dsh web 子进程封装（跨平台）
// 纯模块：spawn 通过参数注入，便于单测；不依赖 vscode。
import { spawn, type SpawnOptions } from 'node:child_process';

/** 最小子进程接口（真实 ChildProcess 结构上兼容，测试可注入假实现） */
export interface ChildProcessLike {
  pid?: number;
  stdout?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** spawn 函数签名（便于注入假实现） */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;

/** 启动参数 */
export interface StartOptions {
  host: string;
  port: number;
  extraArgs: string[];
}

/** 进程管理接口 */
export interface ProcessRunner {
  /** 启动 dsh web 子进程（命令名按平台选择） */
  startDsh(opts: StartOptions): ChildProcessLike;
  /** 优雅停止：先 SIGTERM，宽限期后 SIGKILL */
  stopChild(child: ChildProcessLike): Promise<void>;
  /** 最近一次启动的子进程（测试钩子；生产代码可忽略） */
  lastChild: ChildProcessLike | null;
}

/**
 * 创建进程管理器。
 * @param spawnImpl 注入的 spawn（默认 node:child_process.spawn）
 * @param platform  平台名（默认 process.platform）
 * @param graceMs   SIGTERM 到 SIGKILL 的宽限期（默认 3000）
 */
export function createProcessRunner(
  spawnImpl: SpawnFn = spawn as unknown as SpawnFn,
  platform: string = process.platform,
  graceMs = 3000,
): ProcessRunner {
  let lastChild: ChildProcessLike | null = null;

  return {
    startDsh({ host, port, extraArgs }) {
      // Windows 的可执行命令是 dsh.cmd；其他平台直接 dsh
      const command = platform === 'win32' ? 'dsh.cmd' : 'dsh';
      const args = ['web', '--host', host, '--port', String(port), ...extraArgs];
      const child = spawnImpl(command, args, {
        // POSIX 下脱离父进程组；Windows 不 detached（由父进程退出钩子负责清理）
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      lastChild = child;
      return child;
    },

    async stopChild(child) {
      if (child.pid === undefined) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, graceMs));
      child.kill('SIGKILL');
    },

    get lastChild() {
      return lastChild;
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS（此前 14 个 + process 4 个）。

---

### Task 6: 服务管理器状态机（核心）

**Files:**
- Create: `src/service/manager.ts`
- Test: `test/manager.test.ts`

**Interfaces:**
- Consumes:
  - `probeService(host, port, timeoutMs?) → Promise<ProbeResult>`（Task 4）
  - `ProcessRunner`（Task 5）
  - `MsgKey`（Task 2，仅类型导入）
- Produces（后续任务依赖的精确签名）：
  - `export type ServiceState = 'idle' | 'detecting' | 'starting' | 'waiting' | 'ready' | 'failed' | 'stopping'`
  - `export interface ServiceSnapshot { state: ServiceState; url: string | null; error: MsgKey | null; errorVars?: Record<string, string | number>; owned: boolean }`
  - `export interface ManagerOptions { host: string; port: number; extraArgs: string[]; autoStart: boolean; timeoutMs: number; pollMs: number }`
  - `export interface ManagerDeps { probeService: typeof probeService; processRunner: ProcessRunner; log: (line: string) => void; startTimeoutMs?: number }`
  - `export class ServiceManager`：构造 `(opts: ManagerOptions, deps: ManagerDeps)`
    - `getSnapshot(): ServiceSnapshot`
    - `getTarget(): { host: string; port: number }`
    - `onChange(cb: (s: ServiceSnapshot) => void): () => void`
    - `ensureRunning(): Promise<ServiceSnapshot>`（幂等：进行中/已就绪直接复用）
    - `restart(): Promise<ServiceSnapshot>`
    - `stop(): Promise<void>`（只停插件自启的服务）
    - `reconfigure(opts: ManagerOptions): Promise<ServiceSnapshot>`
    - `setExitBehavior(keepAlive: boolean): void`（stopOnExit=false 时移除父进程退出杀子钩子）
    - `dispose(): void`
  - 状态机（规格第 5.1 节）：`idle → detecting → (dsh→ready | foreign→failed err.portOccupied | down+autoStart=false→failed err.notRunning | down→starting→waiting→(ready(owned=true) | failed err.startTimeout | failed err.startCrashed))`；`stop → stopping → idle`；ready 后子进程意外退出 → idle（面板据此显示"已断开"）。

- [ ] **Step 1: 编写失败测试 test/manager.test.ts**

```ts
// test/manager.test.ts — 服务管理器状态机的单元测试（假探测 + 假子进程）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceManager, type ManagerDeps } from '../src/service/manager';
import type { ProbeResult } from '../src/service/detect';
import type { ChildProcessLike, ProcessRunner } from '../src/service/process';

/** 假子进程（同 process.test.ts 的 FakeChild） */
class FakeChild implements ChildProcessLike {
  pid = 1234;
  killed: string[] = [];
  exitCbs: ((code: number | null) => void)[] = [];
  errorCbs: ((err: Error) => void)[] = [];
  stdout = { on: (_e: 'data', _cb: (chunk: Buffer) => void) => {} };
  stderr = { on: (_e: 'data', _cb: (chunk: Buffer) => void) => {} };
  on(event: 'exit' | 'error', cb: (...args: never[]) => void): void {
    if (event === 'exit') this.exitCbs.push(cb as (code: number | null) => void);
    else this.errorCbs.push(cb as (err: Error) => void);
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
  emitExit(code: number | null = null): void {
    for (const cb of [...this.exitCbs]) cb(code);
  }
}

interface Harness {
  manager: ServiceManager;
  probeQueue: ProbeResult[];   // 探测结果队列，取完后循环最后一个
  child: FakeChild | null;
  spawnCount: number;
  states: string[];            // 记录状态变化序列
}

function makeHarness(opts?: Partial<Parameters<ServiceManager['reconfigure']>[0]>, depsOpts?: Partial<ManagerDeps>): Harness {
  const h: Harness = {
    manager: null as unknown as ServiceManager,
    probeQueue: [],
    child: null,
    spawnCount: 0,
    states: [],
  };
  const probeService = async (_host: string, _port: number): Promise<ProbeResult> => {
    return h.probeQueue.length > 1 ? h.probeQueue.shift()! : h.probeQueue[0];
  };
  const processRunner: ProcessRunner = {
    startDsh: () => {
      h.spawnCount += 1;
      h.child = new FakeChild();
      return h.child;
    },
    stopChild: async (c) => {
      c.kill('SIGTERM');
      c.kill('SIGKILL');
    },
    lastChild: null,
  };
  h.manager = new ServiceManager(
    {
      host: '127.0.0.1', port: 3080, extraArgs: [], autoStart: true,
      timeoutMs: 100, pollMs: 5, ...opts,
    },
    { probeService, processRunner, log: () => {}, startTimeoutMs: 50, ...depsOpts },
  );
  h.manager.onChange((s) => h.states.push(s.state));
  return h;
}

test('探测到 dsh：直接复用（owned=false），不启动子进程', async () => {
  const h = makeHarness();
  h.probeQueue = ['dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false);
  assert.equal(s.url, 'http://127.0.0.1:3080/');
  assert.equal(h.spawnCount, 0);
  assert.deepEqual(h.states, ['detecting', 'ready']);
  h.manager.dispose();
});

test('探测到外来服务：failed + err.portOccupied', async () => {
  const h = makeHarness();
  h.probeQueue = ['foreign'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.portOccupied');
  assert.equal(h.spawnCount, 0);
  h.manager.dispose();
});

test('服务未运行且 autoStart=false：failed + err.notRunning', async () => {
  const h = makeHarness({ autoStart: false });
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.notRunning');
  assert.equal(h.spawnCount, 0);
  h.manager.dispose();
});

test('自动启动成功：down,down,dsh → ready(owned=true)，状态序列正确', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.equal(h.spawnCount, 1);
  assert.deepEqual(h.states, ['detecting', 'starting', 'waiting', 'ready']);
  h.manager.dispose();
});

test('启动超时：failed + err.startTimeout', async () => {
  const h = makeHarness();
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.startTimeout');
  assert.equal(s.errorVars?.seconds, 0); // startTimeoutMs=50 → round(50/1000)=0（真实环境为 15 秒）
  h.manager.dispose();
});

test('等待中子进程退出：failed + err.startCrashed', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning();
  // 第一次探测后子进程已 spawn，模拟崩溃
  await new Promise((r) => setTimeout(r, 1));
  h.child?.emitExit(1);
  const s = await p;
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.startCrashed');
  h.manager.dispose();
});

test('ready 后子进程意外退出：回到 idle（面板据此显示已断开）', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  h.child?.emitExit(1);
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.equal(h.manager.getSnapshot().url, null);
  h.manager.dispose();
});

test('spawn 报 ENOENT：failed + err.dshNotFound（不空等超时）', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  // 模拟 dsh 命令不存在
  const err = Object.assign(new Error('spawn dsh ENOENT'), { code: 'ENOENT' });
  for (const cb of h.child!.errorCbs) cb(err);
  const s = await p;
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.dshNotFound');
  h.manager.dispose();
});

test('stop() 只停插件自启的子进程', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  await h.manager.stop();
  assert.deepEqual(h.child!.killed, ['SIGTERM', 'SIGKILL']);
  assert.equal(h.manager.getSnapshot().state, 'idle');
  h.manager.dispose();
});

test('复用外部服务时 stop() 不杀任何进程', async () => {
  const h = makeHarness();
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  await h.manager.stop();
  assert.equal(h.spawnCount, 0);
  assert.equal(h.manager.getSnapshot().state, 'idle');
  h.manager.dispose();
});

test('ensureRunning 并发幂等：只 spawn 一次', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  const [a, b] = await Promise.all([h.manager.ensureRunning(), h.manager.ensureRunning()]);
  assert.equal(a.state, 'ready');
  assert.equal(b.state, 'ready');
  assert.equal(h.spawnCount, 1);
  h.manager.dispose();
});

test('reconfigure 换端口：自启服务先停再按新端口启动', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  const oldChild = h.child!; // 捕获旧子进程引用（reconfigure 重启后 h.child 会指向新子进程）
  h.probeQueue = ['down', 'dsh'];
  const s = await h.manager.reconfigure({
    host: '127.0.0.1', port: 4000, extraArgs: [], autoStart: true, timeoutMs: 100, pollMs: 5,
  });
  assert.equal(s.state, 'ready');
  assert.ok(oldChild.killed.length > 0); // 旧服务确实被停止（SIGTERM+SIGKILL）
  assert.equal(h.manager.getTarget().port, 4000);
  h.manager.dispose();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL——构建阶段报 `Could not resolve "../src/service/manager"`。

- [ ] **Step 3: 编写最小实现 src/service/manager.ts**

```ts
// src/service/manager.ts — 服务管理器：状态机编排探测/启动/等待/停止
// 纯模块：不依赖 vscode；探测与进程管理均通过依赖注入，便于单测。
import type { ProbeResult } from './detect';
import type { ChildProcessLike, ProcessRunner } from './process';
import type { MsgKey } from '../i18n';

/** 服务状态 */
export type ServiceState = 'idle' | 'detecting' | 'starting' | 'waiting' | 'ready' | 'failed' | 'stopping';

/** 对外发布的状态快照（不可变副本） */
export interface ServiceSnapshot {
  state: ServiceState;
  /** 就绪后的网页地址（http://host:port/） */
  url: string | null;
  /** 失败原因（i18n 键，由面板/状态栏负责翻译） */
  error: MsgKey | null;
  /** 错误文案的 {变量} 值 */
  errorVars?: Record<string, string | number>;
  /** 当前就绪的服务是否由插件启动（决定 stop 时是否可杀） */
  owned: boolean;
}

/** 管理器配置 */
export interface ManagerOptions {
  host: string;
  port: number;
  extraArgs: string[];
  autoStart: boolean;
  /** 单次探测超时（毫秒） */
  timeoutMs: number;
  /** 等待就绪的轮询间隔（毫秒） */
  pollMs: number;
}

/** 注入依赖 */
export interface ManagerDeps {
  probeService: (host: string, port: number, timeoutMs?: number) => Promise<ProbeResult>;
  processRunner: ProcessRunner;
  /** 日志出口（扩展里接到 Output Channel） */
  log: (line: string) => void;
  /** 启动总超时（毫秒，默认 15000） */
  startTimeoutMs?: number;
}

/** 启动总超时默认值（毫秒） */
const DEFAULT_START_TIMEOUT_MS = 15000;

export class ServiceManager {
  private snapshot: ServiceSnapshot = { state: 'idle', url: null, error: null, owned: false };
  private listeners = new Set<(s: ServiceSnapshot) => void>();
  /** 进行中的启动/重启流程（防并发，幂等复用） */
  private op: Promise<ServiceSnapshot> | null = null;
  /** 插件自己启动的子进程（复用外部服务时为 null） */
  private child: ChildProcessLike | null = null;
  private disposed = false;
  /** 父进程退出时杀掉子进程，防止僵尸（stopOnExit=false 时移除） */
  private parentExitHook = (): void => {
    try {
      this.child?.kill('SIGKILL');
    } catch {
      /* 进程可能已退出，忽略 */
    }
  };

  constructor(private opts: ManagerOptions, private deps: ManagerDeps) {
    process.once('exit', this.parentExitHook);
  }

  /** 当前状态快照（副本，防外部篡改） */
  getSnapshot(): ServiceSnapshot {
    return { ...this.snapshot };
  }

  /** 当前目标地址（面板生成 CSP frame-src 用） */
  getTarget(): { host: string; port: number } {
    return { host: this.opts.host, port: this.opts.port };
  }

  /** 订阅状态变化，返回退订函数 */
  onChange(cb: (s: ServiceSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 更新内部状态并广播 */
  private set(partial: Partial<ServiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const cb of this.listeners) cb(this.getSnapshot());
  }

  /** 网页地址 */
  private url(): string {
    return `http://${this.opts.host}:${this.opts.port}/`;
  }

  /** 确保服务就绪：复用已有 / 自动启动（幂等：并发调用共享同一次流程） */
  ensureRunning(): Promise<ServiceSnapshot> {
    if (this.op) return this.op;
    if (this.snapshot.state === 'ready') return Promise.resolve(this.getSnapshot());
    this.op = this.doStart().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 重启：停掉自己启动的服务后重新走启动流程 */
  restart(): Promise<ServiceSnapshot> {
    if (this.op) return this.op;
    this.op = (async () => {
      await this.stopOwned();
      return this.doStart();
    })().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 停止：仅停止插件自己启动的服务；手动启动的永不干预 */
  async stop(): Promise<void> {
    if (this.op) return; // 启动流程进行中不打断
    await this.stopOwned();
  }

  /** 停掉自启子进程并回到 idle */
  private async stopOwned(): Promise<void> {
    if (!this.child) {
      this.set({ state: 'idle', url: null, owned: false, error: null });
      return;
    }
    this.set({ state: 'stopping' });
    const child = this.child;
    this.child = null;
    try {
      await this.deps.processRunner.stopChild(child);
    } catch (err) {
      this.deps.log(`[process] 停止子进程失败: ${String(err)}`);
    }
    this.set({ state: 'idle', url: null, owned: false, error: null });
  }

  /** 完整启动流程：探测 → 复用 / 启动 → 等待就绪 */
  private async doStart(): Promise<ServiceSnapshot> {
    this.set({ state: 'detecting', error: null });
    const probe = await this.deps.probeService(this.opts.host, this.opts.port, this.opts.timeoutMs);
    if (probe === 'dsh') {
      // 已有服务在跑：直接复用
      this.set({ state: 'ready', url: this.url(), owned: false });
      return this.getSnapshot();
    }
    if (probe === 'foreign') {
      // 端口被其他程序占用：提示换端口，绝不杀他人进程
      this.set({ state: 'failed', error: 'err.portOccupied', errorVars: { port: this.opts.port } });
      return this.getSnapshot();
    }
    if (!this.opts.autoStart) {
      this.set({ state: 'failed', error: 'err.notRunning' });
      return this.getSnapshot();
    }

    // 启动子进程
    this.set({ state: 'starting' });
    let child: ChildProcessLike;
    try {
      child = this.deps.processRunner.startDsh({
        host: this.opts.host,
        port: this.opts.port,
        extraArgs: this.opts.extraArgs,
      });
    } catch (err) {
      this.deps.log(`[process] 启动失败: ${String(err)}`);
      this.set({ state: 'failed', error: 'err.dshNotFound' });
      return this.getSnapshot();
    }
    this.child = child;

    // spawn 的 ENOENT 通过 'error' 事件异步到达，用标志位让等待循环立即失败
    let spawnFailed = false;
    // 等待阶段子进程退出的标志（等待循环据此判定 err.startCrashed）
    let childExited = false;
    child.on('error', (err) => {
      this.deps.log(`[process] ${err.message}`);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        spawnFailed = true;
        this.set({ state: 'failed', error: 'err.dshNotFound' });
      }
    });
    child.on('exit', () => {
      childExited = true;
      this.handleUnexpectedExit(child);
    });
    child.stdout?.on('data', (chunk) => this.deps.log(`[stdout] ${chunk.toString().trimEnd()}`));
    child.stderr?.on('data', (chunk) => this.deps.log(`[stderr] ${chunk.toString().trimEnd()}`));

    // 等待就绪：轮询探测直到 ready / 子进程退出 / 超时
    this.set({ state: 'waiting' });
    const startTimeoutMs = this.deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      if (spawnFailed) return this.getSnapshot(); // 已置为 failed（err.dshNotFound）
      if (childExited) {
        // 子进程没撑到就绪就退出：判定为启动崩溃
        this.child = null;
        this.set({ state: 'failed', error: 'err.startCrashed' });
        return this.getSnapshot();
      }
      const result = await this.deps.probeService(this.opts.host, this.opts.port, this.opts.timeoutMs);
      if (result === 'dsh') {
        this.set({ state: 'ready', url: this.url(), owned: true });
        return this.getSnapshot();
      }
      // 'foreign' 表示子进程没能绑定端口（被占）——继续等待会让用户困惑，
      // 但可能只是服务尚未就绪的瞬间，保守起见继续轮询直到超时。
      if (Date.now() >= deadline) {
        this.set({
          state: 'failed',
          error: 'err.startTimeout',
          errorVars: { seconds: Math.round(startTimeoutMs / 1000) },
        });
        return this.getSnapshot();
      }
      await new Promise((r) => setTimeout(r, this.opts.pollMs));
    }
  }

  /** 就绪状态下子进程意外退出：回到 idle（面板据此显示"已断开"） */
  private handleUnexpectedExit(child: ChildProcessLike): void {
    if (this.child !== child) return; // 已被 stopOwned 接管或已替换
    this.child = null;
    if (this.snapshot.state === 'ready') {
      this.set({ state: 'idle', url: null, owned: false, error: null });
    }
  }

  /** 应用新配置；仅 host/port 变化且自启服务在跑时自动重启（其余项原地生效） */
  reconfigure(opts: ManagerOptions): Promise<ServiceSnapshot> {
    const targetChanged = this.opts.host !== opts.host || this.opts.port !== opts.port;
    this.opts = opts;
    if (targetChanged) {
      if (this.child) return this.restart();
      // 复用外部服务时只更新地址展示，实际可达性由下次 ensureRunning 重新探测
      if (this.snapshot.state === 'ready') this.set({ url: this.url() });
    }
    return Promise.resolve(this.getSnapshot());
  }

  /** stopOnExit=false 时保持服务运行：移除父进程退出杀子钩子 */
  setExitBehavior(keepAlive: boolean): void {
    if (keepAlive) {
      process.removeListener('exit', this.parentExitHook);
    } else if (!process.listeners('exit').includes(this.parentExitHook)) {
      process.once('exit', this.parentExitHook);
    }
  }

  /** 清理：移除钩子与监听器（不杀子进程，停止由 stop() 决定） */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    process.removeListener('exit', this.parentExitHook);
    this.listeners.clear();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS（此前 18 个 + manager 12 个）。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无类型错误。

---

### Task 7: 真实 dsh 集成测试

**Files:**
- Create: `test/integration/dsh.test.ts`

**Interfaces:**
- Consumes: `probeService`（Task 4）、`createProcessRunner`（Task 5）、`ServiceManager`（Task 6）
- Produces: 无新接口（验证既有接口在真实 dsh 下工作）

- [ ] **Step 1: 编写集成测试 test/integration/dsh.test.ts**

```ts
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
```

- [ ] **Step 2: 运行集成测试确认通过**

Run: `npm test`
Expected: 集成测试 PASS（本机已装 dsh）。若当前 3080 有运行中的 DSH 服务不受影响——测试用的是随机端口。

- [ ] **Step 3: 确认无残留进程**

Run: `pgrep -af 'dsh web' || echo '无残留 dsh web 进程'`
Expected: 无测试残留的 `dsh web` 进程（用户原有服务除外——本测试不使用 3080，应无影响）。

### Task 8: 面板占位页模板

**Files:**
- Create: `src/panel/html.ts`
- Test: `test/html.test.ts`

**Interfaces:**
- Consumes: `MsgKey`（Task 2，仅类型）
- Produces:
  - `export type T = (key: MsgKey, vars?: Record<string, string | number>) => string`
  - `export type PanelMessage = { type: 'retry' | 'reconnect' | 'openExternal' | 'restart' | 'stop' | 'copyUrl' | 'showLogs' }`（面板内按钮 → postMessage 载荷）
  - `export interface PageCtx { nonce: string; cspSource: string; frameHosts: string[] }`
  - `export function loadingPage(t: T, ctx: PageCtx): string`
  - `export function errorPage(t: T, ctx: PageCtx, message: string): string`（含"重试""查看日志"按钮）
  - `export function disconnectedPage(t: T, ctx: PageCtx): string`（服务断开，含"重新连接"按钮）
  - `export function stoppedPage(t: T, ctx: PageCtx): string`（手动停止）
  - `export function readyPage(url: string, ctx: PageCtx): string`（全屏 iframe，无 sandbox 属性）
  - 所有页面带 CSP：`default-src 'none'` + `frame-src <frameHosts>` + `script-src 'nonce-…'`（按钮脚本用 nonce 内联）。

- [ ] **Step 1: 编写失败测试 test/html.test.ts**

```ts
// test/html.test.ts — 面板占位页模板的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initI18n, t } from '../src/i18n';
import { loadingPage, errorPage, disconnectedPage, stoppedPage, readyPage, type PageCtx } from '../src/panel/html';

function ctx(): PageCtx {
  return { nonce: 'abc123', cspSource: 'vscode-webview:', frameHosts: ['http://127.0.0.1:3080'] };
}

test('loadingPage 包含加载动画与本地化文案', () => {
  initI18n('zh-cn');
  const html = loadingPage(t, ctx());
  assert.ok(html.includes('spinner'));
  assert.ok(html.includes(t('panel.loading')));
});

test('errorPage 包含重试按钮并转义消息中的 HTML', () => {
  initI18n('en');
  const html = errorPage(t, ctx(), '<script>alert(1)</script>');
  assert.ok(html.includes('data-action="retry"'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('disconnectedPage 与 stoppedPage 都包含重连按钮', () => {
  const d = disconnectedPage(t, ctx());
  const s = stoppedPage(t, ctx());
  assert.ok(d.includes('data-action="reconnect"'));
  assert.ok(s.includes('data-action="reconnect"'));
});

test('readyPage 包含目标地址 iframe 且无 sandbox 属性', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(html.includes('<iframe class="frame" src="http://127.0.0.1:3080/"></iframe>'));
  assert.ok(!html.includes('sandbox'));
});

test('CSP 声明 frame-src 与 script-src nonce', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(html.includes('frame-src http://127.0.0.1:3080'));
  assert.ok(html.includes("script-src 'nonce-abc123'"));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL——构建阶段报 `Could not resolve "../src/panel/html"`。

- [ ] **Step 3: 编写最小实现 src/panel/html.ts**

```ts
// src/panel/html.ts — 面板占位页模板（纯函数、无逻辑、不依赖 vscode）
import type { MsgKey } from '../i18n';

/** 翻译函数签名（把 i18n.t 传入模板） */
export type T = (key: MsgKey, vars?: Record<string, string | number>) => string;

/** 面板内按钮发回扩展的消息类型 */
export type PanelMessage =
  | { type: 'retry' }
  | { type: 'reconnect' }
  | { type: 'openExternal' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'copyUrl' }
  | { type: 'showLogs' };

/** 渲染上下文 */
export interface PageCtx {
  /** 内联脚本的 CSP nonce */
  nonce: string;
  /** webview.cspSource（本地资源来源） */
  cspSource: string;
  /** 允许加载 iframe 的目标地址（DSH 服务地址） */
  frameHosts: string[];
}

/** CSP：最小权限——只放行目标 iframe 与带 nonce 的内联脚本 */
function csp(ctx: PageCtx): string {
  return [
    "default-src 'none'",
    `frame-src ${ctx.frameHosts.join(' ')}`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${ctx.nonce}'`,
    `img-src ${ctx.cspSource} data:`,
  ].join('; ');
}

/** 通用样式（使用 VS Code 主题变量，自动适配浅色/深色主题） */
const STYLE = `
body { margin: 0; padding: 0; height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
body.frame-body { display: block; }
.center { text-align: center; max-width: 90%; }
p { margin: 8px 0 16px; opacity: 0.9; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; margin: 4px; cursor: pointer; border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground); }
.spinner { width: 28px; height: 28px; border: 3px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; margin: 0 auto 12px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
iframe.frame { position: fixed; inset: 0; width: 100%; height: 100%; border: none; }
`;

/** 按钮点击 → postMessage 的内联脚本（nonce 放行） */
const BUTTON_SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  vscode.postMessage({ type: btn.dataset.action });
});
`;

/** HTML 转义（防御性，消息来自 i18n 但转义不费事） */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 页面外壳 */
function shell(ctx: PageCtx, title: string, bodyClass: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(ctx)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body class="${bodyClass}">${body}
<script nonce="${ctx.nonce}">${BUTTON_SCRIPT}</script>
</body>
</html>`;
}

/** 加载中占位页 */
export function loadingPage(t: T, ctx: PageCtx): string {
  return shell(ctx, t('panel.loading'), '', `<div class="center"><div class="spinner"></div><p>${t('panel.loading')}</p></div>`);
}

/** 启动失败占位页：原因 + 重试 + 查看日志 */
export function errorPage(t: T, ctx: PageCtx, message: string): string {
  return shell(
    ctx,
    t('panel.errorTitle'),
    '',
    `<div class="center"><p>${t('panel.errorTitle')}</p><p>${escapeHtml(message)}</p>
<button data-action="retry">${t('panel.retry')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 服务断开占位页：重连 + 查看日志 */
export function disconnectedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('panel.disconnectedTitle'),
    '',
    `<div class="center"><p>${t('panel.disconnectedTitle')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 手动停止后的占位页 */
export function stoppedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('status.stopped'),
    '',
    `<div class="center"><p>${t('status.stopped')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button></div>`,
  );
}

/** 就绪页：全屏 iframe 加载真实 DSH 网页（无 sandbox，避免破坏页面自身功能） */
export function readyPage(url: string, ctx: PageCtx): string {
  return shell(ctx, 'DSH', 'frame-body', `<iframe class="frame" src="${url}"></iframe>`);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS（此前 30 个 + html 5 个）。

---

### Task 9: 侧边栏面板 Provider

**Files:**
- Create: `src/panel/provider.ts`

**Interfaces:**
- Consumes: `ServiceManager`（Task 6）、`t`/`MsgKey`（Task 2）、html 模板（Task 8）
- Produces: `export class DshPanelProvider implements vscode.WebviewViewProvider`，构造 `(manager: ServiceManager)`；`resolveWebviewView(view)` 中设置 `enableScripts: true`、订阅消息、首次打开时 `ensureRunning()`、按快照渲染四类页面。注意：`retainContextWhenHidden` 不是 `WebviewOptions` 字段，**不能**写在 `view.webview.options` 里（写了也会被忽略且 typecheck 报错）；它由 Task 10 在 `registerWebviewViewProvider` 的第三参数 `{ webviewOptions: { retainContextWhenHidden: true } }` 传入。

- [ ] **Step 1: 编写实现 src/panel/provider.ts（本任务无单测，属 vscode 依赖层，验证在 Task 11 人工验收）**

```ts
// src/panel/provider.ts — 侧边栏面板：iframe 与占位页切换
import * as vscode from 'vscode';
import { ServiceManager } from '../service/manager';
import { t } from '../i18n';
import {
  loadingPage,
  errorPage,
  disconnectedPage,
  stoppedPage,
  readyPage,
  type PanelMessage,
  type PageCtx,
} from './html';

export class DshPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  /** 曾处于 ready：用于区分"服务断开"与"手动停止"两种占位页 */
  private wasConnected = false;

  constructor(private manager: ServiceManager) {
    // 订阅状态变化，重绘面板（iframe 与占位页由状态驱动，无白屏路径）
    manager.onChange(() => this.render());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // enableScripts 允许占位页的内联按钮脚本（nonce 放行）运行。
    // 注意：retainContextWhenHidden 不在这里设置——它不是 WebviewOptions 字段，
    // 由 Task 10 注册视图时通过第三参数传入（隐藏面板时保留 iframe 会话）。
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: PanelMessage) => this.onMessage(msg));
    this.render();
    // 面板打开即确保服务运行：复用已有或自动启动
    void this.manager.ensureRunning();
  }

  /** 处理面板内按钮消息（全部转交给 manager 或对应命令） */
  private onMessage(msg: PanelMessage): void {
    switch (msg.type) {
      case 'retry':
      case 'reconnect':
        void this.manager.ensureRunning();
        break;
      case 'restart':
        void this.manager.restart();
        break;
      case 'stop':
        this.wasConnected = false;
        void this.manager.stop();
        break;
      case 'openExternal':
        void vscode.commands.executeCommand('dsh.openExternal');
        break;
      case 'copyUrl':
        void vscode.commands.executeCommand('dsh.copyUrl');
        break;
      case 'showLogs':
        void vscode.commands.executeCommand('dsh.showLogs');
        break;
    }
  }

  /** 按服务状态渲染对应页面 */
  private render(): void {
    const v = this.view;
    if (!v) return;
    const nonce = Math.random().toString(36).slice(2);
    const { host, port } = this.manager.getTarget();
    const ctx: PageCtx = { nonce, cspSource: v.webview.cspSource, frameHosts: [`http://${host}:${port}`] };
    const s = this.manager.getSnapshot();
    let html: string;
    switch (s.state) {
      case 'ready':
        this.wasConnected = true;
        html = readyPage(s.url ?? `http://${host}:${port}/`, ctx);
        break;
      case 'failed':
        html = errorPage(t, ctx, s.error ? t(s.error, s.errorVars) : t('err.loadFailed'));
        break;
      case 'idle':
        html = this.wasConnected ? disconnectedPage(t, ctx) : stoppedPage(t, ctx);
        break;
      default:
        // detecting / starting / waiting / stopping：统一加载中动画页
        html = loadingPage(t, ctx);
    }
    v.webview.html = html;
  }
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 无类型错误。

---

### Task 10: 状态栏 + 入口装配 + 全部命令

**Files:**
- Create: `src/statusbar.ts`
- Modify: `src/extension.ts`（替换占位版）

**Interfaces:**
- Consumes: `ServiceManager`（Task 6）、`DshPanelProvider`（Task 9）、`readConfig`/`DshConfig`（Task 3）、`probeService`/`createProcessRunner`/`initI18n`/`t`
- Produces: `export class StatusBarController`，构造 `(manager: ServiceManager)`；`activate(context)` / `deactivate()` 完整实现；命令 `dsh.openPanel`、`dsh.openSecondary`、`dsh.openExternal`、`dsh.restart`、`dsh.stop`、`dsh.copyUrl`、`dsh.showLogs` 全部注册。

- [ ] **Step 1: 创建 src/statusbar.ts**

```ts
// src/statusbar.ts — 状态栏项：显示服务状态，点击打开面板
import * as vscode from 'vscode';
import { ServiceManager, type ServiceSnapshot } from './service/manager';
import { t } from './i18n';

/** 四种状态的图标 + 文案键 + 颜色主题 ID（绿/黄/红/灰） */
const PRESETS = {
  running: { icon: '$(check)', color: 'charts.green', textKey: 'status.running' },
  starting: { icon: '$(sync~spin)', color: 'charts.yellow', textKey: 'status.starting' },
  failed: { icon: '$(error)', color: 'charts.red', textKey: 'status.failed' },
  stopped: { icon: '$(circle-outline)', color: 'descriptionForeground', textKey: 'status.stopped' },
} as const;

type PresetKey = keyof typeof PRESETS;

export class StatusBarController {
  private item: vscode.StatusBarItem;

  constructor(manager: ServiceManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'dsh.openPanel';
    this.item.show();
    manager.onChange((s) => this.update(s));
    this.update(manager.getSnapshot());
  }

  private update(s: ServiceSnapshot): void {
    const key: PresetKey =
      s.state === 'ready'
        ? 'running'
        : s.state === 'failed'
          ? 'failed'
          : s.state === 'idle'
            ? 'stopped'
            : 'starting';
    const p = PRESETS[key];
    this.item.text = `${p.icon} ${t(p.textKey)}`;
    this.item.color = new vscode.ThemeColor(p.color);
    this.item.tooltip = s.error ? t(s.error, s.errorVars) : '';
  }

  dispose(): void {
    this.item.dispose();
  }
}
```

- [ ] **Step 2: 重写 src/extension.ts（替换占位版）**

```ts
// src/extension.ts — 插件入口：装配各模块、注册命令、监听配置变更
import * as vscode from 'vscode';
import { initI18n, t } from './i18n';
import { readConfig, type DshConfig } from './config';
import { probeService } from './service/detect';
import { createProcessRunner } from './service/process';
import { ServiceManager, type ManagerOptions } from './service/manager';
import { DshPanelProvider } from './panel/provider';
import { StatusBarController } from './statusbar';

let manager: ServiceManager | null = null;
let output: vscode.OutputChannel | null = null;

/** DshConfig → ManagerOptions（探测 3s、轮询 0.5s，与规格一致） */
function toManagerOptions(config: DshConfig): ManagerOptions {
  return {
    host: config.host,
    port: config.port,
    extraArgs: config.extraArgs,
    autoStart: config.autoStart,
    timeoutMs: 3000,
    pollMs: 500,
  };
}

/** 插件激活：VS Code 启动完成后调用 */
export function activate(context: vscode.ExtensionContext): void {
  // 语言规则：vscode.env.language 以 zh- 开头 → 中文，其余一律英文
  initI18n(vscode.env.language);
  output = vscode.window.createOutputChannel('DSH');

  const { config, errors } = readConfig();
  for (const err of errors) output?.appendLine(`[config] ${err}`);

  manager = new ServiceManager(toManagerOptions(config), {
    probeService,
    processRunner: createProcessRunner(),
    log: (line) => output?.appendLine(line),
  });
  manager.setExitBehavior(!config.stopOnExit);

  const panel = new DshPanelProvider(manager);
  new StatusBarController(manager);

  context.subscriptions.push(
    // 第三参数：隐藏面板时保留 webview（iframe 不销毁、DSH 页面会话不丢）
    vscode.window.registerWebviewViewProvider('dsh.panel', panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.openPanel', () => openPanel()),
    vscode.commands.registerCommand('dsh.openSecondary', () => openSecondary(context)),
    vscode.commands.registerCommand('dsh.openExternal', () => openExternal()),
    vscode.commands.registerCommand('dsh.restart', () => void manager?.restart()),
    vscode.commands.registerCommand('dsh.stop', () => void manager?.stop()),
    vscode.commands.registerCommand('dsh.copyUrl', () => copyUrl()),
    vscode.commands.registerCommand('dsh.showLogs', () => output?.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dsh')) onConfigChanged();
    }),
    { dispose: () => manager?.dispose() },
  );
}

/** 打开面板：聚焦视图（VS Code 自动打开视图所在的侧边栏，左/右皆可） */
async function openPanel(): Promise<void> {
  await vscode.commands.executeCommand('dsh.panel.focus');
}

/** 在外部浏览器打开 DSH 页面 */
async function openExternal(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(s.url));
}

/** 复制 DSH 页面地址到剪贴板 */
async function copyUrl(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  await vscode.env.clipboard.writeText(s.url);
  void vscode.window.showInformationMessage(t('info.urlCopied', { url: s.url }));
}

/** 在辅助侧边栏打开：聚焦辅助侧边栏 + 视图 + 一次性移动引导 */
async function openSecondary(context: vscode.ExtensionContext): Promise<void> {
  // 聚焦辅助侧边栏（命令 ID 因 VS Code 版本而异，取存在者）
  const cmds = await vscode.commands.getCommands(true);
  const focusId = cmds.includes('workbench.action.focusSecondarySideBar')
    ? 'workbench.action.focusSecondarySideBar'
    : 'workbench.action.focusAuxiliaryBar';
  await vscode.commands.executeCommand(focusId);
  await vscode.commands.executeCommand('dsh.panel.focus');
  // 一次性引导：教用户把视图固定到右侧（拖动或 Move View），位置永久保持
  const KEY = 'dsh.secondaryGuideShown';
  if (!context.globalState.get(KEY)) {
    await vscode.window.showInformationMessage(t('guide.secondaryText'), t('guide.gotIt'));
    void context.globalState.update(KEY, true);
  }
}

/** 配置变更：host/port 变化时自动重启自启服务，退出策略实时生效 */
function onConfigChanged(): void {
  const m = manager;
  if (!m) return;
  const { config } = readConfig();
  void m.reconfigure(toManagerOptions(config));
  m.setExitBehavior(!config.stopOnExit);
}

/** 插件停用：按 stopOnExit 决定是否停止自启服务（只杀插件自启的） */
export async function deactivate(): Promise<void> {
  const config = readConfig().config;
  if (config.stopOnExit) await manager?.stop();
  manager?.dispose();
}
```

- [ ] **Step 3: 编译与 typecheck**

Run: `npm run compile && npm run typecheck`
Expected: 构建成功、无类型错误。

---

### Task 11: 开发宿主人工验收（11 项清单）

**Files:**
- 无新建文件（此任务为验证与修复循环）

**说明：** 本任务需要 VS Code 图形界面操作。操作者：用本机 VS Code 打开 `/home/fengze233/dsh_vs`，按 F5 启动 Extension Development Host（开发宿主），逐项执行验收清单。每发现一个问题：先复现 → 修复 → 重新编译 → F5 重开开发宿主复验，直到该项通过。

- [ ] **Step 1: 启动开发宿主**

操作：VS Code 打开 `/home/fengze233/dsh_vs` → F5（选择 "Run Extension" 配置，若提示创建 launch.json 则创建：

`.vscode/launch.json`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/out/**/*.js"]
    }
  ]
}
```

（`.vscode/` 目录已加入 .vscodeignore，不会打进 .vsix。）
Expected: 开发宿主窗口打开，活动栏出现 DSH 图标。

- [ ] **Step 2: 逐项验收（对应规格 10.1 清单）**

| # | 验收项 | 操作 | 通过标准 |
|---|---|---|---|
| 1 | 活动栏图标 | 观察活动栏 | DSH 图标可见可点击 |
| 2 | 自动启动+加载 | 点击 DSH 图标 | 15 秒内面板显示 DSH 网页，期间只见加载动画、无白屏 |
| 3 | 复用已有 | 关闭面板→先终端手动 `dsh web`→再点图标 | 直接显示页面，不重复启动（日志无第二次启动记录） |
| 4 | 面板开关不重启 | 关闭面板再打开 | 服务不重启，页面立即显示 |
| 5 | 断开检测+重连 | 终端 `pkill -f "dsh web"` | 面板切"已断开"占位页；点"重新连接"后恢复 |
| 6 | 标题栏按钮 | 面板标题栏 5 个图标逐个点击 | 外部打开/重启/停止/复制网址/查看日志各自正确 |
| 7 | 状态栏四态 | 观察状态栏（运行中绿/启动中黄/失败红/停止灰）；点击状态栏项 | 颜色文字正确；点击可开关面板 |
| 8 | 中英文案 | 命令面板 → "Configure Display Language" 切 zh-cn 与 en（改完需重启窗口） | 图标名、命令名、占位页、状态栏、错误提示全部按规则切换 |
| 9 | 退出清理 | 关闭开发宿主窗口 | `pgrep -af 'dsh web'` 无插件启动的残留进程 |
| 10 | 错误场景 | 设置里把 `dsh.port` 改成一个被占端口（如先起一个 `python3 -m http.server 3999`，再把 dsh.port 设为 3999）点重试；另：临时把 PATH 移除 dsh 再验证"未找到 dsh 命令"提示 | 显示对应错误占位页，不崩溃不白屏；改回设置后恢复正常 |
| 11 | 辅助侧边栏 | 命令面板执行 `DSH: 在辅助侧边栏打开`；按引导把视图拖到右侧；重启开发宿主 | 首次出现引导提示；右侧出现 DSH 图标且点击打开面板；重启后位置保持 |

- [ ] **Step 3: 修复循环**

对每个失败项：定位（优先查 Output Channel "DSH" 日志与开发宿主 Console）→ 修复 → `npm run compile` → F5 重启开发宿主 → 复验该项，直到 11 项全过。

- [ ] **Step 4: 回归**

Run: `npm test`
Expected: 全部单测+集成测试仍 PASS。

- [ ] **Step 5: 清理**

Run: `pgrep -af 'dsh web' && pkill -f 'dsh web'; echo 已清理`
Expected: 测试期启动的 `dsh web` 全部停止（用户手动启动的服务除外——注意：验收 #3 里手动启动的服务不要杀错；以"插件自己启动的"为准）。

---

### Task 12: 打包 .vsix 与干净安装验证

**Files:**
- Create: `.vscode/launch.json`（Task 11 已建，打包时被 .vscodeignore 排除）

- [ ] **Step 0: 清理审查遗留与修复后的死文件**

1. 删除死文件：`assets/icon.svg`（旧方块图标，已无引用）、`assets/whale-badge.svg`（已被鲸鱼剪影替代）：
   `rm -f assets/icon.svg assets/whale-badge.svg`
2. 修正 `src/extension.ts` 中 `showSecondaryGuideOnce` 的 JSDoc 注释，改为与新文案一致：

```ts
/** 一次性引导：告知 DSH 面板可通过左侧活动栏与右侧辅助侧边栏的图标打开 */
```

改完后 `npm run compile && npm run typecheck && npm run test` 确认通过。

- [ ] **Step 1: 确认 .vscodeignore 已排除 SDD 工作区并打包**

`.vscodeignore` 必须包含 `.superpowers/**`（否则 SDD 简报/报告/快照会混进 .vsix，已实测发现过）。确认后再打包。

Run: `grep -q '^\.superpowers/\*\*$' .vscodeignore && npm run package`
Expected: 生成 `dsh-vscode.vsix`。

- [ ] **Step 2: 检查包内容**

Run: `npx vsce ls --tree`
Expected: 包含 `out/extension.js`、`package.json`、`package.nls*.json`、`assets/icon.png`、`assets/whale-icon.svg`、`README.md`；**不含** `src/`、`test/`、`docs/`、`node_modules/`、`.superpowers/`、任何 `.map`。

- [ ] **Step 3: 安装到真实 VS Code**

Run: `code --install-extension dsh-vscode.vsix`
Expected: 安装成功。

- [ ] **Step 4: 激活验证（可自动化部分）**

Run: `code /home/fengze233/dsh_vs &`（打开窗口触发激活），等待约 10 秒后检查扩展宿主日志：

```bash
sleep 10
LOGDIR=$(ls -dt ~/.config/Code/logs/*/window* 2>/dev/null | head -1)
grep -iE "dsh|error" "$LOGDIR/exthost/exthost.log" 2>/dev/null | tail -20
```

Expected: 无与 dsh-vscode 相关的激活错误；状态栏出现 DSH 项（请用户目视确认）。

- [ ] **Step 5: 用户在真实 VS Code 中复核关键项**

请用户目视：活动栏 DSH 图标点击 → 面板显示 DSH 网页；状态栏"DSH: 运行中"绿色；退出 VS Code 后 `pgrep -af 'dsh web'` 无残留（用户手动启动的除外）。

- [ ] **Step 6: 交付物确认**

Run: `ls -la dsh-vscode.vsix`
Expected: 文件存在。交付物：`dsh-vscode.vsix`（可用 `code --install-extension` 安装）。

---

### Task 13: 首次引导增强 + 欢迎页 Walkthrough 入口（验收反馈新增）

**背景**：验收反馈两条新需求——(a) 希望用户更容易把面板固定到右侧（首次打开面板即弹引导，而不是只有执行命令才弹）；(b) 希望 VS Code 欢迎页出现 DSH 入口（平台无"右上角图标"扩展点，最接近形态是欢迎页的"入门指引"卡片，带图标与打开按钮）。左侧活动栏图标本来就不受视图移动影响，无需改动。

**Files:**
- Modify: `src/panel/provider.ts`（构造增加可选第二参数 `onFirstOpen`，首次 resolveWebviewView 时调用一次）
- Modify: `src/extension.ts`（提取 `showSecondaryGuideOnce(context)`；openSecondary 与首次打开面板共用；provider 构造传回调）
- Modify: `package.json`（顶层增加 `"icon": "assets/icon.png"`；`contributes` 增加 `walkthroughs`）
- Create: `scripts/gen-icon.py`（Pillow 生成 PNG 图标）、`assets/icon.png`（打包用 PNG 图标——vsce 要求顶层 icon 为 PNG，SVG 只允许用于活动栏图标）
- Modify: `package.nls.json`、`package.nls.zh-cn.json`（新增 4 个 walkthrough 文案键）

**Interfaces:**
- Consumes: Task 9/10 既有实现
- Produces: `DshPanelProvider(manager, onFirstOpen?)`；`showSecondaryGuideOnce(context)`；`contributes.walkthroughs`（id `dsh.getStarted`，步骤 `dsh.openPanel`，`completionEvents: ["onCommand:dsh.openPanel"]`）

- [ ] **Step 1: 修改 src/panel/provider.ts**

把构造与 resolveWebviewView 改为（其余不动）：

```ts
export class DshPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  /** 曾处于 ready：用于区分"服务断开"与"手动停止"两种占位页 */
  private wasConnected = false;
  /** 面板是否已首次打开过（用于一次性回调） */
  private openedOnce = false;

  /** @param onFirstOpen 面板首次打开时调用一次的回调（用于引导提示，由入口注入） */
  constructor(private manager: ServiceManager, private onFirstOpen?: () => void) {
    // 订阅状态变化，重绘面板（iframe 与占位页由状态驱动，无白屏路径）
    manager.onChange(() => this.render());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // enableScripts 允许占位页的内联按钮脚本（nonce 放行）运行。
    // 注意：retainContextWhenHidden 不在这里设置——它不是 WebviewOptions 字段，
    // 由 Task 10 注册视图时通过第三参数传入（隐藏面板时保留 iframe 会话）。
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: PanelMessage) => this.onMessage(msg));
    if (!this.openedOnce) {
      this.openedOnce = true;
      this.onFirstOpen?.(); // 首次打开：触发一次性引导（如"移到右侧栏"提示）
    }
    this.render();
    // 面板打开即确保服务运行：复用已有或自动启动
    void this.manager.ensureRunning();
  }
```

- [ ] **Step 2: 修改 src/extension.ts**

提取引导函数并接线（其余不动）：

```ts
/** 一次性引导：教用户把 DSH 视图固定到右侧辅助侧边栏（位置永久保持） */
async function showSecondaryGuideOnce(context: vscode.ExtensionContext): Promise<void> {
  const KEY = 'dsh.secondaryGuideShown';
  if (context.globalState.get(KEY)) return;
  await vscode.window.showInformationMessage(t('guide.secondaryText'), t('guide.gotIt'));
  void context.globalState.update(KEY, true);
}
```

`activate` 中两处改为：

```ts
  const panel = new DshPanelProvider(manager, () => {
    void showSecondaryGuideOnce(context); // 首次打开面板也弹一次"移到右侧"引导
  });
```

`openSecondary` 函数体改为复用引导函数：

```ts
/** 在辅助侧边栏打开：聚焦辅助侧边栏 + 视图 + 一次性移动引导 */
async function openSecondary(context: vscode.ExtensionContext): Promise<void> {
  // 聚焦辅助侧边栏（命令 ID 因 VS Code 版本而异，取存在者）
  const cmds = await vscode.commands.getCommands(true);
  const focusId = cmds.includes('workbench.action.focusSecondarySideBar')
    ? 'workbench.action.focusSecondarySideBar'
    : 'workbench.action.focusAuxiliaryBar';
  await vscode.commands.executeCommand(focusId);
  await vscode.commands.executeCommand('dsh.panel.focus');
  await showSecondaryGuideOnce(context);
}
```

- [ ] **Step 3: 修改 package.json**

顶层（`"publisher"` 之后）增加（**必须是 PNG**——vsce 打包时顶层 icon 不接受 SVG，已实测报错）：

```json
  "icon": "assets/icon.png",
```

`"contributes"` 对象内（`"views"` 之后）增加 walkthroughs：

```json
    "walkthroughs": [
      {
        "id": "dsh.getStarted",
        "title": "%dsh.walkthrough.title%",
        "description": "%dsh.walkthrough.description%",
        "steps": [
          {
            "id": "dsh.openPanel",
            "title": "%dsh.walkthrough.step.title%",
            "description": "%dsh.walkthrough.step.description%",
            "completionEvents": ["onCommand:dsh.openPanel"]
          }
        ]
      }
    ],
```

- [ ] **Step 3.5: 生成 PNG 图标（Pillow 脚本）**

创建 `scripts/gen-icon.py`：

```python
# scripts/gen-icon.py — 用 Pillow 生成打包用 PNG 图标（128×128）
# vsce 要求顶层 icon 为 PNG；活动栏图标仍用 SVG（VS Code 支持）。
# 图案与 assets/icon.svg 一致：渐变圆角方块 + 三条白色圆角条。
from PIL import Image, ImageDraw

SIZE = 128
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

# 圆角矩形背景遮罩
radius = 26
mask = Image.new('L', (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([6, 6, 122, 122], radius=radius, fill=255)

# 背景：近似 SVG 的 45° 渐变（此处用垂直渐变，观感一致）
top_color = (77, 107, 254)    # #4D6BFE
bottom_color = (59, 79, 224)  # #3B4FE0
for y in range(6, 123):
    t = (y - 6) / (122 - 6)
    color = tuple(int(top_color[i] + (bottom_color[i] - top_color[i]) * t) for i in range(3)) + (255,)
    for x in range(6, 123):
        if mask.getpixel((x, y)):
            img.putpixel((x, y), color)

# 三条白色圆角条（位置/宽度/透明度与 SVG 一致）
for y, w, opacity in [(42, 68, 255), (64, 68, 216), (86, 44, 178)]:
    bar = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(bar).rounded_rectangle([30, y, 30 + w, y + 12], radius=6, fill=(255, 255, 255, opacity))
    img = Image.alpha_composite(img, bar)

img.save('assets/icon.png', 'PNG')
print('assets/icon.png 已生成')
```

Run: `python3 scripts/gen-icon.py`
Expected: 输出 `assets/icon.png 已生成`，且 `assets/icon.png` 存在（128×128 PNG）。

- [ ] **Step 4: 修改 package.nls.json（英文默认）**

```json
  "dsh.walkthrough.title": "Get Started with DSH",
  "dsh.walkthrough.description": "Use the DeepSeek Harness web UI right inside VS Code.",
  "dsh.walkthrough.step.title": "Open the DSH panel",
  "dsh.walkthrough.step.description": "Click the DSH icon in the Activity Bar, or run [DSH: Open Panel](command:dsh.openPanel). The panel starts (or reuses) the dsh web service and embeds the DSH page in the sidebar."
```

- [ ] **Step 5: 修改 package.nls.zh-cn.json**

```json
  "dsh.walkthrough.title": "DSH 入门",
  "dsh.walkthrough.description": "在 VS Code 内直接使用 DeepSeek Harness 网页界面。",
  "dsh.walkthrough.step.title": "打开 DSH 面板",
  "dsh.walkthrough.step.description": "点击活动栏的 DSH 图标，或运行 [DSH: 打开面板](command:dsh.openPanel)。面板会自动启动（或复用）dsh web 服务，并在侧边栏内嵌显示 DSH 网页。"
```

- [ ] **Step 6: 验证**

Run: `npm run compile && npm run typecheck && npm run test`
Expected: 构建/类型检查通过，36/36 测试不回归。

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); JSON.parse(require('fs').readFileSync('package.nls.json','utf8')); JSON.parse(require('fs').readFileSync('package.nls.zh-cn.json','utf8')); console.log('JSON 合法')"`
Expected: 输出 `JSON 合法`。

Run: `npm run package 2>&1 | tail -2`
Expected: `DONE Packaged: dsh-vscode.vsix`，无 `ERROR`（顶层 icon 已换 PNG，vsce 不再报错）。

- [ ] **Step 7: 报告**

报告写入 `.superpowers/sdd/2026-08-15-dsh-vscode-plugin/task-13-report.md`，含验证输出摘要与自审结论。

---

### Task 14: 双侧栏图标 + DSH 鲸鱼 Logo（验收反馈新增）

**背景**：验收反馈——(a) 希望左侧与右侧侧边栏图标同时存在（已证实 VS Code 1.91+ 支持 `contributes.viewsContainers.secondarySidebar`，Claude Code 扩展即用此机制；官方文档尚未收录该字段）；(b) 当前图标是蓝色圆角方块，应换成 DSH 官方鲸鱼 Logo（来源：`dsh-web-frontend/dist/favicon.svg` 的 path 数据）。

**Files:**
- Create: `assets/whale-badge.svg`（蓝底白鲸徽章，单文件适配深浅主题；viewsContainers 的 icon 只接受字符串，已实测修正）
- Modify: `scripts/gen-icon.py`（改为鲸鱼 Logo + 蓝色渐变圆角底的组合）
- Modify: `package.json`（engines 升到 ^1.91.0；活动栏图标改 {light,dark} 对象；新增 secondarySidebar 容器与第二个视图；menus 的 when 覆盖两个视图）
- Modify: `src/extension.ts`（注册第二个 provider；openSecondary 聚焦右侧视图并回退旧逻辑）
- Modify: `src/i18n.ts`（guide.secondaryText 文案更新——右侧已有原生入口，引导改述两侧入口）
- Modify: `package.nls.json`、`package.nls.zh-cn.json`（walkthrough 步骤描述提及两侧图标）

**关键事实**：鲸鱼路径数据从 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg` 的 `<path d="…">` 复制（50×50 视口，仅含 M/C/Z 绝对命令，共 4 段子路径）。

- [ ] **Step 1: 创建 assets/whale-icon.svg（纯鲸鱼剪影，无背景）**

**三次实测修正（根因已确诊）**：VS Code 把侧边栏图标按**单色掩膜**渲染——图标 SVG 的颜色被忽略，只取形状（已实测：Claude Code 的橙色图标在侧边栏显示为白色）。因此任何背景色块都会变成白色方块。正确做法是**只有鲸鱼剪影、透明背景**，VS Code 会自动渲染成白色（深色主题）/深色（浅色主题）。`PATH_DATA` 用 favicon.svg 的 d 属性原样替换：

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <g transform="translate(16,16) scale(1.92)">
    <path fill="#000000" d="PATH_DATA"/>
  </g>
</svg>
```

（删除 assets/whale-badge.svg；彩色徽章只保留在 assets/icon.png，用于顶层包图标与 walkthrough 媒体图。）

（不再创建 whale-light.svg / whale-dark.svg。）

- [ ] **Step 2: 重写 scripts/gen-icon.py（鲸鱼 Logo + 蓝色渐变圆角底）**

```python
# scripts/gen-icon.py — 生成打包用 PNG 图标（DSH 鲸鱼 Logo：白鲸 + 蓝色渐变圆角底）
# 鲸鱼路径来自 dsh-web-frontend/dist/favicon.svg（50×50 视口，M/C/Z 绝对命令）。
# 用法：在仓库根目录执行 python3 scripts/gen-icon.py
import math
import re
from PIL import Image, ImageDraw

SIZE = 128      # 输出尺寸
SS = 8          # 超采样倍数（抗锯齿）

# 鲸鱼路径数据（favicon.svg 的 d 属性，原样复制）
D = "PATH_DATA"


def mid(a, b):
    """两点中点"""
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def point_line_dist(p, a, b):
    """点 p 到线段 ab 的垂直距离"""
    dx, dy = b[0] - a[0], b[1] - a[1]
    if dx == 0 and dy == 0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    return abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / math.hypot(dx, dy)


def flatten_cubic(p0, p1, p2, p3, tol=0.06):
    """自适应细分三次贝塞尔为折线（de Casteljau 二分）"""
    if max(point_line_dist(p1, p0, p3), point_line_dist(p2, p0, p3)) <= tol:
        return [p3]
    q0, q1, q2 = mid(p0, p1), mid(p1, p2), mid(p2, p3)
    r0, r1 = mid(q0, q1), mid(q1, q2)
    m = mid(r0, r1)
    return flatten_cubic(p0, q0, r0, m, tol) + flatten_cubic(m, r1, q2, p3, tol)


def parse_path(d):
    """解析仅含 M/C/Z 的绝对路径，返回子路径点列表的列表"""
    tokens = re.findall(r'[MCZ]|-?\d*\.?\d+', d)
    subs, cur, i = [], [], 0
    while i < len(tokens):
        t = tokens[i]
        if t == 'M':
            if cur:
                subs.append(cur)
            cur = [tuple(map(float, tokens[i + 1:i + 3]))]
            i += 3
        elif t == 'C':
            p0 = cur[-1]
            c1 = tuple(map(float, tokens[i + 1:i + 3]))
            c2 = tuple(map(float, tokens[i + 3:i + 5]))
            p1 = tuple(map(float, tokens[i + 5:i + 7]))
            cur.extend(flatten_cubic(p0, c1, c2, p1))
            i += 7
        elif t == 'Z':
            if cur and cur[0] != cur[-1]:
                cur.append(cur[0])
            i += 1
        else:
            raise ValueError('不支持的路径命令: ' + t)
    if cur:
        subs.append(cur)
    return subs


# 1) 超采样渲染白鲸（透明底）
N = SIZE * SS
scale = N / 50.0 * 0.92   # 鲸鱼占图标约 92% 宽度
off = (N - 50 * scale) / 2
whale_hi = Image.new('RGBA', (N, N), (0, 0, 0, 0))
wd = ImageDraw.Draw(whale_hi)
for sub in parse_path(D):
    pts = [(x * scale + off, y * scale + off) for x, y in sub]
    wd.polygon(pts, fill=(255, 255, 255, 255))
whale = whale_hi.resize((SIZE, SIZE), Image.LANCZOS)

# 2) 蓝色渐变圆角底
bg = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
mask = Image.new('L', (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([6, 6, 122, 122], radius=26, fill=255)
top_color = (77, 107, 254)     # #4D6BFE
bottom_color = (59, 79, 224)   # #3B4FE0
for y in range(6, 123):
    t = (y - 6) / (122 - 6)
    color = tuple(int(top_color[i] + (bottom_color[i] - top_color[i]) * t) for i in range(3)) + (255,)
    for x in range(6, 123):
        if mask.getpixel((x, y)):
            bg.putpixel((x, y), color)

# 3) 合成并保存
out = Image.alpha_composite(bg, whale)
out.save('assets/icon.png', 'PNG')
print('assets/icon.png 已生成（鲸鱼 Logo）')
```

Run: `python3 scripts/gen-icon.py`
Expected: 生成新的 `assets/icon.png`；可人工检查为"白鲸 + 蓝色圆角底"。

- [ ] **Step 3: 修改 package.json**

① engines 升级：

```json
  "engines": { "vscode": "^1.91.0" },
```

② viewsContainers 改为（icon 为鲸鱼剪影 SVG 字符串；并新增 secondarySidebar 容器）：

```json
    "viewsContainers": {
      "activitybar": [
        {
          "id": "dsh",
          "title": "%dsh.container.title%",
          "icon": "assets/whale-icon.svg"
        }
      ],
      "secondarySidebar": [
        {
          "id": "dsh-secondary",
          "title": "%dsh.container.title%",
          "icon": "assets/whale-icon.svg"
        }
      ]
    },
```

③ views 增加第二个视图（名称用独立 nls 键，便于用户区分左右两个面板）：

```json
    "views": {
      "dsh": [
        { "id": "dsh.panel", "name": "%dsh.view.panel.name%", "type": "webview" }
      ],
      "dsh-secondary": [
        { "id": "dsh.panel.secondary", "name": "%dsh.view.panelSecondary.name%", "type": "webview" }
      ]
    },
```

④ menus.view/title 全部条目的 when 改为：

```json
"when": "view == dsh.panel || view == dsh.panel.secondary"
```

- [ ] **Step 4: 修改 src/extension.ts**

① panel 创建与注册改为两个实例（左侧与右侧各一，共享同一 manager）：

```ts
  const panelPrimary = new DshPanelProvider(manager, () => {
    void showSecondaryGuideOnce(context); // 首次打开面板弹一次入口引导
  });
  const panelSecondary = new DshPanelProvider(manager);

  context.subscriptions.push(
    // 第三参数：隐藏面板时保留 webview（iframe 不销毁、DSH 页面会话不丢）
    vscode.window.registerWebviewViewProvider('dsh.panel', panelPrimary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('dsh.panel.secondary', panelSecondary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
```

② openSecondary 改为（优先聚焦右侧原生视图，旧版回退引导逻辑）：

```ts
/** 在辅助侧边栏打开：新版 VS Code（≥1.91）直接聚焦右侧视图；旧版回退聚焦+引导 */
async function openSecondary(context: vscode.ExtensionContext): Promise<void> {
  const cmds = await vscode.commands.getCommands(true);
  // 视图声明在 package.json 里，VS Code 会自动生成 <viewId>.focus 命令；
  // 存在即说明当前版本支持辅助侧边栏容器（≥1.91）
  if (cmds.includes('dsh.panel.secondary.focus')) {
    await vscode.commands.executeCommand('dsh.panel.secondary.focus');
    return;
  }
  // 旧版回退：聚焦辅助侧边栏（命令 ID 因版本而异，取存在者）+ 一次性移动引导
  const focusId = cmds.includes('workbench.action.focusSecondarySideBar')
    ? 'workbench.action.focusSecondarySideBar'
    : 'workbench.action.focusAuxiliaryBar';
  await vscode.commands.executeCommand(focusId);
  await vscode.commands.executeCommand('dsh.panel.focus');
  await showSecondaryGuideOnce(context);
}
```

- [ ] **Step 5: 修改 src/i18n.ts 的 guide 文案**

`en` 字典中：

```ts
    'guide.secondaryTitle': 'DSH: Two Sidebar Entrances',
    'guide.secondaryText':
      'The DSH panel is available from both the Activity Bar and the Secondary Side Bar icons. Click either to open it.',
```

`zh` 字典中：

```ts
    'guide.secondaryTitle': 'DSH：双侧栏入口',
    'guide.secondaryText':
      'DSH 面板可通过左侧活动栏或右侧辅助侧边栏的 DSH 图标打开，点击任意一个即可使用。',
```

- [ ] **Step 6: 修改 nls（新增右侧视图名键 + walkthrough 步骤描述）**

`package.nls.json` 新增：

```json
  "dsh.view.panelSecondary.name": "DSH Panel (Right)",
```

并更新 walkthrough 步骤描述：

```json
  "dsh.walkthrough.step.description": "Click the DSH icon in the Activity Bar or the Secondary Side Bar, or run [DSH: Open Panel](command:dsh.openPanel). The panel starts (or reuses) the dsh web service and embeds the DSH page in the sidebar."
```

`package.nls.zh-cn.json` 新增：

```json
  "dsh.view.panelSecondary.name": "DSH 面板（右）",
```

并更新 walkthrough 步骤描述：

```json
  "dsh.walkthrough.step.description": "点击左侧活动栏或右侧辅助侧边栏的 DSH 图标，或运行 [DSH: 打开面板](command:dsh.openPanel)。面板会自动启动（或复用）dsh web 服务，并在侧边栏内嵌显示 DSH 网页。"
```

- [ ] **Step 6.5: walkthrough 步骤增加媒体图（欢迎页打开指引时显示鲸鱼图）**

`package.json` 的 walkthroughs 步骤对象内增加：

```json
            "media": { "image": "assets/icon.png" },
```

- [ ] **Step 7: 验证**

Run: `npm run compile && npm run typecheck && npm run test`
Expected: 构建/类型检查通过，36/36 测试不回归。

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('JSON 合法')"`
Expected: `JSON 合法`。

Run: `npm run package 2>&1 | tail -2`
Expected: `DONE Packaged: dsh-vscode.vsix`，无 ERROR。

- [ ] **Step 8: 报告**

报告写入 `.superpowers/sdd/2026-08-15-dsh-vscode-plugin/task-14-report.md`，含验证输出摘要、新图标文件清单与自审结论。

---

### Task 15: 交付前修复（最终审查 I-1/I-2）

**背景**：最终全量审查发现两个 Important：I-1 复用外部服务时若服务失联，无探测兜底（iframe 停留浏览器错误页，不切"已断开"）；I-2 启动流程进行中关闭窗口时，`stop()` 提前返回 + `dispose()` 移除钩子 → 已 spawn 的子进程成孤儿。

**Files:**
- Modify: `src/service/manager.ts`（健康探测 + 停止竞态修复）
- Test: `test/manager.test.ts`（新增 2 个测试）

**Interfaces:**
- Consumes: Task 6 既有实现
- Produces: `ManagerDeps` 新增可选 `healthIntervalMs?: number`（默认 30000，≤0 关闭）

- [ ] **Step 1: 修改 src/service/manager.ts（五处编辑）**

① `ManagerDeps` 接口内、`log` 之后增加：

```ts
  /** 就绪后的健康探测间隔（毫秒，默认 30000；≤0 关闭探测） */
  healthIntervalMs?: number;
```

② 类字段区（`private op` 附近）增加：

```ts
  /** 就绪后的健康探测定时器（兜底外部服务失联/子进程活着但服务已死） */
  private healthTimer: NodeJS.Timeout | null = null;
  /** 停止请求标志：启动流程进行中也要立即停掉已 spawn 的子进程 */
  private stopRequested = false;
```

文件顶部常量区增加：

```ts
/** 就绪后健康探测间隔默认值（毫秒） */
const DEFAULT_HEALTH_INTERVAL_MS = 30000;
```

③ `stop()` 替换为：

```ts
  /** 停止：仅停止插件自己启动的服务；启动流程进行中也会立即停掉已 spawn 的子进程 */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearHealthWatch(); // 复用外部服务时也要清掉健康探测定时器
    if (this.child) {
      await this.stopOwned();
    } else {
      this.set({ state: 'idle', url: null, owned: false, error: null });
    }
  }
```

`stopOwned()` 函数体开头（`if (!this.child)` 之前）增加：

```ts
    this.clearHealthWatch();
```

④ `doStart()` 内三处：

- 函数体第一行（`this.set({ state: 'detecting'...` 之前）增加：

```ts
    this.stopRequested = false; // 新一轮启动流程重置停止标志
```

- `if (probe === 'dsh')` 分支中、`this.set({ state: 'ready'...` 之前增加：

```ts
      if (this.stopRequested) return this.getSnapshot(); // 探测期间被叫停，不覆盖用户的停止意图
```

且该分支中、`return this.getSnapshot();` 之前增加：

```ts
      this.startHealthWatch(); // 复用外部服务也要周期探测，失联时回 idle
```

- `this.set({ state: 'starting' });` 之前增加：

```ts
    if (this.stopRequested) return this.getSnapshot(); // 启动前被叫停
```

- 等待循环内、`if (childExited)` 之前增加：

```ts
      if (this.stopRequested) return this.getSnapshot(); // 等待阶段被叫停（先于 childExited 判定）
```

- `owned=true` 的 ready 分支中、`return this.getSnapshot();` 之前增加：

```ts
        this.startHealthWatch();
```

⑤ `handleUnexpectedExit` 的 ready 分支内、`this.set(...)` 之前增加：

```ts
      this.clearHealthWatch();
```

⑥ 类末尾（`reconfigure` 之前）增加两个方法：

```ts
  /** 就绪后周期探测：发现服务不再是 DSH 时回到 idle（面板据此显示"已断开"） */
  private startHealthWatch(): void {
    this.clearHealthWatch();
    const interval = this.deps.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    if (interval <= 0) return;
    this.healthTimer = setInterval(() => {
      void this.deps.probeService(this.opts.host, this.opts.port, this.opts.timeoutMs).then((result) => {
        if (result !== 'dsh' && this.snapshot.state === 'ready') {
          this.clearHealthWatch(); // 已回 idle，定时器自清理，不空转
          this.set({ state: 'idle', url: null, owned: false, error: null });
        }
      });
    }, interval);
  }

  /** 清除健康探测定时器 */
  private clearHealthWatch(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
```

⑦ `dispose()` 替换为：

```ts
  /** 清理：移除钩子与监听器（不杀子进程，停止由 stop() 决定）；
   * 仍有活跃子进程时保留父进程退出钩子，防止启动流程中被 dispose 后成孤儿 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHealthWatch();
    if (!this.child) process.removeListener('exit', this.parentExitHook);
    this.listeners.clear();
  }
```

- [ ] **Step 2: test/manager.test.ts 修改**

① 既有测试工具（Task 6 定义的 `Harness` 接口与 `makeHarness`）需增加探测计数：

`Harness` 接口增加字段 `probeCount: number;`（注释：探测调用次数，用于断言定时器已清理）；`makeHarness` 中 `const h: Harness = {...}` 初始化增加 `probeCount: 0,`；`probeService` 函数体第一行增加 `h.probeCount += 1;`。

② 新增 3 个测试（追加到文件末尾）：

```ts
test('启动等待阶段 stop()：立即停掉子进程、流程以 idle 结束（不误报崩溃）', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1)); // 子进程已 spawn，进入 waiting
  await h.manager.stop();
  h.child?.emitExit(1); // 模拟真实 kill 触发的 exit 事件竞态
  const s = await p;
  assert.equal(s.state, 'idle'); // stopRequested 判定先于 childExited，不误报 startCrashed
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.ok(h.child!.killed.length > 0); // 子进程被停掉，无孤儿
  h.manager.dispose();
});

test('复用外部服务失联：健康探测发现后回到 idle（面板显示已断开）', async () => {
  const h = makeHarness({}, { healthIntervalMs: 30 });
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  h.probeQueue = ['down']; // 外部服务失联
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(h.manager.getSnapshot().state, 'idle');
  h.manager.dispose();
});

test('复用外部服务 stop()：清理健康定时器并回到 idle', async () => {
  const h = makeHarness({}, { healthIntervalMs: 30 });
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  await h.manager.stop();
  assert.equal(h.manager.getSnapshot().state, 'idle');
  // 停止后不应再有探测发生：若定时器泄漏，30ms 间隔会在 90ms 内触发约 3 次探测
  const probesBefore = h.probeCount;
  h.probeQueue = ['foreign'];
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(h.probeCount, probesBefore); // 无新增探测 = 定时器已清理
  h.manager.dispose();
});
```

- [ ] **Step 3: 验证**

Run: `npm run test`
Expected: `# pass 39 # fail 0`（原 36 + 新 3）。

Run: `npm run compile && npm run typecheck`
Expected: 通过。

Run: `npm run package 2>&1 | tail -2`
Expected: `DONE Packaged`，无 ERROR。

- [ ] **Step 4: 报告**

报告写入 `.superpowers/sdd/2026-08-15-dsh-vscode-plugin/task-15-report.md`，含验证输出与自审结论。

---

## 计划自审记录

（执行前已自审，修复两处后记录于此。）

1. **Spec 覆盖检查**：规格 11 节逐节对应——§2 需求确认→Task 1（清单/配置）与全局约束；§3 预研→Task 4 探测标记；§4 命名配置→Task 1/3；§5 架构状态机→Task 6；§6 组件数据流→Task 8/9/10；§7 错误处理→Task 6 各错误分支 + Task 11 #10；§8 辅助侧边栏→Task 10 `openSecondary` + Task 11 #11；§9 i18n→Task 1（nls）+ Task 2；§10 测试验收→Task 2-8 单测、Task 7 集成、Task 11 清单。无遗漏。
2. **占位符扫描**：无 TBD/TODO；每个代码步骤含完整实现。
3. **类型一致性**：`ManagerOptions`（host/port/extraArgs/autoStart/timeoutMs/pollMs）、`ManagerDeps.probeService/processRunner/log/startTimeoutMs`、`ServiceSnapshot.error: MsgKey|null`、`PanelMessage`、`PageCtx`、`getTarget/reconfigure/setExitBehavior` 在 Task 4-10 间签名一致；Task 6 的 `reconfigure` 已改为"仅 host/port 变化才重启"（见下）。
4. **Task 6 修复**：`reconfigure` 原按"是否有自启子进程"决定重启，会把仅改 `autoStart` 等场景误判为重启；已改为按 host/port 是否变化决定：

```ts
  /** 应用新配置；仅 host/port 变化且自启服务在跑时自动重启 */
  reconfigure(opts: ManagerOptions): Promise<ServiceSnapshot> {
    const targetChanged = this.opts.host !== opts.host || this.opts.port !== opts.port;
    this.opts = opts;
    if (targetChanged) {
      if (this.child) return this.restart();
      if (this.snapshot.state === 'ready') this.set({ url: this.url() });
    }
    return Promise.resolve(this.getSnapshot());
  }
```

（若实现时采用本版本，Task 6 的 manager 代码中对应函数以此为准。）

5. **测试隔离**：集成测试使用随机端口，不打扰 3080 上正在运行的服务；测试结束在 `finally` 中 `manager.stop()`。


