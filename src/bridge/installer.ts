// src/bridge/installer.ts — DSH 桥接包的探测与幂等安装/卸载
// 职责：把 bridge-client 包安装进用户 profile 目录（$DSH_HOME/profiles/web），
// 并通过 cordis.patch.yml 的 insert: 条目把它注册为 DSH 的官方 client 插件。
// 安全边界：只写用户目录（$DSH_HOME/profiles/web），绝不触碰 DSH 安装目录。
//
// 关键约束（来自 Task 0 spike 实测，见 task-0-report.md）：
// 1. cordis.patch.yml 顶层是流式空数组 `[]` 时，不能在其后直接追加块序列条目，
//    否则整个文件 YAML 解析失败（fail-loud）。必须把顶层改写为块序列形式。
// 2. 新增条目必须用 `insert:` 包裹；裸 `- id:` 条目是「按 id 覆盖既有行」的 patch，
//    目标行不存在时只会告警并跳过，不会真正新增条目。
// 3. 卸载时按 begin/end 标记精确删除条目段；若删除后仅剩空白，还原为 `[]`。
import { join, dirname } from 'node:path';
import * as nodeFs from 'node:fs';

/** 桥接条目在 cordis.patch.yml 中的包裹标记（卸载时按标记精确删除） */
export const BRIDGE_BEGIN_MARK = '# dsh-vscode-bridge: begin';
export const BRIDGE_END_MARK = '# dsh-vscode-bridge: end';
/** 空数组改写分支的元数据标记：begin 标记行携带它，卸载时据此字节级还原「注释头 + []」 */
export const BRIDGE_WAS_EMPTY_ARRAY_FLAG = 'was-empty-array';
/** 空数组改写分支专用 begin 标记（= base begin 标记 + was-empty-array 元数据） */
export const BRIDGE_BEGIN_MARK_WAS_EMPTY = `${BRIDGE_BEGIN_MARK} ${BRIDGE_WAS_EMPTY_ARRAY_FLAG}`;

/** 桥接包在 profile node_modules 下的目录名（无 scope） */
export const BRIDGE_PACKAGE_NAME = 'dsh-vscode-bridge';

/** 注入的 fs 子集：生产用 Node fs 封装（createNodeFs），测试用内存实现 */
export interface InstallerFs {
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  mkdir(p: string): void;
  copyDir(src: string, dest: string): void;
  rmDir(p: string): void;
  readdir(p: string): string[];
}

/** 安装结果状态：ok 成功；pending-restart 预留（服务重启后生效）；degraded 降级 */
export type BridgeInstallStatus = 'ok' | 'pending-restart' | 'degraded';

/** 安装结果 */
export interface BridgeInstallResult {
  status: BridgeInstallStatus;
  reason?: string;   // degraded 时的原因（英文短句，日志用）
  profileDir?: string;
  bridgeDir?: string; // 安装目标目录（保持兼容：语义为 primary 路径 profiles/web/node_modules/dsh-vscode-bridge；secondary 见 bridgeTargetDirs）
}

/** 安装参数 */
export interface BridgeInstallOptions {
  dshHome: string;            // $DSH_HOME 或 ~/.dsh
  bridgeSourceDir: string;    // 插件随附 bridge-client 目录绝对路径
  fs: InstallerFs;            // 注入的 fs 子集
  /** npm 全局 node_modules 目录绝对路径（Windows 扩展宿主 ESM 解析可达位置，可选） */
  npmGlobalNodeModules?: string;
}

/**
 * 定位 web profile 目录：dshHome/profiles/web。
 * 不存在时返回 null（调用方据此判定为 degraded）。
 */
export function detectProfileDir(dshHome: string, fs: InstallerFs): string | null {
  const dir = join(dshHome, 'profiles', 'web');
  return fs.exists(dir) ? dir : null;
}

/**
 * 桥接包的全部安装目标目录。
 *
 * 背景（Windows 实测，见 bridge-locations-fix-report.md）：
 * - primary：profiles/web/node_modules/dsh-vscode-bridge（WSL 模块解析锚点）；
 * - secondary：profiles/node_modules/dsh-vscode-bridge（Windows profile 插件解析 fallback 真实目录）；
 * - npm 全局位置（可选）：Windows 下 VS Code 扩展宿主 spawn 的 dsh 进程对 profile 插件的 ESM
 *   解析与普通命令行进程不同，profiles 双位置仍可能解析不到桥接包；而 npm 全局 node_modules
 *   （AppData\Roaming\npm\node_modules）是确定可达的位置，因此额外安装到此处。
 * 两类平台各解析其可及位置，因此需同时安装到全部位置。
 *
 * 顺序固定：[primary, secondary, ...(npmGlobalNodeModules ? [join(npmGlobalNodeModules, NAME)] : [])]
 *
 * @param profileDir            web profile 目录绝对路径
 * @param npmGlobalNodeModules  npm 全局 node_modules 目录绝对路径（可选，缺省仅双位置）
 */
