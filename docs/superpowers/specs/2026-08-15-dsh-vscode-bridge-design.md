# DSH VS Code 插件桥接修复设计规格

- 日期：2026-08-15
- 状态：已与用户逐节确认，待用户最终审阅
- 范围：在既有纯 VS Code 扩展（dsh-vscode-panel）基础上新增"DSH 页面桥接"能力，仍不修改 DSH 本体安装目录代码

## 1. 背景与问题

插件 v0.1.0 用 iframe 把 DSH web 页面（http://127.0.0.1:3080）嵌入 VS Code 侧边栏。实际使用发现两个体验问题：

1. **链接点击无法跳转**：DSH 回复中的外链（`<a href="http(s)://..." target="_blank">`）点击无反应；文件路径（反引号包裹、渲染为可点击按钮的 fileMention）点击同样无效。
2. **对话不自动切换到 VS Code 工作区**：新会话默认没有 cwd，命令不落在当前工作目录；DSH 自带"工作区"机制需要手动选择，用户期望打开面板即自动指向 VS Code 当前工作区。

## 2. 需求确认记录（用户逐项选择）

| 问题 | 用户选择 |
|---|---|
| 修复方案取向 | A. DSH profile 客户端插件（官方扩展点，写入用户 `~/.dsh/profiles/web/`，不碰 DSH 安装目录；可自动安装/卸载干净） |
| 使用环境范围 | 全平台代码兼容（Windows 本地 / WSL / macOS / Linux），由用户后续找人实测 |
| 桥接失败时的行为 | 现有功能全部保留可用；插件激活时弹警告说明哪些功能不可用，用户可勾选"不再提示" |
| 外链点击行为 | 一律在系统默认浏览器新标签打开，面板内 DSH 页面保持不动 |
| 文件路径点击行为 | 在 VS Code 编辑器打开对应文件，自动相对工作区解析；找不到文件时提示 |
| 多根工作区策略 | 默认取第一个根目录，设置项可指定根索引；单目录工作区无感知 |

## 3. 技术调研结论（均已实证）

对已安装的 DSH（0.1.0-rc.6）实际检查确认：

1. **链接失效根因**：DSH 前端所有外链均为 `target="_blank"`；VS Code webview 是沙箱 iframe（sandbox 无 `allow-popups`），沙箱标志继承到嵌套 iframe，`window.open` 被 Chromium 拦截，点击无任何反应。DSH 前端无 postMessage / 无 iframe 适配（已确认无 `window.parent` 使用）。
2. **修复必须注入脚本**：把"点击"转为"postMessage → 扩展 → `vscode.env.openExternal` / `showTextDocument`"。
3. **DSH 客户端插件机制（官方扩展点）**：web profile 由配置树汇编；客户端插件包在 `package.json` 声明 `dsh.client`（inject/platform），注册进配置树后由 `__DSH_BOOT__.entries` 以 `/plugins/<id>/client.js` 形式加载。profile 的 `cordis.patch.yml` 是用户个性化 patch 层（顶层 YAML 数组；新增条目须用 `insert:` 包裹，裸 `{id,name}` 形状只用于按 id 覆盖/禁用既有行），写入用户目录即可，不碰 DSH 安装目录。已由 Task 0 spike 实证（详见 §5.3）。
4. **会话工作区机制**：DSH 有 workspace 实体（durable registry），`session.create` API 接受 `workspaceId` 或 `cwd`（互斥）；会话 header 记录绝对路径 cwd，持久化按 projectKey 分组。bash 工具 workdir 解析顺序：模型参数 → 会话 header.cwd → bash 插件 config.cwd → 服务进程 cwd。
5. **插件可直调 DSH HTTP API**：API 为信封协议 `POST /api/<namespace>.<method>`，请求体 `{type:"client-request", rpcId, method, payload}`。Node 直连（无 Origin 头）不受 browser-trust 栅栏限制（实测通过）；带恶意 Origin 头返回 forbidden。
6. **`dsh web` 无 cwd 参数**；DSH 前端不读取任何 URL 查询参数（`URLSearchParams` 仅用于测试 fixture 模式）。
7. **前端"当前选中工作区"概念**：主输入区有"选择工作区"按钮、会话树按工作区分组；新建会话与选中工作区关联。

