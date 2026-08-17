// test/bridge/index-zero-dep.test.ts — 桥接 host 插件「零外部依赖」约束防回归测试
// 背景（Windows 实测根因，见 bridge-zero-dep 修复）：
// VS Code 扩展宿主 spawn 的 dsh 进程对 include 条目走「裸 ESM import」解析路径，
// 桥接包会从 npm 全局顶层 node_modules 被加载；而 cordis 等依赖嵌套在
// @deepseek-ai/dsh/node_modules 内部，顶层解析不到——index.js 里任何外部 import
// （如 import { Service } from "@deepseek-ai/cordis"）都会在该场景抛
// ERR_MODULE_NOT_FOUND 使整个插件树加载失败。
// 因此 index.js 必须是「零 import 单文件 + cordis 函数式插件」，
// 本测试锁死这一约束，防止未来无意中加回外部依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 读取 bridge-client/lib/index.js 源码 */
function readIndexSource(): string {
  return readFileSync(join(process.cwd(), 'bridge-client', 'lib', 'index.js'), 'utf8');
}

test('index.js 零外部依赖：不含任何 import/require/re-export', () => {
  const code = readIndexSource();
  // 移除注释后再做文本检测（注释里的「不得 import」说明文字不算依赖）
  const noComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const realLines = noComments
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const hasImport = realLines.some((l) => l.startsWith('import '));
  const hasDynamicImport = noComments.includes('import(');
  const hasRequire = noComments.includes('require(');
  // re-export（export ... from "pkg"）同样会引入外部依赖，且不含 import/require 关键字，须单独检测
  const hasReExport = /from\s+["']/.test(noComments);
  assert.equal(hasImport, false, '不得出现静态 import 语句（外部依赖会让 VS Code 场景插件树加载失败）');
  assert.equal(hasDynamicImport, false, '不得出现动态 import()');
  assert.equal(hasRequire, false, '不得出现 require()');
  assert.equal(hasReExport, false, '不得出现 export ... from 形式的 re-export（同样引入外部依赖）');
});

test('index.js 为 cordis 函数式插件且插件名与包名一致', () => {
  const code = readIndexSource();
  // 函数式插件：export default 一个函数（cordis registry.plugin 对 typeof === "function" 直接支持）
  assert.ok(/export default\s+\w+;/.test(code), '应为 export default 具名函数插件');
  assert.ok(/function\s+\w+\s*\(\s*ctx\s*\)/.test(code), '应为接收 ctx 的函数式插件');
  // 插件名须用 Object.defineProperty 设置（ESM 严格模式下函数 name 只读，直接赋值会抛 TypeError）
  assert.ok(/Object\.defineProperty\(\s*plugin\s*,\s*"name"\s*,\s*\{\s*value:\s*"dsh-vscode-bridge"\s*\}\s*\)/.test(code), '插件名应通过 Object.defineProperty 设为包名 dsh-vscode-bridge');
  // 移除注释后，运行代码不得引用 @deepseek-ai/cordis 包
  const codeWithoutComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!codeWithoutComments.includes('@deepseek-ai/cordis'), '运行代码不得引用 @deepseek-ai/cordis');
});
