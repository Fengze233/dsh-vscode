// scripts/bridge-build.mjs — 桥接客户端内联构建（独立模块，供 build.mjs 与冒烟测试复用）
// 背景：DSH 的 client bundle 通过普通 <script> 加载，工厂的 require 只解析
// 包名 / 平台种子词，不支持相对路径 require('./core.js')；ESM import 在普通 script 中
// 同样不可用。为保证"生产运行逻辑 = 单测验证逻辑"同一份源码，构建时把 core.js
// （去掉顶层 export 前缀）内联进 client.js 模板的 /*__CORE_INLINE__*/ 占位符，
// 输出到 outDir，使该目录成为完整可安装的包（供 Task 2 installer 复制）。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// 占位符标记：client.js 模板里必须且仅出现一次
const CORE_INLINE_MARKER = '/*__CORE_INLINE__*/';

/**
 * 构建桥接客户端内联产物。
 *
 * @param {{ coreSource: string, clientTemplate: string, outDir: string }} opts 构建参数
 *   - coreSource：core.js 源码文件路径（位于 <包根>/lib/core.js）
 *   - clientTemplate：client.js 工厂模板文件路径（含 /*__CORE_INLINE__* / 占位符）
 *   - outDir：输出目录（产物写入 outDir/lib/client.js，并复制 package.json 与 lib/index.js）
 * @returns {string} 产物路径（outDir/lib/client.js）
 */
export function buildBridgeClient(opts) {
  const { coreSource, clientTemplate, outDir } = opts;
  const core = readFileSync(coreSource, 'utf8');
  const client = readFileSync(clientTemplate, 'utf8');
  // 占位符必须且仅出现一次（否则说明模板或注释里混入了同名文本，替换会错位）
  const occurrences = client.split(CORE_INLINE_MARKER).length - 1;
  if (occurrences !== 1) {
    throw new Error(`bridge-client/lib/client.js 应包含且仅包含一个 ${CORE_INLINE_MARKER} 占位符，实际 ${occurrences} 个`);
  }
  // 去掉顶层 export 前缀，使 core.js 的函数/常量成为 client.js 工厂内的局部声明。
  // 这里刻意只用 replace(/^export\s+/gm, '')：未来 core.js 若出现 export default / export { x }
  // 这类写法，本构建会静默产出含 export 残留的坏产物——正因如此，冒烟测试
  // test/bridge/client-build.test.ts 会断言产物不含 'export ' 前缀残留，以尽早拦截回归。
  const coreInlined = core.replace(/^export\s+/gm, '');
  const outLib = join(outDir, 'lib');
  mkdirSync(outLib, { recursive: true });
  const outClient = join(outLib, 'client.js');
  writeFileSync(outClient, client.replace(CORE_INLINE_MARKER, coreInlined));
  // 把包根的 package.json、lib/index.js 复制到 outDir，使 outDir 成为完整可安装的包。
  // 包根目录由 coreSource 推导（coreSource 位于 <包根>/lib/core.js）。
  const pkgRoot = dirname(dirname(coreSource));
  copyFileSync(join(pkgRoot, 'package.json'), join(outDir, 'package.json'));
  copyFileSync(join(pkgRoot, 'lib', 'index.js'), join(outLib, 'index.js'));
  console.log(`桥接客户端已构建到 ${outDir}/`);
  return outClient;
}