## 4. 总体架构

### 4.1 新增模块

**① 桥接安装器 `src/bridge/installer.ts`（插件侧，Node 环境）**
- 探测 DSH：可执行文件定位、`$DSH_HOME`（优先于 `~/.dsh`）、`~/.dsh/profiles/web/` 结构与 `cordis.patch.yml`；
- 能力探测：`dsh --profile web --dump-config` 确认配置树格式；
- 幂等安装：桥接包复制进 profile 的 `node_modules`（目录形如 `node_modules/dsh-vscode-bridge/`，无 scope，避免与官方 `@deepseek-ai/*` 包混淆），向 `cordis.patch.yml` 追加带注释标记的条目（`# dsh-vscode-bridge: begin/end` 包裹），绝不覆盖用户已有内容；
- 卸载/更新：按标记删除条目、删除桥接包目录、还原原文件；
- 输出安装状态：`ok` / `pending-restart` / `degraded`（带原因）。

**② 桥接客户端包 `bridge-client/`（纯 ESM JS 小包，运行在 DSH 网页内）**
- 包结构：`package.json`（含 `dsh.client` 声明）+ `lib/index.js` + `lib/client.js`；
- 职责：
  - 捕获阶段拦截外链点击（`a[target=_blank]`，http/https 白名单）与 fileMention 按钮点击，`parent.postMessage` 转发；
  - 接收"同步工作区"指令，把 VS Code 工作区设为 DSH 当前选中工作区（幂等复用已存在的 workspace）；
  - 握手回执；
- **无父页面握手时不激活**：用户浏览器直接打开 `dsh web` 时零影响。

**③ 桥接宿主 `src/bridge/host.ts`（插件侧，webview 顶层 + 扩展进程）**
- readyPage 内嵌握手/转发脚本：带随机 token 的握手；只接受 `origin === http://127.0.0.1:<port>` 且 `source === iframe.contentWindow` 的 postMessage；
- 扩展侧 DSH API 客户端：信封协议构造与响应解析（`workspace.list` / `workspace.create`）；
- 三类动作处理：
  - `openExternal` → `vscode.env.openExternal`（系统浏览器）；
  - `openFile` → 相对路径按"会话 cwd → VS Code 工作区"解析绝对路径 → `vscode.window.showTextDocument`；不存在则弹提示；
  - `syncWorkspace` → 幂等创建/复用 workspace 并通过桥接让页面选中。

### 4.2 改动模块

- `src/service/process.ts`：`startDsh` 支持 `cwd` 选项（spawn `cwd`）；
- `src/service/manager.ts`：启动时传入工作区路径作为 cwd（bash 兜底层）；
- `src/panel/html.ts`：readyPage 增加握手脚本与 postMessage 转发；
- `src/panel/provider.ts`：消息路由接入桥接宿主；
- `src/config.ts` + `package.json`：新增设置 `dsh.bridge.enabled`（默认 true）、`dsh.workspaceRootIndex`（默认 0）、`dsh.bridge.silenceWarning`（默认 false）；
- `src/i18n.ts` + `package.nls*.json`：新增桥接相关文案；
- `scripts/build.mjs`：`bridge-client` 无需构建（纯 ESM 源文件随包分发），打包时包含进 vsix。

### 4.3 明确不改

- 不写 DSH 安装目录；面板现有功能（服务管理、状态栏、占位页、浏览器按钮）全部保留；
- 桥接失败时仅三类功能降级（外链跳转 / 文件跳转 / 自动切工作区），面板完全可用。

## 5. 端到端数据流

### 5.1 链接/文件跳转

