# v0.2.1 技术债清理与开源工程化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理开发期遗留的技术债（构建卫生、安全加固、错误兜底、测试补强），并为开源仓库补齐工程化设施（按需激活、CI、Issue/PR 模板与贡献指南），随后发布 v0.2.1。

**Architecture:** 全部为小范围改动：构建脚本加清理步骤、provider/extension 局部加固、测试断言补强、package.json 激活策略调整、新增 .github 工作流与模板文件。无新增模块、无架构变化。

**Tech Stack:** Node.js + TypeScript；构建 esbuild（scripts/build.mjs）；测试 node:test；CI GitHub Actions；打包 vsce。

## Global Constraints

- 代码注释必须为完整中文；git 提交信息为中文；提交身份 `Fengze233` / `your-email@example.com`。
- i18n 规则：VS Code 语言以 `zh-` 开头 → 简体中文，其余一律英文（README 英文主版 + README.zh.md 中文版已确立）。
- 仓库根目录 `dsh-vscode`；开发在隔离 worktree（`.worktrees/polish`，分支 `feature/polish-and-engineering`）进行，完成后合并回 main（沿用上轮 worktree 流程）。
- 测试运行方式：`npm test`（真实测试数 75；构建脚本清理后测试数应保持 75 不变）；`npm run typecheck` 通过。
- 不新增 npm 依赖（CI 用 actions 生态，无需依赖）。
- 发布动作（商店重传、GitHub Release）由控制器与用户协同，任务只准备产物与文档。

---

### Task 1: 构建卫生——构建前清空 out/ 目录

**Files:**
- Modify: `scripts/build.mjs`（build 执行段之前加清理）

**Interfaces:**
- Consumes: 无（独立改动）
- Produces: 无新导出；行为变化：每次 `node scripts/build.mjs`（含 --test / --watch 首次）构建前清空 `out/`，删除的测试文件不再以旧产物形式残留运行。

- [ ] **Step 1: 实现清理逻辑**

在 `scripts/build.mjs` 顶部 import 区增加 `rmSync`（现有已 import `readdirSync`、`join`）：

```js
import { readdirSync, rmSync } from 'node:fs';
```

在 `const configs = testOnly ? [tests] : [ext, tests];` 之前插入：

```js
// 构建前清空 out/：删除的源文件（如已移除的测试）不会以旧产物残留，
// 避免 node --test 收集到失效产物导致测试数虚高（历史教训：88 vs 75）。
rmSync(join(process.cwd(), 'out'), { recursive: true, force: true });
```

- [ ] **Step 2: 验证**

```bash
cd /home/fengze233/dsh_vs && rm -rf out && npm test 2>&1 | grep -E '^# (tests|pass|fail)'
```

Expected: `# tests 75 / # pass 75 / # fail 0`（与清理前一致，证明清空逻辑不破坏构建）。再跑一次 `npm test` 确认幂等（仍 75）。

- [ ] **Step 3: 提交**

```bash
git add scripts/build.mjs
git commit -m "fix: 构建前清空 out 目录，消除删除文件后的产物残留"
```

---

### Task 2: 安全与健壮性加固（token 用 crypto + retryBridge 兜底）

**Files:**
- Modify: `src/panel/provider.ts:23`（bridgeToken 生成）、`src/extension.ts:165-180`（retryBridge）

**Interfaces:**
- Consumes: 无
- Produces: 无接口变化；行为变化：握手 token 不可预测；retryBridge 内部异常不再成为未处理拒绝。

- [ ] **Step 1: token 改用 crypto**

`src/panel/provider.ts` 顶部 import 增加：

```ts
import { randomUUID } from 'node:crypto';
```

第 23 行改为：

```ts
/** 桥接握手 token：一次性防伪凭据，用密码学随机数（不可预测） */
private readonly bridgeToken = randomUUID();
```

