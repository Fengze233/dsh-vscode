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