```
DSH 网页(iframe)内点击
  ├─ 外链 <a target=_blank>     → 桥接捕获(捕获阶段,阻止默认) → postMessage {kind:'openExternal', url}
  ├─ 文件路径按钮(fileMention)  → 桥接捕获(阻止 DSH 默认打开) → postMessage {kind:'openFile', path, cwd}
  └─ 两者先做 http/https 协议白名单校验
       ↓
webview 顶层握手脚本（校验 origin + source + token）
       ↓ vscode.postMessage
扩展进程
  ├─ openExternal → vscode.env.openExternal（系统浏览器）
  └─ openFile → 解析绝对路径（相对 → 会话 cwd → VS Code 工作区）
       → vscode.window.showTextDocument；文件不存在 → 弹提示，不崩溃
```

### 5.2 自动同步工作区

```
面板打开 / 服务就绪
  ├─ 扩展调 DSH API：workspace.list → 找 path == VS Code 工作区
  │    ├─ 已存在 → 复用 id
  │    └─ 不存在 → workspace.create {path}（幂等）
  ├─ webview 顶层 postMessage {kind:'syncWorkspace', path} → iframe 桥接
  │    → 桥接把该 workspace 置为 DSH 页面"当前选中工作区"
  │    → 新建会话自动 attach → 会话 cwd 正确、侧边栏分组正确
  └─ 兜底：若某 DSH 版本"选中"机制不可用 → 桥接拦截 session.create 信封注入 cwd
       （服务端已实证接受 cwd 字段）
```

**边界语义**：仅在"新会话/草稿会话"（无 cwd）时生效；用户正在进行、已绑定其他工作区的会话不打扰；VS Code 工作区变化时（重载/换文件夹），自启服务重启后自动同步新工作区。

### 5.3 开发期验证点（实现第一步先验证）

1. 桥接作为 client 插件注册进 profile 后，`__DSH_BOOT__.entries` 是否出现对应条目、`/plugins/<id>/client.js` 是否可加载；
2. 桥接能否可靠触发前端"选中工作区"（若不能 → 启用 5.2 兜底注入 cwd）；
3. 用户执行 `dsh plugin add` 时 pnpm 是否会清掉我们放于 profile `node_modules` 的桥接包（若会 → 改为 profile 独立目录 + 注册方式的备选）。

#### Task 0 spike 已验证结论（2026-08-15，实证于 0.1.0-rc.6）

验证 1 已由 spike 实证，官方扩展点**可行**，最终可用形状如下（供 Task 1/5 直接使用）：

**① 客户端包 `package.json`（`exports` 必须含 `./package.json`，否则客户端扫描静默 404）**：
```json
{
  "name": "dsh-vscode-bridge",
  "version": "0.0.1",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": { "client": { "inject": [], "platform": "web" } },
  "license": "MIT"
}
```

**② host 侧 `lib/index.js`（空插件，仅配置树注册用）**：
```js
import { Service } from "@deepseek-ai/cordis";
export const name = "dsh-vscode-bridge";
export default class extends Service {
  constructor(ctx) { super(ctx, name); }
}
```

**③ 浏览器端 `lib/client.js`（必须是工厂注册 bundle，不能是裸副作用脚本）**：
```js
window.__ModuleLoader__.load({
  id: "dsh-vscode-bridge",
  factory: (require) => {
    // 桥接逻辑：捕获阶段拦截外链/fileMention、postMessage 转发、握手回执
    var module = { exports: {} };
    var exports = module.exports;
    exports.apply = () => {};
    return module.exports;
  }
});
```

**④ `cordis.patch.yml` 追加条目（新增必须 `insert:` 包裹，且不能 `cat >>` 到 `[]` 后）**：
```yaml
# dsh-vscode-bridge: begin
- insert:
    - id: dsh-vscode-bridge
      name: dsh-vscode-bridge
# dsh-vscode-bridge: end
```

