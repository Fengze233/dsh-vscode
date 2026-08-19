# DSH for VS Code v0.3.0 设计文档

> 日期：2026-08-20
> 版本：v0.3.0
> 前置：v0.2.4（origin/main）
> 开发分支：v0.3.0（保持 main 干净）
> 状态：评审修订版（已纳入用户 5 条补充要求）

## 0. 背景与目标

面向下一代 v0.3.0，四项能力：

1. 支持 VS Code SSH Remote：连接上在远端服务器上运行的 dsh（Github 用户建议）。
2. 编辑器标签栏右上角显示 DSH 图标（对标 Claude Code），点击打开右侧辅助侧边栏面板。
3. 对话框自由上传图片：模型无视觉能力时不再报错，图片仍能“发送出去”，由模型自行决定用图像识别工具查看。
4. DSH 新版默认弹浏览器的问题探查与修复。

## 1. 需求 1 —— SSH Remote 支持

### 1.1 事实与根因（已探查确认）
- 当前扩展未声明 extensionKind，VS Code 在 SSH Remote 下默认把扩展宿主放在**远端**运行：
  探测/启动的 dsh 天然跑在远端，127.0.0.1:3080 探测、健康检查均正常。
- 唯一坏点：面板 iframe src=http://127.0.0.1:3080/ 在本地浏览器解析到**本机**回环，连不到远端 → 面板无法加载。
- DSH 远端启动的 dsh web 检测 SSH_CONNECTION/SSH_TTY 会自动跳过弹浏览器（上游 launchedThroughSsh）；插件本轮还默认加 --no-open，远程窗口不会误弹。
- DSH 的 client↔server 用 WebSocket 下行（/api/events.mux、/api/events.host），故不能使用只能转 HTTP 的 WebviewPortMapping，必须用 TCP 级隧道。

### 1.2 方案（远端起、本地看）
- 声明 "extensionKind": ["workspace", "ui"]：明确优先在工作区（远端）运行，避免被判定为 UI 扩展跑回本地。
- 新增设置 dsh.remote.enabled（boolean，**默认 false**，用户补充要求 #1/#2）：
  - 默认关闭：在远程窗口里插件不做任何远端 dsh 行为（不启动/不接管/不建隧道）；
    打开面板显示明确占位页“SSH Remote 支持未开启”+[打开设置] 按钮，并提示开启后需重载窗口生效。
    本地（非远程）窗口完全不受此设置影响，行为照旧。
  - 开启后：进入 B 模式（复用优先、自动启动兜底）+ asExternalUri 隧道。
  - 目的：让“已有 Remote-SSH 但不想在远端跑 DSH”的用户保持默认关闭即可自由禁用（补充要求 #1）；
    且默认关闭避免不需要该功能的多数用户被误触发（补充要求 #2）。