（`html.ts` 占位页 nonce 的 `Math.random` 是 CSP nonce、非安全边界，保持不动。）

- [ ] **Step 2: retryBridge 异常兜底**

`src/extension.ts` 的 `retryBridge` 函数体（约 165-180 行）整体包 try/catch，失败只记日志不抛出：

```ts
async function retryBridge(): Promise<void> {
  try {
    // …原有逻辑保持不变（installBridge → globalState.update → manager?.restart()）…
  } catch (err) {
    // 重试失败只记日志：命令入口是 void 调用，异常不能成为未处理拒绝
    output?.appendLine(`[bridge] retry failed: ${String(err)}`);
  }
}
```

（只加包裹与 catch，函数内部语句原样保留、缩进调整。）

- [ ] **Step 3: 验证与提交**

```bash
cd /home/fengze233/dsh_vs && npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'
```

Expected: typecheck 0 error；75 测试全过（无行为级单测：token 为随机值、retryBridge 依赖 vscode 宿主，靠类型与审查保障）。

```bash
git add src/panel/provider.ts src/extension.ts
git commit -m "fix: 握手 token 改用 crypto 随机数；retryBridge 异常兜底"
```

---

### Task 3: 测试补强（workspaceRootIndex 分支与 cwd 缺失语义）

**Files:**
- Modify: `test/config.test.ts`（normalizeConfig 用例后追加）、`test/process.test.ts`（cwd 透传用例后追加）

**Interfaces:**
- Consumes: `normalizeConfig`（src/config.ts）、`createProcessRunner`（src/service/process.ts），均为既有导出。
- Produces: 无。

- [ ] **Step 1: 追加 config 校验分支断言**

`test/config.test.ts` 追加：

```ts
test('workspaceRootIndex 非法分支逐类回退并记录错误', () => {
  // 非整数（1.5 / NaN）与类型错误（字符串）都必须回退 0 并记录 error
  const r1 = normalizeConfig({ workspaceRootIndex: 1.5 });
  assert.equal(r1.config.workspaceRootIndex, 0);
  assert.equal(r1.errors.length, 1);
  const r2 = normalizeConfig({ workspaceRootIndex: Number.NaN });
  assert.equal(r2.config.workspaceRootIndex, 0);
  assert.equal(r2.errors.length, 1);
  const r3 = normalizeConfig({ workspaceRootIndex: '2' as unknown as number });
  assert.equal(r3.config.workspaceRootIndex, 0);
  assert.equal(r3.errors.length, 1);
});
```

- [ ] **Step 2: 追加 process cwd 缺失语义断言**

`test/process.test.ts` 追加（沿用该文件既有 fakeChild/calls 捕获模式）：

```ts
test('startDsh 未传 cwd 时 spawn 选项不含 cwd 键', () => {
  const calls: unknown[] = [];
  const runner = createProcessRunner(((cmd, args, opts) => { calls.push(opts); return fakeChild(); }) as SpawnFn, 'linux');
  runner.startDsh({ host: '127.0.0.1', port: 3080, extraArgs: [] });
  const opts = calls[0] as Record<string, unknown>;
  assert.equal('cwd' in opts, false);
});
```

（`fakeChild` / `SpawnFn` 导入沿用该文件既有写法；若 fakeChild 命名不同，按文件内现有帮助函数名使用。）

- [ ] **Step 3: 验证与提交**

```bash
cd /home/fengze233/dsh_vs && npm test 2>&1 | grep -E '^# (tests|pass|fail)'
```

Expected: `# tests 77 / # pass 77 / # fail 0`（75 + 2 新增）。

```bash
git add test/config.test.ts test/process.test.ts
git commit -m "test: 补 workspaceRootIndex 非法分支与 cwd 缺失语义断言"
```

---

### Task 4: 按需激活（activationEvents 优化）

**Files:**
- Modify: `package.json:16-18`（activationEvents）