**实测结论摘要**：
1. patch 条目形状：裸 `{id,name}` 会被 `applyEntryPatches` 判为「按 id 覆盖既有行」→ 目标不存在时告警 `patch: entry ... not found` 并跳过；新增必须 `insert:` 包裹。原文件顶层 `[]` 是流式数组，直接追加块序列会 YAML 解析失败。
2. client.js 提供与执行：节点侧以 `require.resolve("<包名>/package.json")` 识别客户端包（故 `exports` 必须导出 `./package.json`）；浏览器端 bundle 必须 `window.__ModuleLoader__.load({id, factory})` 注册工厂，工厂体在页面启动时 `loader.create({name})` 触发 materialize 执行；`__DSH_BOOT__.entries` 中图条目 `id` = 包名（`entry.options.name`）。
3. pnpm-workspace：`packages:[.]` / `nodeLinker: hoisted` / `autoInstallPeers: false`，profile 自有 `node_modules/` 受 pnpm 管理（`dsh plugin` 维护）；`@deepseek-ai/cordis` 等依赖经 `~/.dsh/profiles/node_modules/` 扁平 fallback 符号链接解析，host 侧 `import` 可用。

## 6. 降级与警告

- **桥接状态机**：`installed-ok`（已安装且握手成功）/ `installed-pending`（已装、待服务重启生效）/ `degraded`（安装失败或握手超时）。
- **degraded 行为**：面板、服务管理、状态栏、占位页、"在浏览器打开"按钮全部照常；仅外链跳转、文件跳转、自动切工作区三类功能不可用。
- **警告弹窗**：插件激活时若处于 degraded，弹一次警告，说明"DSH 桥接未生效，以下功能不可用：①点击链接跳转浏览器 ②点击文件路径在 VS Code 打开 ③自动切换到当前工作区"，按钮：`不再提示`（写 globalState，设置项可重置）+ `重试安装`。安装成功后警告自动消失。

## 7. 设置项

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.bridge.enabled` | `true` | 关闭后桥接完全停用（不安装、不注入） |
| `dsh.workspaceRootIndex` | `0` | 多根工作区时指定用第几个根目录 |
| `dsh.bridge.silenceWarning` | `false` | "不再提示"后置 true，设置里可改回 |

## 8. 安全

- 握手带随机 token；webview 顶层只接受 `origin === http://127.0.0.1:<port>` 且 `source === iframe.contentWindow` 的消息；
- `openExternal` 仅放行 `http/https`；`openFile` 做存在性检查，失败弹提示；
- 桥接在普通浏览器打开 `dsh web` 时不激活（无父握手）；即使激活也只做白名单内动作，不读写 DSH 敏感数据。

## 9. 测试计划

- **单测（node:test）**：installer 幂等安装/卸载还原/带标记追加；API 信封构造与响应解析；路径解析（绝对/相对/多根索引）；消息路由与协议白名单；降级状态流转。
- **实测（WSL 真实环境）**：
  1. 面板点外链 → 系统浏览器打开；
  2. 点文件路径 → VS Code 打开文件（含相对路径、不存在文件提示）；
  3. 打开面板 → DSH 自动选中工作区（会话树分组正确）；
  4. 浏览器直接开 3080 → 桥接无任何副作用；
  5. `dsh plugin add` 后桥接包不被清掉（重点验证项，见 5.3）；
  6. 卸载插件 → 补丁与桥接包目录清理干净；
  7. 桥接禁用/安装失败场景 → 面板照常 + 警告可关闭。
- **清理**：测试后停掉测试起的服务、恢复测试前的 `cordis.patch.yml` 与 profile 状态。

## 10. 发布

- 版本 v0.2.0；`bridge-client/` 打包进 vsix（核对 `.vscodeignore` 不排除）；
- README/扩展描述披露："会在你的 DSH 用户目录安装官方扩展点桥接包，可随插件卸载一并清除"；
- 商店 changelog、GitHub Release v0.2.0、讨论帖跟进说明。

## 11. 风险与备选

| 风险 | 缓解 |
|---|---|
| DSH 仍为 rc 版，client 插件机制/API 形状可能变化 | 安装前后双重能力探测；失效时优雅降级 + 警告，不破坏现有功能 |
| pnpm 清理 profile `node_modules` 中非受管包 | 开发期实测验证；备选：profile 独立目录注册方式 |
| "选中工作区"触发机制不可靠 | 兜底拦截 `session.create` 注入 cwd（已实证服务端接受） |
| 多平台行为差异（Windows 本地/macOS） | 代码全平台兼容（标准 Node API），由用户找人实测，后续按反馈修复 |
