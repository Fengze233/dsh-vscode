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

## 🎬 演示视频

[![如何在 VSCode 中使用 DeepSeek Harness？用 DSH！！（Bilibili）](docs/screenshots/video-cover.jpg)](https://www.bilibili.com/video/BV1p8bD6dE18)

*B 站 59 秒演示视频：[BV1p8bD6dE18](https://www.bilibili.com/video/BV1p8bD6dE18)*

---

## ✨ 特性

- 🖱️ **一键打开**：左右侧边栏各有一个 DSH 鲸鱼图标，点击即在对应侧栏内嵌显示 DSH 网页；
- 🚀 **服务自动管理**：自动探测端口——已有 `dsh web` 直接复用，没有则后台静默启动，就绪后自动加载；
- 🔄 **状态实时同步**：状态栏四态指示（运行中绿 / 启动中黄 / 失败红 / 已停止灰），点击状态栏可开关面板；
- 🛟 **异常兜底**：端口被占、`dsh` 未安装、启动超时、服务崩溃/失联均有对应提示页与一键重连，绝不白屏；配置端口被其他程序占用时自动改用第一个空闲端口（仅本次会话临时生效）；
- 🌐 **双语界面**：文案跟随 VS Code 显示语言——中文环境显示中文，其余语言一律英文；
- 📋 **复制/粘贴/右键开箱即用**：修复 VS Code 内嵌环境下（尤其是 macOS）聊天内容无法 `Cmd+C` 复制、`Cmd+V` 粘贴、右键无菜单的问题——面板内置标准编辑快捷键仿真与右键菜单（复制/粘贴/剪切/全选/撤销/重做），普通浏览器打开与原有功能完全不受影响；
- 🧹 **退出清理**：关闭窗口自动停止插件自启的服务，不留僵尸进程；手动启动的服务永不干预；
- 🔒 **安全边界**：只连接回环地址（127.0.0.1 / localhost / [::1]），不读取凭据。
- 🔝 **编辑器右上角图标**：编辑器标签栏右上角新增 DSH 鲸鱼按钮（与 Claude Code 同位置），点击一键打开右侧 DSH 面板；
- 🌐 **SSH Remote 支持（可选）**：远程连接时可在远端运行 dsh，并经 VS Code 隧道在面板中打开（`dsh.remote.enabled`，默认关闭）；
- 🖼️ **对话框自由上传图片**：**已停用（默认关闭）**——新版 DSH 已原生支持图片；仅在 `dsh.image.fallback=true` 时启用降级逻辑，相关代码待删除；
- 🪟 **不再误弹浏览器**：启动 `dsh web` 默认追加 `--no-open`（需弹浏览器时用 `dsh.openInBrowser` 恢复）。

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
   - 若 `dsh.port` 被其他程序占用，插件会自动改用第一个空闲端口（仅本次会话临时生效，设置不变，弹窗告知临时端口）；
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
| `DSH: 复制日志` | 把完整日志（环境信息 + 服务日志）复制到剪贴板，用于问题报告 |
| `DSH: 重试桥接安装` | 重新安装桥接并重启服务 |
| `DSH: 卸载桥接` | 移除桥接包并还原 `cordis.patch.yml` |

## 🔗 桥接与联动

安装后，插件会在你的 DSH 用户目录安装本扩展的桥接包（经 DSH 官方客户端插件扩展点安装），让面板与 VS Code 联动。启用后获得三项能力：

- 🔗 **外链跳转**：面板内点击外链，在系统默认浏览器中打开（而非被困在 iframe 内）；
- 📂 **文件跳转**：点击面板内的文件路径，在 VS Code 中打开对应文件；
- 📋 **剪贴板复制**：面板内 DSH 的复制按钮（如代码块复制）改由扩展宿主写入系统剪贴板，绕开 VS Code 对 webview 内跨源 iframe 的剪贴板权限拦截。

### 安装与卸载机制（透明披露）

为让 DSH 网页能与 VS Code 通信，插件会：

1. 在你的 DSH 用户目录（`$DSH_HOME/profiles/web`，默认 `~/.dsh/profiles/web`）安装本扩展的桥接包 `dsh-vscode-bridge`（经 DSH 官方客户端插件扩展点安装）；
2. 在 `cordis.patch.yml` 中写入一段带 `# dsh-vscode-bridge: begin` / `# dsh-vscode-bridge: end` 标记的 `insert:` 条目，把桥接包注册为 DSH 的官方 client 插件（只写用户目录，绝不触碰 DSH 安装目录）。

如需移除：执行命令 `DSH: 卸载桥接`，插件会按标记精确删除写入的条目并删除桥接目录，自动还原 `cordis.patch.yml` 原文件（你原有的内容不受影响）。

### 桥接相关设置（`dsh.*`）

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.bridge.enabled` | `true` | 是否启用桥接（关闭后不安装、不注入、不弹警告，三项联动不可用） |
| `dsh.workspaceRootIndex` | `0` | 多根工作区时，用第几个根目录作为 `dsh web` 进程工作目录（越界回退第一个） |
| `dsh.bridge.silenceWarning` | `false` | 抑制桥接降级警告（例如在面板之外打开 DSH 页面时） |

### 降级行为

桥接仅在面板内生效。若桥接未生效（例如你在浏览器里单独打开 DSH 页面、或安装失败），面板**完全可用**，只有上述三项联动不可用；插件启动时会弹一次警告，可选择「重试安装」或「不再提示」。

## 🆕 v0.3.0 新特性

- **编辑器右上角图标**：标签栏右上角的鲸鱼按钮一键打开右侧面板（命令 `DSH：打开右侧面板`）。
- **SSH Remote**：开启 `dsh.remote.enabled` 后，插件在远端宿主运行、在远端启动/复用 `dsh`，并经 VS Code 隧道在本地面板展示——本地窗口保持干净，远端服务仍只监听 `127.0.0.1`。
- **非视觉模型也能发图**：在对话框里自由上传图片；当当前模型无图像输入能力时，图片会保存到你的工作区，消息以文件路径引用重新发送，模型可用图像识别工具查看（你的图片内容不会丢失）。
- **不再自动弹浏览器**：`dsh web` 以 `--no-open` 启动，插件不再弹出浏览器窗口；需要时可用 `dsh.openInBrowser` 恢复。

## ⚙️ 设置（`dsh.*`）

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.port` | `3080` | 期望端口（探测与启动共用） |
| `dsh.host` | `127.0.0.1` | 服务地址（仅允许回环地址） |
| `dsh.autoStart` | `true` | 服务未运行时自动启动 |
| `dsh.stopOnExit` | `true` | 关闭最后一个窗口时停止插件自启的服务 |
| `dsh.extraArgs` | `[]` | 启动 `dsh web` 时附加的参数 |
| `dsh.executablePath` | `""` | dsh 可执行文件绝对路径（Windows 为 dsh.cmd）；留空则从 PATH 查找 |
| `dsh.openInBrowser` | `false` | 服务启动后在默认浏览器中打开 DSH 页面（关闭时向 `dsh web` 传递 `--no-open`） |
| `dsh.remote.enabled` | `false` | 启用远程场景（SSH Remote / WSL / Dev Containers / Codespaces）：在远端运行 dsh，经 VS Code 隧道在面板中打开（默认关闭；开启后需重载窗口生效） |
| `dsh.image.fallback` | `false` | **默认关闭（待删除）**。开启时：当前模型无视觉能力，把上传图片以文件路径形式随消息发送而不报错（文件缓存在工作区根，随后清理） |

## 🌍 多语言

界面文案跟随 VS Code 显示语言（`Configure Display Language`）：`zh-*` → 简体中文，其余语言 → 英文。

## 🧑‍💻 开发

环境要求：Node.js ≥ 22、VS Code ≥ 1.91。

```bash
npm install
npm run test          # 161 个单元/集成测试（含真实 dsh web 全流程）
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
- SSH Remote：远端也需安装本插件（VS Code 会引导）；隧道会出现在「端口(Ports)」视图，用户可手动关闭，插件在下次就绪时自动重建。
- 图片降级**默认关闭**（`dsh.image.fallback=false`）且**待删除**（新版 DSH 原生支持图片）。若重新开启：缓存文件放在**工作区根目录**——**需先打开一个工作区文件夹**；缓存在面板关闭/页面卸载/扩展停用时清理（尽力而为）。
- `--no-open` 默认传给 `dsh web`；若在 `dsh.extraArgs` 或 `dsh.openInBrowser` 显式选择弹浏览器，则按你的选择执行。

## 🌐 社区

本项目是 DeepSeek Harness 社区插件（话题：[`dsh-plugin`](https://github.com/topics/dsh-plugin)）。

- DSH 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 问题反馈：<https://github.com/Fengze233/dsh-vscode/issues>
- DSH 社区讨论：<https://github.com/deepseek-ai/deepseek-harness/discussions>

## 📄 License

[MIT](./LICENSE) © 2026 Fengze233