**Interfaces:**
- Consumes: 命令 ID 与视图 ID 清单（package.json contributes 既有：视图 `dsh.panel`、`dsh.panel.secondary`；命令 `dsh.openPanel`、`dsh.openSecondary`、`dsh.openExternal`、`dsh.restart`、`dsh.stop`、`dsh.copyUrl`、`dsh.showLogs`、`dsh.bridge.retry`、`dsh.bridge.uninstall`）。
- Produces: 行为变化：扩展不再随 VS Code 启动即激活，而是在首次打开 DSH 面板/执行任一 DSH 命令/触发欢迎页命令时激活；状态栏指示随激活出现。服务启动语义不变（`autoStart` 本来就是面板打开时触发）。

- [ ] **Step 1: 替换 activationEvents**

`package.json` 第 16-18 行改为：

```json
  "activationEvents": [
    "onView:dsh.panel",
    "onView:dsh.panel.secondary",
    "onCommand:dsh.openPanel",
    "onCommand:dsh.openSecondary",
    "onCommand:dsh.openExternal",
    "onCommand:dsh.restart",
    "onCommand:dsh.stop",
    "onCommand:dsh.copyUrl",
    "onCommand:dsh.showLogs",
    "onCommand:dsh.bridge.retry",
    "onCommand:dsh.bridge.uninstall"
  ],
```

- [ ] **Step 2: 验证**

```bash
cd /home/fengze233/dsh_vs && npm run typecheck && npx vsce package -o /tmp/dsh-activation-check.vsix 2>&1 | tail -1
```

Expected: 打包成功且无 activationEvents 相关告警；`rm /tmp/dsh-activation-check.vsix`。行为回归由 Task 7 的用户验证覆盖（重装后点图标开面板、命令面板命令均可用）。

- [ ] **Step 3: 提交**

```bash
git add package.json
git commit -m "perf: 扩展改为按需激活（首次打开面板或执行命令时）"
```

---

### Task 5: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: 无
- Produces: 推送/PR 时自动运行 typecheck + 75 条测试 + 打包 vsix 并上传 artifact。集成测试在无 `dsh` 的 runner 上自动跳过（test/integration/dsh.test.ts 已有 skip 逻辑）。

- [ ] **Step 1: 创建工作流**

`.github/workflows/ci.yml`：

```yaml
# CI：类型检查 + 单元/集成测试 + 打包 vsix
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npx vsce package -o dsh-vscode.vsix
      - uses: actions/upload-artifact@v4
        with:
          name: dsh-vscode-vsix
          path: '*.vsix'
```

- [ ] **Step 2: 提交并验证**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: 新增 GitHub Actions（typecheck + 测试 + 打包 vsix）"
```

Expected: 推送后 GitHub Actions 页面出现 CI 运行并变绿（控制器在推送后检查 Actions 状态；若 npm ci 因 lock 与 package.json 版本漂移失败，回修 lock 文件）。

---

### Task 6: Issue/PR 模板与贡献指南

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`、`.github/ISSUE_TEMPLATE/feature_request.yml`、`.github/pull_request_template.md`、`CONTRIBUTING.md`

**Interfaces:**
- Consumes: 无
- Produces: GitHub 新建 Issue/PR 时的表单与默认描述；CONTRIBUTING.md 供贡献者阅读（英文，与 README.md 主语言一致）。

- [ ] **Step 1: 创建 bug 模板**

`.github/ISSUE_TEMPLATE/bug_report.yml`：

```yaml
name: Bug 报告
description: 反馈插件缺陷
labels: [bug]
body:
  - type: input
    id: version
    attributes:
      label: 插件版本
      placeholder: 例如 0.2.1（VS Code 扩展面板中查看）
    validations:
      required: true
  - type: input
    id: environment
    attributes:
      label: 环境
      placeholder: 例如 Windows 11 + WSL Ubuntu；VS Code 1.96；DSH 0.1.0-rc.6
    validations:
      required: true
  - type: textarea
    id: description
    attributes:
      label: 问题描述
      description: 发生了什么？期望是什么？
    validations:
      required: true
  - type: textarea
    id: reproduce
    attributes:
      label: 复现步骤
      placeholder: 1. 打开面板 2. …
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: 日志
      description: 命令面板执行 `DSH: 查看日志` 后复制相关输出
```

