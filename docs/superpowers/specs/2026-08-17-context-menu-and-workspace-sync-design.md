# DSH VS Code 插件功能完善设计规格

- 日期:2026-08-17
- 状态:已与用户逐节确认
- 范围:在 v0.2.1 基础上新增三个功能方向:①当前打开文件的 AI 上下文联动 ②右键菜单联动与快速入口 ③工作目录自适应(跨项目)
- 架构决策:全部能力走「扩展 → DSH HTTP API 直连」,桥接(`bridge-client/`)零改动,不修改 DSH 安装目录

## 1. 背景与目标

插件现有能力:侧边栏内嵌 DSH 网页、服务自动管理、桥接(外链跳转/文件跳转)。用户提出三个功能方向的完善:

1. **当前打开文件的自动计入 AI 上下文联动**:在 VS Code 中打开的文件能进入 DSH 的 AI 上下文;
2. **右键菜单联动与快速入口**:把联动能力和快捷入口加入 VS Code 右键菜单(编辑器/资源管理器/标题栏);
3. **自适应当前项目**:在不同项目里打开插件时,自动把工作目录同步到当前项目。

### 1.1 需求确认记录(用户逐项选择)

| 问题 | 用户选择 |
|---|---|
| 需求 1 联动形态 | 半自动为主(上下文工具条按钮)+ 可选自动跟随(设置开关) |
| 注入内容 | 仅文件路径引用(fileMention 语法),不携带文件正文 |
| 注入目标会话 | 当前项目(工作区)下最近活动会话;无则自动新建绑定该工作区的会话 |
| 右键菜单入口 | 全部四组:编辑器右键(当前文件)、编辑器右键(选中文本)、资源管理器右键(文件/文件夹)、标题栏右键(快捷入口) |
| 「用 DSH 询问」交互 | 弹 VS Code 输入框提问,插件注入「问题 + 文件引用」 |
| 需求 3 项目切换行为 | 全自动:监听工作区变化,自动重启服务 + 幂等注册工作区 |
| 架构方案 | 方案 1:扩展 API 直连,桥接零改动 |

## 2. 技术调研结论(均已在本机 0.1.0-rc.6 实证)

对已安装的 DSH(0.1.0-rc.6)实际探测确认:

1. **HTTP 信封协议可用**:`POST /api/<namespace>.<method>`,请求体 `{"type":"client-request","rpcId","method","payload"}`;Node 直连(无 Origin 头)不受 browser-trust 栅栏限制。响应 `{"type":"server-response","rpcId","result":{"ok":true,"value":...}}`。
2. **方法名用单数 namespace**:`session.list` / `session.create` / `session.prompt` / `session.history`(复数 `sessions.*` 返回 `not found`,已实测区分)。
3. **`workspace.create` 幂等**:`{path}` 已存在时返回同一 workspace(`created:false`);`workspace.list` 返回全部工作区。
4. **`session.list` 项携带 `cwd` 字段**:可按 cwd 精确筛选「当前项目下的会话」,并含 `updatedAt` 排序依据与 `blank`(空白会话)标记。
5. **`session.create` 接受 `cwd`**:新建会话直接绑定项目目录;返回 `sessionId`。
6. **`session.prompt` 注入消息**:`{sessionId, mode:'queue', content:[{type:'text', text}]}`,返回 `accepted:true`,消息进入会话历史(已通过 `session.history` 验证);消息内反引号包裹的路径在 DSH 前端渲染为可点击的 fileMention 按钮。
7. **DSH 无「实时活动文件」API**:AI 上下文 = 会话 cwd + 消息内容 + AGENTS.md 指令文件;会话 cwd 在创建时定死,无更新 API。
8. **DSH 前端模块表**:`__ModuleLoader__` 的 require 仅解析 seed/static/已注册工厂,依赖前端内部结构(非官方契约),不作为本设计依赖。

## 3. 总体架构

### 3.1 新增模块 `src/context/`(纯逻辑、不依赖 vscode、可 node:test 单测)

| 模块 | 职责 |
|---|---|
| `src/context/dshApi.ts` | DSH HTTP 信封协议客户端:泛型 `call(ns, method, payload)`;封装 `workspace.create`、`session.list`、`session.create`、`session.prompt`;错误归一(网络失败 / RPC 错误 / 版本不支持) |
| `src/context/tracker.ts` | 当前文件跟踪器:监听 `onDidChangeActiveTextEditor`;输出 `{ 绝对路径, 相对工作区路径?, 行号范围? }`;路径规则:文件在工作区根内 → 相对路径引用,否则绝对路径引用 |
| `src/context/injector.ts` | 注入编排:定位目标会话(按 cwd 找该项目下最近活动会话,无则 `session.create` 新建)→ 构造消息文本 → `session.prompt` 注入;上下文式措辞抑制 AI 回复 |
| `src/context/controller.ts` | 高层协调(依赖注入 vscode + dshApi):上下文条消息处理、右键命令 handler、自动跟随(防抖,默认 800ms) |

