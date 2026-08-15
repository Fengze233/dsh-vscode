// scripts/build.mjs — esbuild 构建脚本
// 用法：node scripts/build.mjs            # 构建扩展 + 桥接客户端 + 测试
//       node scripts/build.mjs --test     # 只构建测试
//       node scripts/build.mjs --watch    # 监听模式
import { build, context } from 'esbuild';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const testOnly = process.argv.includes('--test');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

// 扩展入口：external vscode（由 VS Code 宿主提供）
const ext = {
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  external: ['vscode'],
  ...common,
};

// 测试入口：递归收集 test 目录下的 *.test.ts
const testEntries = readdirSync('test', { recursive: true })
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join('test', f));
const tests = {
  entryPoints: testEntries,
  outdir: 'out/test',
  // 测试环境没有 VS Code 宿主，用本地桩替代 vscode 模块，
  // 使 config.ts 等引用 vscode 的模块可被 node --test 加载。
  alias: { vscode: join(process.cwd(), 'test/vscode-stub.ts') },
  ...common,
};

// 桥接客户端构建：把 core.js 的纯逻辑内联进 client.js 工厂注册 bundle。
// 背景：DSH 的 client bundle 通过普通 <script> 加载，工厂的 require 只解析
// 包名 / 平台种子词，不支持相对路径 require('./core.js')；ESM import 在普通
// script 中同样不可用。为保证"生产运行逻辑 = 单测验证逻辑"同一份源码，
// 构建时把 core.js（去掉顶层 export 前缀）拼进 client.js 的 /*__CORE_INLINE__*/
// 占位符，输出到 out/bridge-client/，使该目录成为完整可安装的包（供 Task 2 installer 复制）。
function buildBridgeClient() {
  const core = readFileSync(join('bridge-client', 'lib', 'core.js'), 'utf8');
  const client = readFileSync(join('bridge-client', 'lib', 'client.js'), 'utf8');
  // 占位符必须且仅出现一次（否则说明模板或注释里混入了同名文本，替换会错位）
  const marker = '/*__CORE_INLINE__*/';
  const occurrences = client.split(marker).length - 1;
  if (occurrences !== 1) {
    throw new Error(`bridge-client/lib/client.js 应包含且仅包含一个 ${marker} 占位符，实际 ${occurrences} 个`);
  }
  // 去掉顶层 export 前缀，使 core.js 的函数/常量成为 client.js 工厂内的局部声明
  const coreInlined = core.replace(/^export\s+/gm, '');
  const outRoot = join('out', 'bridge-client');
  const outLib = join(outRoot, 'lib');
  mkdirSync(outLib, { recursive: true });
  writeFileSync(join(outLib, 'client.js'), client.replace(marker, coreInlined));
  copyFileSync(join('bridge-client', 'package.json'), join(outRoot, 'package.json'));
  copyFileSync(join('bridge-client', 'lib', 'index.js'), join(outLib, 'index.js'));
  console.log('桥接客户端已构建到 out/bridge-client/');
}

const configs = testOnly ? [tests] : [ext, tests];
if (watch) {
  await Promise.all(configs.map((c) => context(c).then((ctx) => ctx.watch())));
  // 监听模式下桥接客户端仅构建一次（未对 core.js/client.js 挂 watcher，改动需重启 watch）
  if (!testOnly) buildBridgeClient();
  console.log('watch 模式已启动');
} else {
  await Promise.all(configs.map((c) => build(c)));
  if (!testOnly) buildBridgeClient();
  console.log('构建完成');
}
