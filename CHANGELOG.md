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
