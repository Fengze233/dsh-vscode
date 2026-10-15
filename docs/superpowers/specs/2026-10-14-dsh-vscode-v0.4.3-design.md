# v0.4.3 设计：整合 PR #35 并修复 #30–#33

- 日期：2026-10-14
- 分支：`feat/v0.4.3`（从 `main` = `75abca4` = v0.4.2 拉出）
- 开发期版本号：`0.4.3-test1`、`0.4.3-test2`……（npm/VS Code 均接受的预发布写法；与 0.4.2 开发期一致）
- 正式版本号：`0.4.3`，**仅在用户真机验收通过并明确同意后**合并 `main` 并发布
- 提交身份：`Fengze233 <ni125803@163.com>`

## 1. 目标与范围

本版做两件事：

1. **整合 PR #35**（社区贡献 @jubeater，「支持配置自定义 DSH profile」，Closes issue #34），采用 merge 方式进入 `feat/v0.4.3`，保留原作者身份与提交历史；
2. **修复 4 个已重开的 issue**：#30、#31、#32、#33，并顺带修掉 PR #35 引入的两个隐患（握手时序、卸载钩子符号链接）。

用户验收通过后合并 `main` 并发布 `0.4.3`；本版不自动发布到市场。

### 非目标（明确不做）

- 旧 profile 桥接残留的自动迁移（PR #35 的 Minor 项）；
- `PROFILE_NAME_PATTERN` 正则字面量在 `src/config.ts` 与 `package.json` 之间的去重；
- `src/service/process.ts` 中 `webArgs` 变量改名；
- 任何与上述目标无关的重构。

## 2. 背景与根因

### 2.1 Windows 上的启动链路与两种装法

Windows 上安装出来的 `dsh` 是批处理 `dsh.cmd`，Node v22+ 禁止 `spawn()` 直接执行 `.cmd`（同步抛 `EINVAL`）。插件当前绕法（`src/service/process.ts`）：

1. 取 `dsh.cmd` 绝对路径：`dsh.executablePath` 优先，否则 `findInPath('dsh.cmd')`，找不到抛 `ENOENT`（`dsh.cmd not found in PATH`）；
2. `binJsFromShim()` 直接拼 `<dsh.cmd 所在目录>/node_modules/@deepseek-ai/dsh/lib/bin.js`；
3. 解析系统 PATH 的 `node.exe`；
4. 执行 `node.exe <bin.js> --host … --port … --no-open`。

第 2 步只对 **npm 全局安装**成立（npm 的 shim 正是转发到该 bin.js）。**DSH Desktop** 的命令是 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，其为自定义转发脚本（向上跳级运行 `DeepSeek Harness.exe`），同目录无 `node_modules` 布局 → 拼出不存在的 bin.js → `MODULE_NOT_FOUND`，并被误判为端口占用而换端口重试，最终失败。

DSH Desktop 的「将 Desktop 命令添加到终端」对话框会把上述 `dsh.cmd` 注册进 PATH；此后 `findInPath` 能命中，**#31 消失、但 #30 依旧**（#30 与 PATH 无关）。

### 2.2 四个 issue 的现状（v0.4.2 = main 上逐条核对确认）

| Issue | 现状 |
|---|---|
| #30 | `binJsFromShim` 无存在性校验；`startDsh` 只要 `executablePath` 不以 `.js` 结尾就一律推导 → Desktop 场景必失败 |
| #31 | 仅查 PATH 的 `dsh.cmd`，无 Desktop 默认目录兜底；报错文案未给出路 |
| #32 | 桥接 `buildOpenFileMessage(path)` 单参调用（`bridge-client/lib/client.js`），从不发 `cwd`；宿主 `resolveBridgePath` 的 cwd 分支为死代码 |
| #33 | `src/panel/provider.ts` 用 `vscode.window.showTextDocument` 打开文件，二进制（png/pdf）必抛 `File seems to be binary…` |

## 3. 已确认的需求决策

| 编号 | 决策 |
|---|---|
| 执行规则 | 首选存在 → 用首选；首选不存在但另一种存在 → **自动回退**并在日志写明实际来源；都不存在 → 弹提醒（与现状一致） |
| D1 | 新增 `dsh.launchPreference`：枚举 `"auto" \| "npm" \| "desktop"`，默认 `"auto"`（auto = npm 优先，没有再桌面端） |
| D2 | 新增 `dsh.desktopCommandPath`：默认空串 = 自动探测；填了但文件不存在 → **不弹错**，退回探测并在日志说明 |
| D3 | 既有 `dsh.executablePath` 保持**最高优先级**，语义扩展为「既接受 bin.js 也接受 `.cmd`/包装脚本」，不弃用 |
| PR 整合 | `merge PR #35 → feat/v0.4.3`（保留原作者身份） |
| PR 隐患 | 本版一并修（握手时序、卸载钩子符号链接） |
| 平台 | 桌面端来源仅 Windows 有定义；POSIX 恒不可用，保持现状（`spawn('dsh')` 或显式路径） |