- 服务就绪后，扩展宿主调用 vscode.env.asExternalUri(http://127.0.0.1:<真实端口>/)：
  - 非远程：原样返回（no-op），与本地行为完全一致；
  - 远程：VS Code 自动建立“远端 127.0.0.1:port ↔ 本地”端口转发隧道，返回本地可达 URI。
- 面板 frame-src（CSP）、iframe src、“复制网址”/“在浏览器打开”全部使用解析后的本地 URI。
- 端口随时可能变化（含端口回退）：每次进入 ready 时重新解析，不长期缓存。
- 远端 dsh 仍只监听 127.0.0.1，不暴露局域网；隧道由 VS Code 托管，安全边界不变。

### 1.3 用户使用动线（B 模式：复用优先、自动启动兜底）
1. 目标服务器可 SSH 登录且装有 dsh CLI。
2. VS Code 用官方 Remote-SSH 连接服务器（VS Code 标准步骤，与插件无关）。
3. 在 “SSH: host” 窗口中，将 DSH 插件安装到远端（VS Code 引导，只装一次）。
4. 打开 DSH 面板 → 插件在远端探测：有 dsh 复用（不杀别人进程）；无则自动启动 dsh web --no-open（cwd=工作区）。
5. 自动建隧道 → 面板加载 → 本地窗口照常对话。
6. 关窗停“自己启动的”dsh；远端手动跑的分毫不动。
- 无任何“SSH 模式”开关；本地窗口行为不变。
- 隧道显示在 VS Code “端口(Ports)”视图，用户可关；下次 ready 自动重建。

### 1.4 改动点
- package.json：extensionKind；可能新增 dsh.remote.* 或复用现有设置。
- src/panel/provider.ts：ready 渲染前先 asExternalUri 解析 URL，再构建 iframe/CSP。
- src/extension.ts：openExternal/copyUrl 使用解析后 URL（openExternal 本身会自动解析，复制 URL 需显式解析）。
- src/i18n.ts：新增相关文案（如有）。

## 2. 需求 2 —— 右上角图标

### 2.1 机制（已确认）
- VS Code 通过 contributes.menus."editor/title" 的 navigation 组 + 带 icon 的命令，在编辑器标签栏右上角渲染图标按钮（Claude Code 同款机制）。

### 2.2 方案
- 新增命令 dsh.openPanelIcon（或复用），配置 icon: "$(layout-sidebar-right)"（或新增专用 SVG），menus."editor/title"、组 navigation@0、无 when（始终显示）。
- 命令行为：打开**右侧辅助侧边栏面板**（等价于 openSecondary 的聚焦逻辑）。
- 本地化：package.nls.json / package.nls.zh-cn.json 补标题。

### 2.3 改动点
- package.json contributions（commands + menus）。
- src/extension.ts 注册命令。
- 本地化文件。

## 3. 需求 3 —— 对话框自由上传图片

### 3.1 事实与根因（已探查确认）
- DSH 服务端在 prompt RPC 发送前与 selectModel RPC 切换模型时，检查当前模型 inputModalities 是否含 image，不含则拒绝（文案形如 Model "X" does not support image input，reason=MODEL_DOES_NOT_SUPPORT_IMAGES）。**检查在服务端**。
- 前端（dsh-client-ui-conversation）上传时不按模型能力禁用选择器；是发送时才被拒。
- inputModalities 来自模型提供方适配器元数据（pi-ai 模型目录），无插件层覆盖钩子；且真正无视觉的模型在 provider API 层也无法接收 image 块 → 硬塞 image 块走不通。

### 3.2 方案（正常走原生；被拒时自动降级）
- 模型支持视觉：图片照常以 image 块发送，不做任何干预（符合“让模型自己决定”）。
- 模型不支持视觉：prompt 返回 attachment-error（reason=MODEL_DOES_NOT_SUPPORT_IMAGES）。
  桥接客户端插件拦截该次发送并自动降级：
  1. 将图片字节经桥接交给扩展宿主，**缓存**到 DSH 会话 cwd（默认=工作区根，文件名去碰撞，如 <ts>_<idx>.png）；
  2. 用纯文本重发：原文 + 图片指针（如 [已附图片: <path>，可用图像识别工具查看]），不再带 image 块；
  3. 无视觉模型收到“这是图片 + 文件路径”，自行决定调用哪个图像识别 MCP 工具读图（用户已定：纯路径、插件不探测/不指定工具）。
- **缓存与清理（用户补充要求）**：图片字节在“附件加入/拖拽/粘贴”时即捕获并缓存（不依赖 base64 取回，
  纯本地写文件）；当前会话**结束/暂停/停止**后自动删除这些缓存文件，避免长期占用工作区存储；
  插件卸载/桥接禁用时也做兜底清理。挂接在客户端会话生命周期事件（running→completed/pending）上。
- 有失败重试保护：降级后重发仍失败则把提示转成可见文案，不静默吞错。
- 落盘目标、识别策略不写死：指针格式、缓存文件名前缀与清理时机可配置（预留）。

### 3.3 设置项
- dsh.image.fallback（boolean，默认 true）：非视觉模型自动降级开关；关=恢复上游原生报错。
- （预留）dsh.image.filePrefix 等，本轮默认即可。

### 3.4 桥接协议扩展
- 新增上行消息：saveImage（扩展宿主→写文件→回 saveImageAck：ok、path）或等价命名。
- 新增上行消息：deleteImages（扩展宿主→删除一批缓存文件→回 deleteImagesAck：ok；会话结束/清理用）。
- 把 DSH 发送被拒事件交给桥接：桥接在 DSH 页面内捕获 prompt 的 attachment-error（reason=MODEL_DOES_NOT_SUPPORT_IMAGES）即可。
- 会话生命周期挂钩：客户端插件订阅会话状态（running→completed/暂停/停止/离开列表）触发 deleteImages；
  插件卸载/桥接禁用时 sync 清理缓存。
- 握手、非桥接（普通浏览器）场景：保持原生行为不变。

### 3.5 技术探测点（实现期再确认）
- 桥接在“附件加入/粘贴/选择”时捕获文件字节（document 级监听 change/drop/paste），与 DSH 自身附件流程解耦；
  捕获时去重（同一文件只缓存一份），并记录所属字节供降级重发与删除使用。
- 不再依赖 base64 取回（用户补充要求：缓存即落盘，无需 attachment RPC 回捞）。
- 客户端如何感知“当前模型无视觉”：不必预判，直接走“发送→被拒→降级重发”的反馈环。
- 会话生命周期事件的确切形状（哪个服务/事件能拿到 running→completed）实现期确认，挂哪里以实测为准。

### 3.6 改动点
- bridge-client/lib/core.js：新增 saveImage 消息构造/解析纯函数（可单测）。
- bridge-client/lib/client.js：拦截发送被拒 + 捕获图片 + 降级重发 + 提示。
- src/bridge/host.ts：处理 saveImage（写文件，白名单/路径安全）。
- src/panel/html.ts：扩展 PanelMessage 类型；握手脚本转发新消息类型。
- src/panel/provider.ts：分发 saveImage 到 host。
- src/extension.ts / src/config.ts：新增 dsh.image.fallback 配置。
- 测试：bridge 纯函数单测、host 写文件路径安全单测、i18n。

## 4. 需求 4 —— dsh 新版默认弹浏览器

### 4.1 事实与根因（已探查确认）
- dsh-web-app 的 startup.js：--no-open 默认**打开**浏览器（openBrowser 默认 true）；仅当传 --no-open 或进程经 SSH 启动（launchedThroughSsh）才跳过。
- 插件启动命令为 dsh web --host <host> --port <port> ...extraArgs，**未传 --no-open** → 新版 dsh 启动即弹浏览器。

### 4.2 方案（用户已拍板）
- 插件启动 dsh web 时默认追加 --no-open。
- 新增设置项 dsh.openInBrowser（boolean，默认 false）：为 true 时不传 --no-open（恢复上游弹浏览器行为）。
- 说明：extraArgs 仍可覆盖（若用户自行传 --no-open/不传则按 extraArgs 与开关的合成结果）。

### 4.3 改动点
- src/service/process.ts：startDsh 组装参数时按开关加 --no-open。
- src/config.ts：新增 openInBrowser。
- src/extension.ts：ManagerOptions 传递。
- 本地化 + 测试。

## 5. 非功能性约束

- 与用户的所有交流使用中文；代码注释使用中文。
- 纯逻辑（process/detect/config/bridge core/host 等）保持不依赖 vscode，可 node:test 单测。
- 安全边界：远端仍只连回环；图片落盘只写会话 cwd 白名单内路径；未握手（普通浏览器/桥接禁用）时保持上游原生行为。
- 测试后清理残留进程（含远端测试留下的进程）。

## 5.1 回归测试（补充要求 #3）

- 保证 v0.2.4 既有功能全部不回归：本地面板、双侧栏入口、命令面板命令、状态栏、桥接
  （外链跳转/文件跳转/剪贴板）、端口回退、退出清理、双语、CSP 注入。
- 显式回归用例：npm run test 全量单测/集成测试必须通过；对本次改动涉及的模块
  （process/config/provider/host/html/bridge core/client）各自补测试。
- 附：浏览器/扩展宿主实机验证本地面板与 SSH Remote 面板均正常（环境允许时）。

## 5.2 分支与发布（补充要求 #4/#5）

- 开发在独立分支 v0.3.0 进行，随时推送到 GitHub（仅 GitHub 走代理 127.0.0.1:11888，
  不配全局代理）；origin/main 保持干净，v0.3.0 验收通过后再合并/发版。
- 交互/提交信息全部中文；提交身份 Fengze233 <ni125803@163.com>。
- 发布流程保持与 v0.2.x 一致：npm run package 产出 dsh-vscode.vsix →
  vsce publish 上传插件市场，用户仍可一键下载安装（补充要求 #5）。
- 更新 README（中英）、CHANGELOG、package.nls.* 本地化。
- 发布前检查是否泄露敏感信息（API key/路径/邮箱/本机用户名等）。

## 6. 版本与发布

- package.json version → 0.3.0。
- CHANGELOG 新增 0.3.0 条目。
- README（中英）更新特性与设置说明。
- 发布 dsh-vscode.vsix，git tag v0.3.0。

## 7. 待确认/风险

- 图片捕获方式（3.5）：已定“附件时捕获字节 → 缓存落盘”，仍须实现期实测事件去重与打包顺序（R1）。
- 图片缓存清理时机：依赖客户端会话生命周期事件，其确切形状实现期确认；清理失败时不做硬失败，由卸载兜底。
- 远端隧道在“无工作区窗口”场景下 asExternalUri 的行为需实测（R2）。
- editor/title 图标在特定主题下可读性（codicon 优先，深/浅色 SVG 双主题兜底）。
- 图片“降级重发”须幂等：被拒项不重复入队、草稿正确替换（R4）。
- --no-open 与 dsh.extraArgs 的合成规则需纯函数单测（R5）。
