# DSH for VS Code 🐳

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/Fengze233.dsh-vscode-panel?label=Marketplace&color=4D6BFE)](https://marketplace.visualstudio.com/items?itemName=Fengze233.dsh-vscode-panel)
[![GitHub stars](https://img.shields.io/github/stars/Fengze233/dsh-vscode?style=social)](https://github.com/Fengze233/dsh-vscode)
[![DSH 社区插件](https://img.shields.io/badge/DSH%20Plugin-dsh--plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.91-blue)](https://code.visualstudio.com/)

**中文** | [English](README.md)

在 VS Code 中直接使用 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的网页界面：点击侧边栏图标即可内嵌打开 DSH，自动启动/复用 `dsh web` 服务，代码与 AI 界面同屏，无需再切换终端和浏览器。

## 📸 界面截图

![DSH for VS Code 界面截图](docs/screenshots/overview.png)

---

## ✨ 特性

- 🖱️ **一键打开**：左右侧边栏各有一个 DSH 鲸鱼图标，点击即在对应侧栏内嵌显示 DSH 网页；
- 🚀 **服务自动管理**：自动探测端口——已有 `dsh web` 直接复用，没有则后台静默启动，就绪后自动加载；
- 🔄 **状态实时同步**：状态栏四态指示（运行中绿 / 启动中黄 / 失败红 / 已停止灰），点击状态栏可开关面板；
- 🛟 **异常兜底**：端口被占、`dsh` 未安装、启动超时、服务崩溃/失联均有对应提示页与一键重连，绝不白屏；
- 🌐 **双语界面**：文案跟随 VS Code 显示语言——中文环境显示中文，其余语言一律英文；
- 🧹 **退出清理**：关闭窗口自动停止插件自启的服务，不留僵尸进程；手动启动的服务永不干预；
- 🔒 **安全边界**：只连接回环地址（127.0.0.1 / localhost / [::1]），不读取凭据。

## 📥 安装

**方式一：商店安装（推荐）**

VS Code 扩展面板搜索 `DSH`（发布者 Fengze233），或命令行执行：

```bash
code --install-extension Fengze233.dsh-vscode-panel
```

商店页面：<https://marketplace.visualstudio.com/items?itemName=Fengze233.dsh-vscode-panel>

**方式二：下载 .vsix 安装包**

1. 前往 [Releases](https://github.com/Fengze233/dsh-vscode/releases) 下载最新 `dsh-vscode.vsix`；
2. VS Code 中按 `Ctrl+Shift+P` → 执行 `Extensions: Install from VSIX...` → 选择下载的文件；
3. 重载窗口（`Developer: Reload Window`）。

**方式三：从源码构建**

```bash
git clone https://github.com/Fengze233/dsh-vscode.git
cd dsh-vscode
npm install
npm run package        # 产出 dsh-vscode.vsix，再按方式二安装
```

**前置要求**：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh` 命令并位于 PATH 中（插件会自动检测；未安装时会给出提示）。

## 🚀 使用

1. 安装后，**左侧活动栏**与**右侧辅助侧边栏**各出现一个 DSH 鲸鱼图标；
2. 点击任意一个图标：插件自动启动（或复用）`dsh web`，并在该侧边栏内嵌显示 DSH 网页；
   - 点**右侧**图标 → 面板开在右侧，左侧文件目录不受影响；
3. 面板标题栏按钮：`在浏览器中打开` `重启服务` `停止服务` `复制网址` `查看日志`；
4. 底部状态栏显示服务状态，点击可开关面板。

### 命令面板（`DSH:` 开头）

| 命令 | 说明 |
|---|---|
| `DSH: 打开面板` | 打开左侧面板 |
| `DSH: 在辅助侧边栏打开` | 打开右侧面板 |
| `DSH: 在浏览器中打开` | 在系统浏览器打开 DSH 页面 |
| `DSH: 重启服务` | 重启插件管理的服务 |
| `DSH: 停止服务` | 停止插件启动的服务 |
| `DSH: 复制网址` | 复制 DSH 页面地址 |
| `DSH: 查看日志` | 打开插件日志输出通道 |
| `DSH: 重试桥接安装` | 重新安装桥接并重启服务 |
| `DSH: 卸载桥接` | 移除桥接包并还原 `cordis.patch.yml` |

## 🔗 桥接与联动

安装后，插件会在你的 DSH 用户目录安装本扩展的桥接包（经 DSH 官方客户端插件扩展点安装），让面板与 VS Code 联动。启用后获得两项能力：

- 🔗 **外链跳转**：面板内点击外链，在系统默认浏览器中打开（而非被困在 iframe 内）；
- 📂 **文件跳转**：点击面板内的文件路径，在 VS Code 中打开对应文件。

### 安装与卸载机制（透明披露）

为让 DSH 网页能与 VS Code 通信，插件会：

1. 在你的 DSH 用户目录（`$DSH_HOME/profiles/web`，默认 `~/.dsh/profiles/web`）安装本扩展的桥接包 `dsh-vscode-bridge`（经 DSH 官方客户端插件扩展点安装）；
2. 在 `cordis.patch.yml` 中写入一段带 `# dsh-vscode-bridge: begin` / `# dsh-vscode-bridge: end` 标记的 `insert:` 条目，把桥接包注册为 DSH 的官方 client 插件（只写用户目录，绝不触碰 DSH 安装目录）。

如需移除：执行命令 `DSH: 卸载桥接`，插件会按标记精确删除写入的条目并删除桥接目录，自动还原 `cordis.patch.yml` 原文件（你原有的内容不受影响）。

### 桥接相关设置（`dsh.*`）

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.bridge.enabled` | `true` | 是否启用桥接（关闭后不安装、不注入、不弹警告，两项联动不可用） |
| `dsh.workspaceRootIndex` | `0` | 多根工作区时，用第几个根目录作为 `dsh web` 进程工作目录（越界回退第一个） |
| `dsh.bridge.silenceWarning` | `false` | 抑制桥接降级警告（例如在面板之外打开 DSH 页面时） |

### 降级行为

桥接仅在面板内生效。若桥接未生效（例如你在浏览器里单独打开 DSH 页面、或安装失败），面板**完全可用**，只有上述两项联动不可用；插件启动时会弹一次警告，可选择「重试安装」或「不再提示」。

## ⚙️ 设置（`dsh.*`）

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.port` | `3080` | 期望端口（探测与启动共用） |
| `dsh.host` | `127.0.0.1` | 服务地址（仅允许回环地址） |
| `dsh.autoStart` | `true` | 服务未运行时自动启动 |
| `dsh.stopOnExit` | `true` | 关闭最后一个窗口时停止插件自启的服务 |
| `dsh.extraArgs` | `[]` | 启动 `dsh web` 时附加的参数 |

## 🌍 多语言

界面文案跟随 VS Code 显示语言（`Configure Display Language`）：`zh-*` → 简体中文，其余语言 → 英文。

## 🧑‍💻 开发

环境要求：Node.js ≥ 22、VS Code ≥ 1.91。

```bash
npm install
npm run test          # 75 个单元/集成测试（含真实 dsh web 全流程）
npm run compile       # 构建 out/extension.js
npm run watch         # 监听构建
npm run typecheck     # 类型检查
npm run package       # 打包 .vsix
```

调试：VS Code 打开本目录，按 `F5` 启动 Extension Development Host。

```
src/
├── extension.ts          # 入口：装配与命令注册
├── i18n.ts               # 动态文案字典（zh-* 中文 / 其余英文）
├── config.ts             # 设置读取与规范化（loopback 白名单校验）
├── service/
│   ├── detect.ts         # 端口探测（识别 DSH 标记）
│   ├── process.ts        # 跨平台子进程封装（dsh / dsh.cmd）
│   └── manager.ts        # 服务管理器状态机（核心）
├── bridge/               # 桥接：安装器、握手宿主、消息处理、状态评估
├── panel/
│   ├── html.ts           # 面板占位页模板（CSP 最小权限）
│   └── provider.ts       # WebviewViewProvider（iframe + 占位页）
├── workspaceRoot.ts      # 多根工作区解析
└── statusbar.ts          # 状态栏控制器
```

## 🧭 已知限制

- 欢迎页"DSH 入门"卡片的彩色图标来自 Marketplace 画廊数据，仅在商店上架后显示（卡片功能本身不受影响）；
- VS Code 平台规则：左侧图标打开左侧面板、右侧图标打开右侧面板，无法让左侧图标打开右侧面板。

## 🌐 社区

本项目是 DeepSeek Harness 社区插件（话题：[`dsh-plugin`](https://github.com/topics/dsh-plugin)）。

- DSH 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 问题反馈：<https://github.com/Fengze233/dsh-vscode/issues>
- DSH 社区讨论：<https://github.com/deepseek-ai/deepseek-harness/discussions>

## 📄 License

[MIT](./LICENSE) © 2026 Fengze233