### 3.2 改动模块

| 模块 | 改动 |
|---|---|
| `src/panel/html.ts` | `readyPage` 增加上下文工具条(iframe 上方,约 28px):`📄 当前文件: <basename>  [加入上下文] [自动跟随开关]`;新消息类型 `addFileContext` / `toggleAutoFollow` |
| `src/panel/provider.ts` | 路由新消息;tracker 变更时 `postMessage` 更新工具条当前文件显示 |
| `src/extension.ts` | 装配 controller;注册 6 个新命令;监听 `workspace.onDidChangeWorkspaceFolders` |
| `package.json` | 4 组右键菜单 + 6 个新命令声明 + 2 个新设置项 |
| `src/i18n.ts` + `package.nls*.json` | 全部新文案双语(zh-* 中文 / 其余英文) |

### 3.3 明确不改

- `bridge-client/` 桥接完全不动(保持现有外链跳转/文件跳转职责);
- 不写 DSH 安装目录;不迁移既有会话 cwd(平台限制);
- 不做「注入文件全文」模式;不做方案 3 的「桥接报告选中会话」增强(留待 DSH 前端 API 稳定后另立项)。

## 4. 端到端数据流

### 4.1 功能 1:当前文件上下文联动(半自动)

```
用户在 VS Code 打开/切换文件
  → tracker 捕获 → 计算引用路径(工作区内相对/外绝对)
  → provider postMessage → 面板工具条更新「📄 当前文件: extension.ts」
用户点击 [加入上下文]
  → webview postMessage {type:'addFileContext'} → controller
  → 确保服务运行(未就绪则 ensureRunning)
  → injector:
      1. workspace.create({path:工作区根})      ← 幂等注册
      2. session.list → 筛 cwd==工作区根的全部会话,按 updatedAt 降序取第一个(最近活动)
         无 → session.create({cwd:工作区根})    ← 自动新建
      3. session.prompt({sessionId, mode:'queue',
           text:"上下文:当前文件 `src/extension.ts`(仅供参考,无需回复)"})
  → 提示反馈「已加入 DSH 上下文」
```

自动跟随(设置 `dsh.context.autoFollow=true` 开启):文件切换 → 800ms 防抖 → 若仍停留该文件 → 自动执行上述注入;不弹提示(仅状态栏短暂反馈);同一文件 3 秒内去重。

### 4.2 功能 2:右键菜单

```
编辑器右键「将文件加入 DSH 上下文」  → 同 4.1 注入链路
编辑器右键「用 DSH 询问此文件」     → showInputBox(问题,可空)
                                    → 注入"问题 + `文件引用`"为一条消息(AI 正常回复)
编辑器右键「将选区发送给 DSH」      → showInputBox(说明,可空)
                                    → 注入"说明 + 文件:行号 + 代码块(选区)"
资源管理器右键(文件)              → 「加入上下文」/「用 DSH 询问」同上
资源管理器右键(文件夹)            → 注入目录路径文本(DSH 无目录引用按钮,纯文本提示)
编辑器标题栏右键                  → 快捷入口:打开面板/浏览器打开/重启/停止/复制 URL(复用现有命令)
```

### 4.3 功能 3:工作目录自适应

```
VS Code 工作区变化(打开新文件夹/多根增减)
  → onDidChangeWorkspaceFolders 触发
  → 按 workspaceRootIndex 解析新根(沿用现有规则,越界回退第一根)
  → manager.reconfigure({cwd:新根}) → 服务自动以新 cwd 重启(会话持久化,不丢历史)
  → 服务就绪后 workspace.create({path:新根}) 幂等注册
  → 此后注入定位与新会话均落在新项目
```

边界语义:重启只影响服务进程 cwd 与后续新建会话;无工作区(单文件)时回退 home 目录(现有 resolveWorkspaceRoot 行为)。

## 5. 命令、设置项与菜单清单

### 5.1 新命令(6 个,均进命令面板 `DSH:` 前缀)

| 命令 ID | 标题(中/英) | 行为 |
|---|---|---|
| `dsh.addFileContext` | 将当前文件加入 DSH 上下文 / Add Current File to DSH Context | 注入当前文件引用 |
| `dsh.askAboutFile` | 用 DSH 询问当前文件 / Ask DSH About This File | 输入框提问 + 注入 |
| `dsh.sendSelection` | 将选区发送给 DSH / Send Selection to DSH | 输入框说明 + 注入选区 |
| `dsh.addPathContext` | 将所选文件(夹)加入 DSH 上下文 / Add Selected Path to DSH Context | explorer 菜单专用(带 URI 参数) |
| `dsh.askAboutPath` | 用 DSH 询问所选文件(夹) / Ask DSH About Selected Path | explorer 菜单专用 |
| `dsh.openContextPanel` | 打开 DSH 面板 / Open DSH Panel | 菜单快捷入口(复用 openPanel 逻辑) |