## 4. 架构与模块

### 4.1 新增 `src/service/launcher.ts`：执行入口的单一裁决

纯函数 `resolveLaunch(input)`，输入全部依赖注入（platform / env / exists / 可选 readFile），输出裁决结果：

```ts
export interface LaunchResolution {
  source: 'explicit' | 'npm' | 'desktop';
  mode: 'node' | 'cmd';        // node = node 直跑 js；cmd = cmd.exe /c 执行脚本
  executablePath: string;      // mode=node 时为 bin.js/入口 js
  argsPrefix: string[];        // mode=node: [jsPath]；mode=cmd: ['/d','/s','/c', cmdPath]
  fellBack: boolean;           // true = 用了非首选来源（用于日志与提示）
  reason: string;              // 人类可读的裁决理由（英文短句，进日志）
  candidateLog: string[];      // 依次尝试过的候选及失败原因（进日志，便于远程排查）
}
```

裁决优先级（固定顺序）：

1. **显式路径**（`dsh.executablePath`）：文件存在即可用。以 `.js` 结尾 → `mode='node'`；否则 → `mode='cmd'`（**不推导、不报端口占用**，这是 #30 的直接修法）。
2. **首选来源**（`dsh.launchPreference`，`auto` 视为先 npm）：
   - npm：`findInPath('dsh.cmd')` → `binJsFromShim()` → **该 bin.js 必须真实存在**才算可用；
   - desktop：命令路径 = `dsh.desktopCommandPath`（存在才算）→ 否则 Windows 默认目录 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`（存在才算）。
3. **回退**：另一种来源可用则用之，`fellBack=true`、`reason` 记明「首选 X 未找到，回退 Y」。
4. **都没有**：返回不可用结果 → 上层抛 `err.dshNotFound`，文案给出两条出路（装 npm 版 / Desktop 里点「安装 Desktop 命令」）。

安全约束：路径全部要求绝对路径；`mode='cmd'` 一律 `cmd.exe /d /s /c "<abs path>"`，不接受相对路径与未校验的拼接。

### 4.2 改动点

| 文件 | 改动 |
|---|---|
| `src/service/process.ts` | Windows 分支改为消费 `resolveLaunch()` 的结果；删除「一律推导 bin.js」的旧路径；`lastStart` 记录实际命令与来源；非 Windows 分支保持现状 |
| `src/config.ts` | 新增 `launchPreference`、`desktopCommandPath` 两个字段与规范化/校验 |
| `src/extension.ts` | 环境信息头记录「实际使用来源 + 路径 + 候选尝试记录」；不可用时的弹窗文案；**握手时序修复** |
| `src/service/manager.ts` | 透传新配置；`err.dshNotFound` 的错误分支文案按来源区分 |
| `src/panel/provider.ts` | #33：`showTextDocument` → `commands.executeCommand('vscode.open', uri, { preview: false })`，保留 catch 与既有告警 |
| `bridge-client/lib/client.js` | #32：在能拿到会话 ctx 的位置取当前会话 cwd，随 `buildOpenFileMessage(path, cwd)` 发送；取不到时不阻塞点击、退回工作区根并写日志 |
| `src/uninstall.ts` | 遍历 profile 前加三道校验：`lstat` 非符号链接、名字符合 profile 名正则、`realpath` 落在 `$DSH_HOME/profiles` 内 |
| `package.json` / `package.nls*.json` | 两个新设置项 + 中英文案（`package.nls.json`、`package.nls.zh-cn.json`、`package.nls.zh-hans.json`） |
| `README.md` / `README.zh.md` / `CHANGELOG.md` | 设置表、Desktop 说明、问题报告致谢表、版本号与测试数字守卫同步 |

## 5. 详细行为

### 5.1 配置项

```jsonc
"dsh.launchPreference": { "type": "string", "enum": ["auto", "npm", "desktop"], "default": "auto" },
"dsh.desktopCommandPath": { "type": "string", "default": "" }
```

- 非法枚举值 → 记错误并回退 `auto`；
- `desktopCommandPath` 非绝对路径 → 记错误并视为空（退回自动探测）；
- `dsh.executablePath` 仍为最高优先级，且当它指向 `.cmd`/包装脚本时走 `mode='cmd'`。

### 5.2 日志与提示

- 启动日志新增一行：`[process] 启动来源: npm（PATH 命中 C:\…\dsh.cmd）` / `desktop（Desktop 默认目录）` / `explicit（用户配置）`，回退时附 `（首选 npm 未找到，已回退）`；
- 候选尝试记录进 `candidateLog`，仅在启动失败或降级时输出，避免刷屏；
- 环境信息头（`DSH: 复制日志` 的头部）新增：`dsh 启动来源`、`dsh 实际入口`、`dsh.launchPreference`、`dsh.desktopCommandPath`、`dsh.profile`（PR #35 引入的 profile 也一并记录）；
- 不可用时的弹窗文案区分「两种都没装」与「装了但入口不可用」，均指向两条出路。

### 5.3 #32 的会话 cwd

- 优先取 DSH 页面当前会话的 cwd（与 DSH 自身解析文件地址同源）；
- 取不到（无 ctx、会话未就绪、UI 结构变化）→ **不丢弃点击**，仍以 `path` 发送，宿主回退工作区根，并写一行日志说明；
- 宿主 `resolveBridgePath(raw, sessionCwd, workspaceRoot)` 已实现 cwd 优先，本次不改其语义。

### 5.4 PR #35 两个隐患的修法

1. **握手时序**（`src/extension.ts` 的 `onDidChangeConfiguration` 内）：清空握手的条件由「非（就绪且非自启）」扩展为「**host / port / profile 任一变化** 且 非（就绪且非自启）」；避免端口+profile 同改时保留旧 `handshakeOk=true`，使 `startHandshakeTimeout()` 因早退而永不武装、桥接永久误报健康。
2. **卸载钩子符号链接**（`src/uninstall.ts`）：见 4.2 表。根因是遍历 `profiles/` 时把任意目录项当 profile，且 `existsSync` 跟随符号链接，可写到 `$DSH_HOME` 之外。

## 6. 测试与验收

### 6.1 自动化

- `launcher` 单测：npm 命中 / desktop 命中（设置路径与默认目录两路）/ 自动回退（双向）/ 两者皆无 / 显式路径 `.js` 与 `.cmd` 两种 / bin.js 不存在时必须判定 npm 不可用；
- `process.test.ts`：Windows 下 `mode='cmd'` 的参数形态（`cmd.exe /d /s /c`）、`mode='node'` 与 v0.4.2 参数一致（含 `--profile`）、POSIX 分支不变；
- `extension.test.ts`：端口+profile 同改时的握手清空用例；环境信息头包含来源字段；
- `installer`/`uninstall`：符号链接 profile 不被改写、名字非法 profile 被跳过、正常 profile 仍被清理；
- 文档守卫：README 与 CHANGELOG 的测试数字同步为新值（守卫会彼此校验，必须一致）；
- 门禁：`npm run typecheck`、`npm test`、`npm run compile` 三者全绿，真实输出留痕。

### 6.2 用户真机验收（Windows）

1. #33：点图片 / PDF / 未知二进制交付物；
2. #32：会话 cwd ≠ 工作区根时点相对路径文件；
3. npm 装法启动行为与 v0.4.2 一致（无回归）；
4. Desktop 装法：`auto` 与 `desktop` 首选各一次；
5. `dsh.executablePath` 指向 Desktop 的 `dsh.cmd` 再试一次；
6. 切 profile / 端口后，面板握手状态正常（不出现误报健康）。

## 7. 发布流程

1. `merge PR #35` → `feat/v0.4.3`；
2. 在其上叠加本次修复（独立 commit）；
3. `package.json` 与桥接 `BRIDGE_VERSION` 同步置 `0.4.3-test1`；
4. `npm run package` 产出 vsix → 用户真机验收；
5. 有反馈 → 修复 → `0.4.3-test2`，依次类推；
6. 用户明确同意 → 合并 `main` → 置 `0.4.3` → 打 tag / 发布（发布动作需用户再次确认）。

## 8. 风险与未验证项

- **Windows 真机行为只能由用户验证**：本机为 WSL，无法执行 `dsh.cmd`；`cmd.exe /c` 形态、Desktop 默认目录、PATH 命中与否均属真机结论。
- **桥接取会话 cwd 依赖 DSH 页面内部结构**：DSH 升级可能改变取法；设计已要求「取不到不阻塞点击」，退化行为可接受。
- **合并 PR #35 后行号会变化**：实现前以合并后的实际代码为准复核每个改动点。
- 沙箱限制：本机无法真实启动 `dsh`（写 `~/.dsh` 被拒 EACCES），端到端启动只能由用户侧验证。
