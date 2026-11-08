# Contributing

Thanks for your interest in improving DSH for VS Code!

## Before you start

- **One PR, one thing.** Keep each pull request focused on a single fix or feature. Unrelated refactors, formatting changes and drive-by fixes make review harder and delay merging.
- **Discuss large changes first.** Open an issue before a new subsystem, a behavior change with multiple valid designs, or a change that touches startup, authentication, the bridge installer or the uninstall hook.
- **Bug reports and feature requests** go through the issue templates.

## Development

Requirements: Node.js ≥ 22, VS Code ≥ 1.91, and the `dsh` CLI from
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) on PATH
(the real-DSH integration tests are skipped when it is unavailable).

```bash
npm install
npm run typecheck
npm test
npm run compile
npx vsce package --no-dependencies
```

Press `F5` in VS Code to launch the Extension Development Host.

## PR requirements

To keep PRs mergeable without back-and-forth:

- **Branch from the latest `main`** and rebase if `main` moved. Keep the diff minimal.
- **Do not bump versions.** Do not change `package.json`, `package-lock.json` or
  `bridge-client/package.json` `version`, and do not change `BRIDGE_VERSION`.
  Releases, tags and version bumps are handled by the maintainer.
- **Do not add CHANGELOG version headings or release dates.** Put functional notes
  under `## [Unreleased]`; the maintainer turns them into a release section.
- **Add tests for behavior changes.** Run `npm test` and make sure the test count
  in `README.md`, `README.zh.md` and the CHANGELOG `[Unreleased]` section matches the
  actual count (the package test enforces this).
- **Keep docs in sync.** `README.md` is the English primary; `README.zh.md` is the
  Chinese mirror. For new settings, update `package.nls.json`, both Chinese NLS
  files, and both READMEs.
- **Do not commit build artifacts or local state**: `out/`, `*.vsix`, logs,
  `.dsh-*` mock directories, coverage or editor caches.
- **Run the full gate locally**: `npm run typecheck`, `npm test`, `npm run compile`
  and `npx vsce package --no-dependencies`. CI must be green; if CI did not run on
  your fork PR, say so in the description and paste the local command results.
- **UI changes need evidence.** Attach a screenshot or a short recording, and list
  the VS Code version/OS used.
- **Windows-specific changes** must state the Windows version, VS Code version and
  DSH version used for manual verification. The CI runner is Linux; Windows behavior
  cannot be inferred from it.
- **No new runtime dependencies** without prior discussion. The extension currently
  has no production dependencies, and the uninstall hook must stay Node-built-in only.
- **Security-sensitive changes** (loopback whitelist, auth relay, bridge install or
  uninstall, `cordis.patch.yml` writes) need tests and an explicit note about the
  safety boundary in the PR description.
- **Commit messages and code comments are written in Chinese**, and comments explain
  *why*, not what the code literally does.

## Review and merge

- The maintainer may ask to split a PR or narrow its scope; please keep the branch
  up to date while it is under review.
- A PR is merged only when CI is green, the diff is focused, docs/tests are in sync,
  and no release bookkeeping (version, tag, release date) is included.
- For changes that need a Windows check, the maintainer may ship a `X.Y.Z-testN`
  build for manual verification before the final release.

## Conventions

- Commit messages and code comments are written in Chinese.
- README.md is the English primary version; README.zh.md is the Chinese mirror —
  update both when changing user-facing docs.
- Keep runtime i18n keys in sync between `src/i18n.ts` (en/zh) and the static
  `package.nls*.json` files.
