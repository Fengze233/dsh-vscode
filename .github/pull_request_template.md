## 变更说明

<!-- 这个 PR 做了什么、为什么；关联的 issue 用 Closes #N 标注 -->

Closes #

## 类型

- [ ] Bug fix
- [ ] Feature
- [ ] Docs / CI
- [ ] Refactor（请先说明为什么不能单独开 PR）

## 影响范围

- [ ] 启动 / 服务管理
- [ ] 鉴权 / 本地代理
- [ ] 面板 / UI
- [ ] 桥接 / 安装卸载
- [ ] 文档 / 构建
- [ ] Windows
- [ ] 远程（SSH / WSL / Dev Containers）

## 验证

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过（实际测试数：______）
- [ ] `npm run compile` 通过
- [ ] `npx vsce package --no-dependencies` 通过
- [ ] CI 通过（fork PR 若未触发 CI，请贴出本地输出）
- [ ] 手动验证说明：
- [ ] UI 改动已附截图或录屏
- [ ] Windows 相关改动注明了 Windows / VS Code / DSH 版本
- [ ] 行为变更已补测试

## 发布约定（请逐项确认）

- [ ] 未修改 `package.json` / `package-lock.json` / `bridge-client/package.json` 的 `version`
- [ ] 未修改 `BRIDGE_VERSION`
- [ ] 未添加 CHANGELOG 版本标题或发布日期（功能条目只写在 `[Unreleased]`）
- [ ] `README.md` 与 `README.zh.md` 已同步；测试数与 `npm test` 实际一致
- [ ] 新增设置已同步 `package.nls.json` / `package.nls.zh-cn.json` / `package.nls.zh-hans.json` 和两份 README
- [ ] 未提交 `out/`、`*.vsix`、日志或本地缓存
- [ ] 没有加入新的运行时依赖（如有，请先说明原因）