- [ ] **Step 2: 创建功能请求模板**

`.github/ISSUE_TEMPLATE/feature_request.yml`：

```yaml
name: 功能请求
description: 提议新功能或改进
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: 想解决的问题
      description: 目前的使用痛点是什么？
    validations:
      required: true
  - type: textarea
    id: proposal
    attributes:
      label: 期望的方案
      description: 希望插件如何工作？
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: 考虑过的替代方案
```

- [ ] **Step 3: 创建 PR 模板与贡献指南**

`.github/pull_request_template.md`：

```markdown
## 变更说明

<!-- 这个 PR 做了什么、为什么 -->

## 验证

- [ ] `npm test` 通过
- [ ] `npm run typecheck` 通过
- [ ] 手动验证说明：
```

`CONTRIBUTING.md`（英文，与 README.md 主语言一致）：

```markdown
# Contributing

Thanks for your interest in contributing!

## Development

Requirements: Node.js ≥ 22, VS Code ≥ 1.91, and the `dsh` CLI from
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) on PATH.

```bash
npm install
npm run test          # unit/integration tests
npm run typecheck
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host.

## Conventions

- Commit messages and code comments are written in Chinese.
- README.md is the English primary version; README.zh.md is the Chinese
  mirror — update both when changing user-facing docs.
- Keep runtime i18n keys in sync between `src/i18n.ts` (en/zh) and the
  static `package.nls*.json` files.

## Submitting changes

Open a pull request; CI runs typecheck, tests, and packages a vsix. Bug
reports and feature requests go through the issue templates.
```

- [ ] **Step 4: 提交**

```bash
git add .github/ISSUE_TEMPLATE/ .github/pull_request_template.md CONTRIBUTING.md
git commit -m "docs: 新增 Issue/PR 模板与贡献指南"
```

---

### Task 7: 版本 v0.2.1 与发布（控制器协同用户）

**Files:**
- Modify: `package.json`（version 0.2.1）、`package-lock.json`（同步）、`CHANGELOG.md`（0.2.1 条目）

- [ ] **Step 1: 版本与变更日志**

`package.json` version 改 `0.2.1`；`package-lock.json` 两处 version 同步；CHANGELOG.md 顶部新增：

```markdown
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
```

- [ ] **Step 2: 验证与提交**

```bash
cd /home/fengze233/dsh_vs && npm test 2>&1 | grep -E '^# (tests|pass|fail)' && npm run typecheck
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: v0.2.1 技术债清理与工程化"
git tag v0.2.1
```

- [ ] **Step 3: 推送与发布（控制器）**：push main + tag（直连/代理按当时网络）；CI 跑绿后创建 GitHub Release v0.2.1（上传 vsix）；打包 vsix 复制到用户 Windows 桌面，用户网页重传商店（README 英文版随之生效）；商店 API 验证；讨论帖跟进。

---

## 自审记录

- **清单覆盖**：第一档 5 项 → Task 1/2/3（商店 README 重传归 Task 7 Step 3）；第三档 3 项 → Task 4/5/6；发布 → Task 7。第二档明确不做（用户已排除）。
- **类型一致性**：Task 3 引用的 `normalizeConfig`/`createProcessRunner`/`SpawnFn` 均为既有导出；无跨任务新接口。
- **占位符扫描**：无 TBD/TODO；Task 5 CI 的 npm ci 风险已写明回修路径；Task 2 无行为级单测的原因已说明（vscode 宿主/随机值）。
