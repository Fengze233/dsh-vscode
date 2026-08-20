## [0.3.0] - 2026-08-20

### 新增

- **SSH Remote 支持（可选）**：远程连接时可在远端运行 dsh，并经 VS Code 隧道在面板中打开。
  新增设置 `dsh.remote.enabled`（默认 `false`）。开启后：扩展在远端宿主管控 dsh（复用优先、自动启动兜底），
  用 `vscode.env.asExternalUri` 建立本地↔远端端口隧道，展示、复制网址与浏览器打开均使用隧道本地 URL；
  关闭时远程窗口显示引导占位页，不启动远端服务。声明 `extensionKind` 优先在工作区（远端）运行。
- **编辑器右上角 DSH 图标**：`editor/title` 贡献 + `dsh.openFromTitle` 命令，点击在编辑器标签栏右上角图标
  打开右侧辅助侧边栏面板（与 Claude Code 同位置）。
- **对话框自由上传图片**：模型无视觉能力时不再报错——桥接客户端在附件加入/拖拽/粘贴时捕获图片字节并去重缓存；
  发送被服务端以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝后，自动把图片经扩展宿主缓存到工作区，
  把图片改为「地址（绝对路径）」随消息重新发出，模型据此自行用图像识别工具查看并正常回答，全程无感；
  页面卸载时清理缓存文件；新增设置 `dsh.image.fallback`（默认 `true`）。普通浏览器/未握手时行为与之前完全一致。
- **新增设置**：`dsh.openInBrowser`（默认 `false`，关闭即默认传 `--no-open`）、
  `dsh.remote.enabled`（默认 `false`）、`dsh.image.fallback`（默认 `true`）。

### 修复

- **dsh 新版默认弹浏览器**：启动 `dsh web` 默认追加 `--no-open`（DSH 上游 `openBrowser` 默认 true），
  不再自动打开浏览器；需要时用 `dsh.openInBrowser=true` 恢复原行为。
- **兼容不支持 `--no-open` 的旧版 dsh（验收修复）**：启动崩溃并伴随换端口级联的问题根因——旧版 dsh 的
  commander 不识别 `--no-open`，报 `unknown option` 后退出且被误判为“端口被抢占”。现用 stderr 识别该根因，
  本次会话自动去掉 `--no-open` 并**原端口**重启，不再陷入换端口级联。
- **图片自由上传真正生效（验收修复）**：① 桥接包版本升至 `0.3.0`，安装器据此对旧装桥接强制重装（此前版本未变不会刷新页面里的桥接代码）；② RPC 线格式对齐——DSH 请求体为 `{ rpcId, payload }`，拦截改按 `payload.content` 判定并按 `{rpcId, payload}` 重构重发；③ 图片落盘 cwd 增加工作区根兜底（此前未传 cwd 会拒绝写入）。注意：图片降级需在**打开工作区文件夹**的窗口内使用（缓存文件落在工作区根）。
- **图片降级重发重构为「无感直发」（本轮验收修复）**：此前被拒响应原样透传给 DSH，导致消息不发且弹「当前模型不支持图像输入」报错。现改为：图片落盘后，协议层用「原文 + 图片：<绝对路径>」重构请求重发，并用**重发成功响应顶替被拒响应**交回 DSH——用户看到的是图片照常发送、模型正常回答，不再有任何报错或降级通知；被拒响应不再透传，`imageFallback` 通知消息与弹窗一并移除（改为 DevTools 诊断日志）。无落盘（未打开工作区）时仍保留原生报错，绝不吞错误。
- **桥接包版本升至 `0.3.1`（本轮交付修复）**：上一版 vsix 已给用户装过桥接 `0.3.0`，新 vsix 若仍随附 `0.3.0`，安装器会判定「版本一致、无需重装」，导致用户侧继续跑旧的降级逻辑、复测必失败——现升至 `0.3.1` 强制安装器覆写旧包；握手诊断日志同步为 `handshake ok, v0.3.1` 供 DevTools 确认新桥接已加载。
- **右上角图标改为鲸鱼图标（验收修复）**：`dsh.openFromTitle` 图标由辅助侧边栏 codicon 改为扩展自带 `assets/whale-icon.svg`。

### 其他

- 桥接消息协议扩展：`saveImage` / `deleteImages`（含握手转发与扩展宿主落盘/删除，
  均为白名单 + 路径安全防护）。
- 回归：既有 v0.2.4 功能（本地面板/双侧栏/命令/状态栏/桥接/端口回退/退出清理/双语）全部保留并有回归测试覆盖。

## [0.2.4] - 2026-08-19

### 修复

- **macOS 上聊天内容无法复制/粘贴/右键（issue #3）**：VS Code 在 macOS 上会吞掉嵌套 iframe 内的 `Cmd+C` / `Cmd+V` / `Cmd+A` 等标准快捷键与右键菜单（上游 bug [microsoft/vscode#129178](https://github.com/microsoft/vscode/issues/129178) / [#180234](https://github.com/microsoft/vscode/issues/180234)，官方未修复）。桥接包在握手后接管这些操作：
  - 捕获 `keydown`，识别 `Cmd/Ctrl+C/V/X/A/Z` 与 `Shift+Insert`，优先用 `document.execCommand` 模拟（此方案由 Flutter DevTools 团队在同类场景验证有效）；
  - **复制/剪切兜底**：`execCommand` 不可用时，把选区文本经剪贴板写桥接交给扩展宿主写入系统剪贴板；
  - **粘贴兜底**：新增剪贴板读取桥接（`vscode.env.clipboard.readText`，无 webview 权限限制），把剪贴板文本插入焦点输入框（textareas 兼容 React 受控组件）；
  - **右键菜单**：捕获 `contextmenu` 弹出自定义菜单（复制/粘贴/剪切/全选/撤销/重做），不再依赖 VS Code 的原生菜单；
  - 未握手（普通浏览器）时保持原生行为完全不变。

