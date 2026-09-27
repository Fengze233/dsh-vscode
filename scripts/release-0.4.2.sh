#!/usr/bin/env bash
# 发布 v0.4.2 正式版：升版本号 → 构建 → 推送 → 合并 PR → 打 tag → 打 vsix → 放到 Windows 桌面
#
# 使用前提（缺一不可）：
#   1. 已在 feat/v0.4.2-revert-pr11 分支的 worktree 目录下执行；
#   2. 该分支已推送且 PR CI（build）为 pass；
#   3. 用户已实测 0.4.2-test1 通过（#27 不再复现）。
#
# 失败即退出（set -e），任一步失败都不会继续往下走。
set -euo pipefail

BRANCH="feat/v0.4.2-revert-pr11"
RELEASE_VERSION="0.4.2"
WIN_DESKTOP="/mnt/c/Users/ni125/Desktop"
GIT_ID=(-c user.name=Fengze233 -c user.email=ni125803@163.com)

# 进入脚本所在仓库（worktree）根目录
cd "$(git rev-parse --show-toplevel)"

current_branch="$(git branch --show-current)"
if [ "$current_branch" != "$BRANCH" ]; then
  echo "✗ 当前分支为 $current_branch，期望 $BRANCH" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区不干净，先提交或清理" >&2
  exit 1
fi

echo "=== 1/7 升版本号：插件 + package-lock + 桥接包 + BRIDGE_VERSION → $RELEASE_VERSION ==="
npm version "$RELEASE_VERSION" --no-git-tag-version >/dev/null
node -e '
const fs = require("fs");
const v = process.argv[1];
const bp = "bridge-client/package.json";
const b = JSON.parse(fs.readFileSync(bp, "utf8"));
b.version = v;
fs.writeFileSync(bp, JSON.stringify(b, null, 2) + "\n");
const cp = "bridge-client/lib/client.js";
let c = fs.readFileSync(cp, "utf8");
c = c.replace(/const BRIDGE_VERSION = "[^"]+";/, `const BRIDGE_VERSION = "${v}";`);
fs.writeFileSync(cp, c);
' "$RELEASE_VERSION"
node -e '
const p = require("./package.json"), b = require("./bridge-client/package.json");
const l = require("./package-lock.json");
const c = require("fs").readFileSync("bridge-client/lib/client.js", "utf8");
const ok = p.version === b.version && l.version === p.version && l.packages[""].version === p.version
  && c.includes(`BRIDGE_VERSION = "${p.version}"`);
console.log("版本一致性:", ok ? "OK" : "FAIL", p.version);
if (!ok) process.exit(1);
'

echo "=== 2/7 提交并推送 ==="
git add -A
git "${GIT_ID[@]}" commit -q -m "chore(release): v$RELEASE_VERSION 正式版——撤回 PR #11 后的定版"
git push -q origin "$BRANCH"

echo "=== 3/7 本地验收（typecheck + 全量测试） ==="
npm run typecheck
npm test 2>&1 | tail -8

echo "=== 4/7 等待 PR CI 通过 ==="
gh pr checks --watch --interval 15 || true
gh pr checks | grep -q "pass" || { echo "✗ CI 未通过" >&2; exit 1; }

echo "=== 5/7 合并 PR 到 main（merge commit，保留撤回历史） ==="
gh pr ready
gh pr merge --merge --delete-branch=false
git fetch -q origin main
git log --oneline -1 origin/main

echo "=== 6/7 打 tag 并推送 ==="
TAG="v$RELEASE_VERSION"
git tag -a "$TAG" -m "v$RELEASE_VERSION"
git push -q origin "$TAG"

echo "=== 7/7 构建 vsix 并放到 Windows 桌面 ==="
npm run package -- --out "dsh-vscode-$RELEASE_VERSION.vsix"
cp "dsh-vscode-$RELEASE_VERSION.vsix" "$WIN_DESKTOP/"
sha256sum "dsh-vscode-$RELEASE_VERSION.vsix" "$WIN_DESKTOP/dsh-vscode-$RELEASE_VERSION.vsix"
ls -la "$WIN_DESKTOP/dsh-vscode-$RELEASE_VERSION.vsix"

echo "✓ 发布完成：$TAG（vsix 已在 Windows 桌面）"