export function bridgeTargetDirs(profileDir: string, npmGlobalNodeModules?: string): string[] {
  const dirs = [
    join(profileDir, 'node_modules', BRIDGE_PACKAGE_NAME),
    join(profileDir, '..', 'node_modules', BRIDGE_PACKAGE_NAME),
  ];
  if (npmGlobalNodeModules) {
    dirs.push(join(npmGlobalNodeModules, BRIDGE_PACKAGE_NAME));
  }
  return dirs;
}

/**
 * 判定 cordis.patch.yml 的顶层是否为「流式空数组 []」。
 *
 * 规则：去掉注释行与空行后：
 * - 剩余有效行为空，且原文 trim 后为空 → 空文件，视为空数组；
 * - 剩余有效行只有一行且为 `[]` → 顶层空数组（含「注释 + []」的默认模板）；
 * - 其余（含只有注释、或已有块序列条目）→ 不是空数组。
 *
 * 注意「只有注释」必须走追加分支而非改写分支：注释可能是用户自己的内容
 * （见 uninstall 用例 `# 用户自己的内容`），改写会覆盖它。
 */
function isTopLevelEmptyArray(content: string): boolean {
  const meaningful = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  if (meaningful.length === 0) {
    // 无任何有效行：只有「真正空文件」才视为空数组；只有注释视为用户内容
    return content.trim() === '';
  }
  return meaningful.length === 1 && meaningful[0] === '[]';
}

/**
 * 提取「顶层空数组」文件中 `[]` 这一行之前的注释头（含全部注释行与空行），原样保留。
 * 仅在 isTopLevelEmptyArray 判定为真时调用；逐行定位顶层 `[]` 所在行，
 * 返回其之前的原始子串（不 trim、不改写），供卸载时字节级还原。
 */
function findEmptyArrayHead(content: string): string {
  let pos = 0;
  for (const line of content.split('\n')) {
    if (line.trim() === '[]') {
      // 找到顶层 [] 行：其之前的内容（注释头 + 空行）即 head
      return content.slice(0, pos);
    }
    pos += line.length + 1; // +1 为换行符
  }
  return ''; // 防御分支：调用前已用 isTopLevelEmptyArray 判定，不会走到这里
}

/**
 * 幂等安装桥接包（全部目标目录：primary + secondary + 可选 npm 全局位置）：
 * - profile 缺失 → degraded；
 * - 条目已存在 → 可用性验证（每处均可读 package.json），全部完好则 ok，
 *   任一处坏包（权限/损坏/缺失）则强制重装该处，重装失败则回滚条目为 degraded；
 * - 首次安装 → 写条目 + 复制目录到全部目标位置，
 *   任一处 copyDir 失败则清理已复制的 → 还原 patch → degraded；
 * - 顶层空数组 → 整文件改写为块序列（含 insert: 条目）；
 * - 已有用户内容 → 去尾随空白后追加 insert: 条目。
 */