### 5.2 菜单声明(`contributes.menus`)

| 菜单位置 | 条目 |
|---|---|
| `editor/context` | 加入上下文 / 用 DSH 询问 / 发送选区(有选区时显示,`when: editorHasSelection`) |
| `explorer/context`(file) | 加入上下文 / 用 DSH 询问 |
| `explorer/context`(folder) | 加入上下文(目录)/ 用 DSH 询问 |
| `editor/title/context` | 打开 DSH 面板 / 在浏览器打开 / 重启服务 / 停止服务 / 复制 URL |

### 5.3 新设置项

| 设置项 | 默认 | 说明 |
|---|---|---|
| `dsh.context.autoFollow` | `false` | 切换文件时自动把当前文件注入上下文(工具条开关同步显示) |
| `dsh.context.followDebounceMs` | `800` | 自动跟随防抖毫秒数(300–5000) |

## 6. 降级与错误处理

| 场景 | 行为 |
|---|---|
| DSH 服务未运行 | 注入前自动 `ensureRunning`;启动失败 → 警告「DSH 服务启动失败」,操作中止 |
| API 版本不支持(404 / RPC 错误) | 捕获错误码,提示「当前 DSH 版本不支持此操作,请升级 DSH」;不影响面板其他功能 |
| 网络中断/超时 | 超时 5s,提示「DSH 服务未响应」;自动跟随模式下静默跳过(不弹窗) |
| 无工作区(单文件) | 加入上下文仍可用(绝对路径引用);会话按 home cwd 定位 |
| 注入成功 | 半自动:信息提示「已加入 DSH 上下文」;自动跟随:状态栏短暂反馈,不弹窗 |

## 7. 测试计划

### 7.1 单元测试(node:test,沿用现有测试基建)

| 目标 | 覆盖点 |
|---|---|
| `dshApi.ts` | 信封协议构造(rpcId/type/method/payload);响应解析(ok/error);网络错误与超时归一;RPC 错误码透传 |
| `tracker.ts` | 路径规则:工作区内 → 相对引用、区外 → 绝对引用;多根工作区按索引;防抖计时(fake timers) |
| `injector.ts` | 会话定位:按 cwd 筛选最近会话、无则新建;消息措辞(上下文式/提问式);重复注入去重 |
| `controller.ts` | 命令 handler 行为(注入成功/服务未就绪/API 失败三分支);自动跟随开关联动设置项 |
| `html.ts` | 工具条渲染:文件显示、按钮/开关存在性、CSP 兼容(工具条脚本进现有 nonce 通道) |
| `provider.ts` | 新消息路由(addFileContext/toggleAutoFollow → controller) |

### 7.2 集成测试(真实 DSH,沿用 `test/integration/dsh.test.ts` 模式)

1. 启动真实 `dsh web`(随机端口 + DSH_HOME 重定向)→ `workspace.create` 幂等 → `session.list` 定位 → 无会话时 `session.create` → `session.prompt` 注入 → `session.history` 验证消息落地;
2. 工作区切换模拟:reconfigure 后服务 cwd 变化、新会话落在新根。

### 7.3 手动验收清单

- 右键菜单四处可见性与 `when` 条件(选区菜单仅在选中时出现);
- 工具条在浅/深色主题下的样式;
- 自动跟随开关持久化(设置项 ↔ 工具条双向同步);
- 中文/英文文案完整性;
- 浏览器直接打开 DSH 页面时无任何影响。

## 8. 发布

- 版本 **v0.3.0**(新功能,minor);
- README/README.zh 更新:三个新功能说明、新设置项表、右键菜单说明;
- CHANGELOG 记录;
- CI 无需改动(现有 typecheck + test + compile + vsce 流程覆盖);
- Marketplace 发布说明同步。

## 9. 风险与备选

| 风险 | 缓解 |
|---|---|
| DSH 仍为 rc 版,API 形状可能变化 | 本设计全部 API 已实证;`dshApi` 错误归一覆盖「方法不存在/形状变化」场景,失败时优雅降级 + 提示,不破坏现有功能 |
| 注入消息可能触发 AI 回复 | 上下文式措辞「仅供参考,无需回复」压低回复概率;自动跟随默认关闭,用户自主开启 |
| 自动重启服务打断面板会话 | DSH 会话持久化,重启仅重载页面,历史不丢;重启仅发生在工作区切换这一低频事件 |
| 多根工作区切换的根选择歧义 | 沿用现有 `workspaceRootIndex` 规则(越界回退第一根),行为与现状一致 |