## [0.2.3] - 2026-08-17

### 修复

- **DSH 侧栏内代码块「复制」无反应**：双层修复剪贴板在 VS Code 内嵌跨源 iframe 中失效的问题：
  - 给内嵌 DSH 页面的 iframe 显式声明 `allow="clipboard-write"`；
  - 桥接包接管 DSH 页面的 `navigator.clipboard.writeText`：复制文本经面板转发给扩展宿主，由 `vscode.env.clipboard` 写入系统剪贴板，绕开 VS Code 对 webview 跨源 iframe 剪贴板 API 的权限拦截；桥接禁用/未安装时保持 DSH 原生行为不变。

# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.2] - 2026-08-17

### 修复
- **Windows 下服务启动失败（全局 dsh 场景）**：修复 Windows 上「已全局安装 dsh，插件却报未找到 dsh / 服务启动失败」的完整问题链：
  - Windows 改用 `node <bin.js>` 直跑 dsh 入口，规避 spawn `dsh.cmd` 批处理 shim 的 EINVAL；
  - 桥接包安装到三个位置（web profile、profiles 根、npm 全局 node_modules），覆盖 VS Code 扩展宿主进程的模块解析链；
  - 桥接 host 插件改为**零外部依赖的函数式插件**，不再 import `@deepseek-ai/cordis`——npm 全局安装布局下该依赖嵌套在 dsh 包内部，顶层解析不到会导致整个插件树加载失败；
  - 安装器比对桥接包版本，升级插件时自动刷新旧版桥接包；
  - Windows 下改用系统 PATH 中的 `node.exe` 直跑 dsh 入口，不再使用扩展宿主的 `process.execPath`（Electron 的 Code.exe）——Electron 运行时缺少 dsh loader/HMR 依赖的系统 Node 内部特性，会报 `--expose-internals is required` 并崩溃。
- 子进程因端口被残留 dsh 实例占用而崩溃时，自动探测并复用现有服务，不再误报启动失败。
- 启动期间端口被其他程序抢占（如 WSL 与 Windows 共享 localhost 端口、WSL 侧 dsh 慢启动竞态）导致崩溃时，自动改用第一个空闲端口重启，不再报启动失败。

### 新增
- **端口占用自动替换**：`dsh.port` 被其他程序占用时，自动改用第一个空闲端口（仅本次会话临时生效，不修改设置），并弹窗告知临时端口。
- **日志增强**：日志带时间戳与环境信息头（扩展/VS Code/dsh/Node 版本、平台、关键配置）；记录实际启动命令；新增 `DSH: 复制日志` 命令一键复制完整日志用于问题报告。

## [0.2.1] - 2026-08-16

### 修复
- 构建前清空 out 目录，消除删除文件后的产物残留（测试数统计失真）
- 握手 token 改用 crypto 随机数（不可预测）
- retryBridge 失败路径兜底，消除未处理异常

### 改进
- 扩展改为按需激活，减少 VS Code 启动负担
- 新增 GitHub Actions CI（typecheck + 测试 + 打包）
- 新增 Issue/PR 模板与贡献指南
- README 英文主版 + 中文版（README.zh.md，顶部语言互链）

## [0.2.0] - 2026-08-15

### 新增

- **桥接与工作区联动**：通过官方扩展点桥接包，面板与 VS Code 之间新增两项联动能力：
  - 面板内点击外链，在系统默认浏览器中打开；
  - 面板内点击文件路径，在 VS Code 中打开对应文件。
- **桥接命令**：新增 `DSH: 重试桥接安装` 与 `DSH: 卸载桥接` 命令。
- **桥接设置项**：新增 `dsh.bridge.enabled`（默认 `true`）、`dsh.workspaceRootIndex`（默认 `0`）、`dsh.bridge.silenceWarning`（默认 `false`）。

### 移除

- **工作区自动同步**：移除打开面板时自动把 VS Code 工作区同步为 DSH 工作区的联动能力（用户决定放弃）。

### 修复

- **spawn 工作目录兜底**：自启 `dsh web` 时按 `dsh.workspaceRootIndex` 解析工作区根目录作为子进程工作目录，多根工作区不再错误落点。

### 降级与警告

- 桥接未生效时面板完全可用，仅两项联动不可用；插件启动时会弹一次降级警告，可「重试安装」或「不再提示」。

## [0.1.0] - 2026-08-15

### 新增

- DSH 网页界面在 VS Code 侧边栏内嵌显示，支持左右双侧栏入口。
- 服务自动探测 / 启动 / 复用与状态栏四态指示。
- 异常兜底提示页与一键重连、双语界面、退出清理、回环地址安全边界。