export function installBridge(opts: BridgeInstallOptions): BridgeInstallResult {
  const profileDir = detectProfileDir(opts.dshHome, opts.fs);
  if (profileDir === null) {
    return { status: 'degraded', reason: 'web profile not found' };
  }
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const targets = bridgeTargetDirs(profileDir, opts.npmGlobalNodeModules);
  // primary 路径保持兼容语义（BridgeInstallResult.bridgeDir）
  const bridgeDir = targets[0];

  // 读取现有 patch（不存在视为空，避免真实环境首次运行时 readFile 抛错）
  const existing = opts.fs.exists(patchPath) ? opts.fs.readFile(patchPath) : '';

  if (existing.includes(BRIDGE_BEGIN_MARK)) {
    // 已存在条目：全部目标目录都必须可用（能读到含 `"name"` 的 package.json）。
    // 仅 exists 会漏掉「目录在但 package.json 不可读」的坏包（chmod 000 事故），
    // 且 Windows 场景某目标缺失但其余完好时也需自愈补回。
    const unusable = targets.filter((t) => !isBridgeUsable(t, opts.fs));
    if (unusable.length === 0) {
      return { status: 'ok', profileDir, bridgeDir };
    }
    // 有目标不可用：逐一强制重装（删掉坏目录后重新复制）。
    try {
      for (const t of unusable) {
        opts.fs.rmDir(t);
        copyBridgeDir(opts, t);
      }
      return { status: 'ok', profileDir, bridgeDir };
    } catch (e) {
      // 删除或复制失败（权限锁死等）：回滚 patch 条目，避免「有条目但包不可用」导致 DSH 启动失败。
      // 回滚后 DSH 至少能干净启动，用户可手工修权限后再重试安装。
      uninstallBridge(opts);
      return { status: 'degraded', reason: `reinstall failed: ${errMsg(e)}`, profileDir, bridgeDir };
    }
  }

  // 首次安装：写条目前保存原文，供 copyDir 失败时回滚，绝不残留「有条目但包不可用」。
  const originalPatch = existing;
  writePatchEntry(opts.fs, patchPath, existing);
  let failedTarget = '';
  try {
    // 全部目标位置复制：每处都成功才算安装成功。
    for (const t of targets) {
      failedTarget = t;
      copyBridgeDir(opts, t);
    }
  } catch (e) {
    // 任一处复制失败：尽力清理已复制的目录 + 还原 patch 原文，返回 degraded。
    // 清理为尽力而为（rmDir 可能同样抛错），核心是还原 patch 绝不残留「有条目但包不可用」。
    for (const t of targets) {
      try { opts.fs.rmDir(t); } catch { /* 忽略清理失败 */ }
    }
    opts.fs.writeFile(patchPath, originalPatch);
    // failedTarget 即失败时正在复制的目标路径，写入 reason 便于日志定位。
    return { status: 'degraded', reason: `copy failed at ${failedTarget}: ${errMsg(e)}`, profileDir, bridgeDir };
  }
  return { status: 'ok', profileDir, bridgeDir };
}

/** 提取 Error 的 message（未知抛出物兜底为字符串化） */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 卸载：删除带标记的 insert: 条目段（其余内容原样保留）+ 删除桥接目录 */
export function uninstallBridge(opts: BridgeInstallOptions): void {
  const profileDir = detectProfileDir(opts.dshHome, opts.fs);
  if (profileDir === null) return;
  const patchPath = join(profileDir, 'cordis.patch.yml');
  if (!opts.fs.exists(patchPath)) return;
  const patch = opts.fs.readFile(patchPath);
  const begin = patch.indexOf(BRIDGE_BEGIN_MARK);
  const end = patch.indexOf(BRIDGE_END_MARK);
  if (begin === -1 || end === -1) return;
  // 判断是否为空数组改写分支：begin 标记行携带 was-empty-array 元数据。
  // 只扫描 begin~end 之间的条目段，避免误判用户自身内容里的同名文本。
  const wasEmptyArray = patch.slice(begin, end).includes(BRIDGE_WAS_EMPTY_ARRAY_FLAG);
  // 删除 begin 标记行到 end 标记行（含两行及其后随换行），剩余前后内容拼接
  const restored = patch.slice(0, begin) + patch.slice(end + BRIDGE_END_MARK.length + 1);
  if (wasEmptyArray) {
    // 空数组改写分支：restored 即安装前的注释头，补回 []\n 实现字节级还原
    opts.fs.writeFile(patchPath, `${restored}[]\n`);
  } else {
    // 用户内容分支：归一化（去掉因追加/删除引入的多余空行与尾随空白）
    const normalized = restored.trim();
    if (normalized === '') {
      // 删除后仅剩空白：原为空数组/空文件，还原为 []
      opts.fs.writeFile(patchPath, '[]\n');
    } else {
      // 用户内容：去尾随空白后补单个换行，与安装前一致
      opts.fs.writeFile(patchPath, `${normalized}\n`);
    }
  }
  const targets = bridgeTargetDirs(profileDir, opts.npmGlobalNodeModules);
  // 全部目标目录删除均为尽力而为：权限锁死等场景下 rmDir 可能抛错，
  // 卸载的核心是回滚 patch 条目（保证 DSH 可干净启动），目录删除失败不应中断卸载。
  for (const dir of targets) {
    if (opts.fs.exists(dir)) {
      try {
        opts.fs.rmDir(dir);
      } catch {
        // 忽略：目录残留不影响 DSH 启动，用户可后续手工清理
      }
    }
  }
}

