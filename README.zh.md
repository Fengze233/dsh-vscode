# DSH for VS Code 🐳

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/Fengze233.dsh-vscode-panel?label=Marketplace&color=4D6BFE)](https://marketplace.visualstudio.com/items?itemName=Fengze233.dsh-vscode-panel)
[![GitHub stars](https://img.shields.io/github/stars/Fengze233/dsh-vscode?style=social)](https://github.com/Fengze233/dsh-vscode)
[![DSH 社区插件](https://img.shields.io/badge/DSH%20Plugin-dsh--plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.91-blue)](https://code.visualstudio.com/)

**中文** | [English](README.md)

在 VS Code 中直接使用 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的网页界面：点击侧边栏图标即可内嵌打开 DSH，自动启动/复用 `dsh web` 服务，代码与 AI 界面同屏，无需再切换终端和浏览器。

支持 **DSH 0.1.2 及更新版本**（含其一次性 token 浏览器鉴权，自动登录、无需手工操作）——详见 [DSH ≥0.1.2 鉴权与本地代办](#-dsh-012-鉴权与本地代办)。更早的 DSH（≤ 0.1.1，无鉴权）行为不变。

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
- 🔐 **适配 DSH 0.1.2 鉴权**：自动从服务日志解析一次性启动网址，兑换 DSH 的签名会话 cookie（30 天有效，服务重启不失效），并让面板经**本地代办代理**访问 DSH——由代理代示会话。虽然 DSH 的 `SameSite=Strict` cookie 在跨站 iframe 中永远无法使用，内嵌面板照常可用；会话失效时自动重新获取（自启服务）或提示重新粘贴一次（外部启动的服务）；
- 🔝 **编辑器右上角图标**：编辑器标签栏右上角新增 DSH 鲸鱼按钮（与 Claude Code 同位置），点击一键打开右侧 DSH 面板；
- 🌐 **SSH Remote 支持（可选）**：远程连接时可在远端运行 dsh，并经 VS Code 隧道在面板中打开（`dsh.remote.enabled`，默认关闭）；
- 🖼️ **对话框自由上传图片**：模型无视觉能力也能发送图片——图片缓存到工作区并以文件路径引用随消息发出，让模型调用图像工具查看（面板关闭时清理；可用 `dsh.image.fallback` 关闭）；
- 🪟 **不再误弹浏览器**：启动 `dsh web` 默认追加 `--no-open`（需弹浏览器时用 `dsh.openInBrowser` 恢复）。
- 🧠 **文件上下文联动**：面板工具条显示当前文件，可一键加入 AI 上下文；开启自动跟随后，切换文件自动注入当前项目下的最近会话（无则自动新建）；
- 🖱️ **右键菜单**：编辑器、资源管理器、编辑器标题栏均提供「加入上下文 / 用 DSH 询问 / 发送选区」等菜单项；
- 📁 **工作区自适应**：切换 VS Code 工作区自动以新项目为工作目录重启 DSH 服务，并幂等注册 DSH 工作区。

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

## 🔐 DSH ≥0.1.2 鉴权与本地代办

DSH 0.1.2 起强制浏览器鉴权。`dsh web` 启动时会打印一条一次性启动网址：

```
dsh web: http://127.0.0.1:3080/?token=<一次性 token>
```

访问它会返回 `303` 并下发一张签名会话 cookie（`HttpOnly; SameSite=Strict`，按请求 `Host` 绑定，30 天有效）。此后**所有页面与 `/api` 请求都必须携带该 cookie**，否则一律 `401 dsh web authentication required`。

**为什么需要代办**：面板是跨站 iframe（顶层文档为 `vscode-webview://…`），浏览器在这种上下文中**永远不会**回送 `SameSite=Strict` cookie（已用三种顶层文档形态实测验证）。因此 iframe 无论加载什么地址都无法自行登录。

**扩展的做法**（由扩展自己启动的服务全程自动）：

1. 把 `401/403`（响应体含 `dsh web` 特征）识别为「DSH 在运行、需要登录」，而不是「端口被其他程序占用」——这正是此前「服务 15 秒内未就绪 / 端口占用」连环误报的根因；
2. 从子进程输出解析启动网址（日志中 token 打码、错误提示不回显）；
3. 用它兑换一次会话 cookie 并存入扩展私有存储（按 `host:port` 分条，30 天有效，服务重启不失效）；
4. 启动**本地代办代理**（127.0.0.1 随机端口）：面板 iframe 加载代理地址，由代理把全部流量转发给 `dsh web`，同时注入会话 cookie、重写 `Host`，并适配 DSH 的 `/api` browser-trust fence（该 fence 要求 `Origin.host === Host` 且拒绝 `Sec-Fetch-Site: cross-site`，经代理后两者必然不成立——代理作为受信本机中介剥离这些浏览器来源头）。上传、SSE 流、WebSocket 升级均按流透传；
5. 会话若失效（或 DSH 凭据被重置），代理把上游 `401` 反馈给扩展，扩展自动重新获取会话（自启场景）或重新显示登录页。

**如果你自己启动 DSH**（systemd / 终端），扩展读不到那个进程的日志，面板会显示一次性的**登录引导页**：把服务日志里的启动网址粘贴进去即可（如 `journalctl -u dsh -n 100`）。粘贴一次最长可用 30 天，且**服务重启无需重新粘贴**。也可以粘贴裸地址 `http://127.0.0.1:3080/`——对 DSH ≤ 0.1.1（无鉴权）服务这就够了。

**上下文注入同样走这条代办链路**：文件上下文命令（`DSH: 将当前文件加入上下文`、询问/发送选区、自动跟随）对 DSH `/api` 的调用也经本地代办，自动携带会话 cookie 并通过 browser-trust fence；若面板尚未完成登录，最多等待 5 秒再提示。

**关于代办的暴露面**：代理只监听 `127.0.0.1`，且持有 30 天会话，因此本机任意进程（含同机其他用户）只要找到该端口即可驱动该会话——这与 DSH ≤ 0.1.1 直接以无鉴权方式监听 `127.0.0.1:3080` 的暴露面相同，实际更窄（端口随机、需要先扫描）。0.1.2 的鉴权防护对象是「网络暴露与跨站浏览器上下文」，本代理没有重新引入网络暴露。

## 🔗 桥接与联动

安装后，插件会在你的 DSH 用户目录安装本扩展的桥接包（经 DSH 官方客户端插件扩展点安装），让面板与 VS Code 联动。启用后获得三项能力：

- 🔗 **外链跳转**：面板内点击外链，在系统默认浏览器中打开（而非被困在 iframe 内）；
- 📂 **文件跳转**：点击面板内的文件路径，在 VS Code 中打开对应文件；
- 📋 **剪贴板复制**：面板内 DSH 的复制按钮（如代码块复制）改由扩展宿主写入系统剪贴板，绕开 VS Code 对 webview 内跨源 iframe 的剪贴板权限拦截。
- ↩️ **撤销/重做（macOS Cmd+Z / Cmd+Shift+Z，Windows Ctrl+Z / Ctrl+Y）**：VS Code 会吞掉嵌套 iframe 内的标准快捷键；且 DSH 输入框为 React 受控组件、其原生撤销栈为空，`execCommand('undo')` 会失效。桥接在握手后为输入框维护**手动撤销/重做栈**（连续输入按 400ms 归组为一条记录），原生撤销可用时优先原生、失败时手动兜底——修复 issue #6「无法 Cmd+Z 撤销」。

### 安装与卸载机制（透明披露）

为让 DSH 网页能与 VS Code 通信，插件会：

1. 在你的 DSH 用户目录（`$DSH_HOME/profiles/web`，默认 `~/.dsh/profiles/web`）安装本扩展的桥接包 `dsh-vscode-bridge`（经 DSH 官方客户端插件扩展点安装）；
2. 在 `cordis.patch.yml` 中写入一段带 `# dsh-vscode-bridge: begin` / `# dsh-vscode-bridge: end` 标记的 `insert:` 条目，把桥接包注册为 DSH 的官方 client 插件（只写用户目录，绝不触碰 DSH 安装目录）。

如需移除，两种方式任选：
   - **卸载插件**：VS Code 卸载本扩展时会自动执行 `uninstall` 钩子，同样按标记精确删除条目并删除桥接目录（尽力而为，不影响卸载流程）；
   - **仅移除桥接**：执行命令 `DSH: 卸载桥接`，效果相同。

> 版本说明：桥接包版本与插件版本**始终一致**（二者一同随插件包发布到商城），安装器按「版本不一致 → 强制重装」保证逻辑更新触达。

### 桥接相关设置（`dsh.*`）

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.bridge.enabled` | `true` | 是否启用桥接（关闭后不安装、不注入、不弹警告，三项联动不可用） |
| `dsh.workspaceRootIndex` | `0` | 多根工作区时，用第几个根目录作为 `dsh web` 进程工作目录（越界回退第一个） |
| `dsh.bridge.silenceWarning` | `false` | 抑制桥接降级警告（例如在面板之外打开 DSH 页面时） |

### 降级行为

桥接仅在面板内生效。若桥接未生效（例如你在浏览器里单独打开 DSH 页面、或安装失败），面板**完全可用**，只有上述三项联动不可用；插件启动时会弹一次警告，可选择「重试安装」或「不再提示」。

## 🆕 v0.4.0 新特性

- **支持 DSH 0.1.2（浏览器鉴权）**：自动登录（捕获启动网址 → 兑换会话 → 30 天 cookie），并让面板经本地代办代理访问 DSH，内嵌体验在 `SameSite=Strict` 会话模型下照常可用；外部启动的服务提供一次性粘贴登录页。详见 [DSH ≥0.1.2 鉴权与本地代办](#-dsh-012-鉴权与本地代办)。
- **修复 DSH 0.1.2 下「服务 15 秒未就绪 / 端口占用」连环误报**：鉴权 401 现在被正确识别为「DSH 在运行、需要登录」。
- **修复面板内 `/api` 403**（设置页「加载提供方目录失败」、工作区/会话列表空白）：代办以受信本机中介身份适配 DSH 的 browser-trust fence（`Origin`/`Sec-Fetch-*`）。
- **修复 DSH 0.1.2 下图片降级失效**（完全发不出图片）：桥接同时支持两代 RPC 线格式——斜杠端点（`session/prompt`）、`payload.args.request` 包装、以及 `session/attachment-invalid` 拒绝码。
- **WSL Remote 修复**（issue #13）：握手不再依赖 iframe `load` 事件、`postMessage` 使用 `'*'`（webview service worker 会重写 iframe origin）、CSP `frame-src` 只由最终地址推导、WSL 与 SSH 远程分开归类（WSL 走 localhost 直连、不需隧道）、握手超时按远程类型放宽。
- **环境信息头在 Linux/macOS 下也能显示 dsh 版本**（符号链接感知的包定位）。

## 🆕 v0.3.0 新特性

- **编辑器右上角图标**：标签栏右上角的鲸鱼按钮一键打开右侧面板（命令 `DSH：打开右侧面板`）。图标为**原鲸鱼 + 白底**（`whale-icon-bg.svg`），深色/浅色主题下都清晰可见；左侧活动栏与右侧辅助侧边栏保持原始鲸鱼图标不变。
- **SSH Remote**：开启 `dsh.remote.enabled` 后，插件在远端宿主运行、在远端启动/复用 `dsh`，并经 VS Code 隧道在本地面板展示——本地窗口保持干净，远端服务仍只监听 `127.0.0.1`。
- **非视觉模型也能发图（无感直发）**：在对话框里自由上传图片；当当前模型无图像输入能力时，图片保存到你的工作区，消息以「原文 + `图片：<绝对路径>`」直接发出——不报错、不弹提示，模型据此调用图像识别工具查看并正常回答；仅对支持视觉的模型才会以原生方式上传图片。
- **不再自动弹浏览器**：`dsh web` 以 `--no-open` 启动，插件不再弹出浏览器窗口；需要时可用 `dsh.openInBrowser` 恢复。

## 🧠 上下文联动

面板工具条显示当前文件，提供「加入」按钮与「自动跟随」开关：点击「加入」即可把当前文件注入 AI 上下文；开启自动跟随后，切换文件时自动把当前文件注入当前项目下的最近会话（无会话则自动新建）。

### 上下文联动设置（`dsh.context.*`）

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.context.autoFollow` | `false` | 切换文件时自动把当前文件注入 AI 上下文 |
| `dsh.context.followDebounceMs` | `800` | 自动跟随防抖毫秒数(300-5000) |

### 右键菜单

- 编辑器：加入上下文 / 用 DSH 询问 / 发送选区；
- 资源管理器：加入上下文 / 用 DSH 询问；
- 编辑器标题栏：打开面板 / 浏览器打开 / 重启 / 停止 / 复制 URL。

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
| `dsh.image.fallback` | `true` | 当前模型无视觉能力时，把上传图片以文件路径形式随消息发送而不报错（文件缓存在会话工作目录，面板关闭时清理） |

## 🌍 多语言

界面文案跟随 VS Code 显示语言（`Configure Display Language`）：`zh-*` → 简体中文，其余语言 → 英文。

## 🧑‍💻 开发

环境要求：Node.js ≥ 22、VS Code ≥ 1.91。

```bash
npm install
npm run test          # 285 个单元/集成测试（含真实 dsh web 全流程：服务生命周期、鉴权会话、上下文注入）
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
- 图片降级：缓存文件放在**工作区根目录**——**需先打开一个工作区文件夹**（未打开文件夹时无法落盘缓存，也就不做降级）。**临时图“模型看完即删”**：同会话发出下一条消息时立即删除上一批（模型已读完并回答）；若不再发消息，约 2 分钟后自动删除兜底；会话新建/删除/切换、面板关闭/页面卸载与扩展停用也都会清理（尽力而为）。扩展激活时会自动扫描清理上次会话遗留的 `dsh-imgcache-*` 孤儿；也可随时运行命令 **`DSH: 清理图片缓存`** 一键清除。
- **复测如何确认桥接已更新**：在 DSH 面板 DevTools（开发者工具）Console 中应看到 `[dsh-vscode-bridge] handshake ok, **v0.4.0**, imageFallback=true` 与传图发送后的 `image fallback: 已把图片改为地址随消息重发（N 张）: …` 日志；若仍显示旧版本，说明旧桥接未重装——请重启 DSH 服务（vsix 随附桥接版本 `0.4.0`，安装器在版本不一致**或 `client.js` 内容不一致**时都会强制重装，同版本重新打包同样会刷新）。
- **外部启动的 DSH（≥ 0.1.2）**：扩展读不到其它进程的日志，首次登录需要粘贴一次启动网址（之后 30 天无需重复）——见 [DSH ≥0.1.2 鉴权与本地代办](#-dsh-012-鉴权与本地代办)。
- **窄视口中文光标（上游问题）**：面板宽度约 300–400px 时，光标可能落在最后一个中文字符中间。这是 DSH 网页前端的问题（记录于 [issue #9](https://github.com/Fengze233/dsh-vscode/issues/9)）；0.1.2 起上游已重写输入框组件，且本扩展无法修改 DSH 页面内部代码——调查结论见该 issue。
- `--no-open` 默认传给 `dsh web`；若在 `dsh.extraArgs` 或 `dsh.openInBrowser` 显式选择弹浏览器，则按你的选择执行。

## 🌐 社区

本项目是 DeepSeek Harness 社区插件（话题：[`dsh-plugin`](https://github.com/topics/dsh-plugin)）。

- DSH 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 问题反馈：<https://github.com/Fengze233/dsh-vscode/issues>
- DSH 社区讨论：<https://github.com/deepseek-ai/deepseek-harness/discussions>

## 📄 License

[MIT](./LICENSE) © 2026 Fengze233