/**
 * 生产侧 Node fs 适配：把 node:fs 同步 API 封装为 InstallerFs 子集。
 * copyDir 用 fs.cpSync(src, dest, { recursive: true }) 递归复制。
 * 供 Task 7 装配时注入到 installBridge/uninstallBridge。
 */
export function createNodeFs(): InstallerFs {
  return {
    exists: (p) => nodeFs.existsSync(p),
    readFile: (p) => nodeFs.readFileSync(p, 'utf8'),
    writeFile: (p, content) => nodeFs.writeFileSync(p, content, 'utf8'),
    mkdir: (p) => nodeFs.mkdirSync(p, { recursive: true }),
    copyDir: (src, dest) => nodeFs.cpSync(src, dest, { recursive: true }),
    rmDir: (p) => nodeFs.rmSync(p, { recursive: true, force: true }),
    readdir: (p) => nodeFs.readdirSync(p),
  };
}

/**
 * 写入 cordis.patch.yml 的桥接条目（含 begin/end 标记）。
 * 顶层空数组 → 保留 [] 之前的注释头，改写为块序列；已有内容 → 追加。
 */
function writePatchEntry(fs: InstallerFs, patchPath: string, existing: string): void {
  if (isTopLevelEmptyArray(existing)) {
    // 顶层空数组（[] / 空文件 / 注释+[] 的默认模板）：
    // 1) 提取 [] 之前的注释头 head（原样保留全部注释行与空行）；
    // 2) 写入 head + 块序列条目，begin 标记携带 was-empty-array 元数据，
    //    供卸载时字节级还原为「head + []\n」。
    // 直接改写为块序列，避免在 [] 之后追加块序列导致 YAML 解析失败（fail-loud）。
    const head = findEmptyArrayHead(existing);
    const entry = buildPatchEntry(BRIDGE_BEGIN_MARK_WAS_EMPTY);
    fs.writeFile(patchPath, `${head}${entry}\n`);
  } else {
    // 已有用户内容：去尾随空白后追加，中间留一空行，绝不覆盖用户内容；
    // begin 标记不带 was-empty-array 元数据（安装行为与修复前一致）。
    const entry = buildPatchEntry(BRIDGE_BEGIN_MARK);
    fs.writeFile(patchPath, `${existing.trimEnd()}\n\n${entry}\n`);
  }
}

/**
 * 组装桥接条目段：begin 标记行 + insert: 包裹 + end 标记行（顶层块序列，可合法存在）。
 * beginMark 由调用方决定——空数组改写分支用带 was-empty-array 元数据的变体，
 * 用户内容追加分支用普通 BRIDGE_BEGIN_MARK。
 */
function buildPatchEntry(beginMark: string): string {
  return [
    beginMark,
    '- insert:',
    `    - id: ${BRIDGE_PACKAGE_NAME}`,
    `      name: ${BRIDGE_PACKAGE_NAME}`,
    BRIDGE_END_MARK,
  ].join('\n');
}

/**
 * 可用性验证：桥接目录完好与否，取决于能否读到含 `"name"` 字段的 package.json。
 * 读取抛错（权限不可读/chmod 000）或内容不含 `"name"` 均视为坏包 → 需要强制重装。
 * 仅 exist 判定会漏掉「目录在但包不可读」的坏场景（生产事故根因之一）。
 */
function isBridgeUsable(bridgeDir: string, fs: InstallerFs): boolean {
  const pkgPath = join(bridgeDir, 'package.json');
  try {
    return fs.readFile(pkgPath).includes('"name"');
  } catch {
    return false;
  }
}

/**
 * 复制桥接目录：目标目录的父级（node_modules，primary/secondary）或 npm 全局目录缺失则先创建，
 * 再递归复制 source → bridgeDir。
 * 生产侧 copyDir 用 fs.cpSync recursive，会同时创建目标目录与其父级。
 * 复制可能抛错（磁盘满/权限），由调用方负责回滚 patch。
 *
 * @param bridgeDir 目标目录绝对路径（父级由 dirname 推导后确保存在）
 */
function copyBridgeDir(opts: BridgeInstallOptions, bridgeDir: string): void {
  const parentDir = dirname(bridgeDir);
  if (!opts.fs.exists(parentDir)) opts.fs.mkdir(parentDir);
  opts.fs.copyDir(opts.bridgeSourceDir, bridgeDir);
}
