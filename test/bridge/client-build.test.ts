// test/bridge/client-build.test.ts — 桥接客户端内联构建冒烟测试
// 目的：生产运行的是 out/bridge-client/lib/client.js 内联产物，而 core.test.ts 只 import
// 源码 core.js——若 buildBridgeClient 的去 export 正则回归（如 core.js 未来出现
// export default / export { x }），源码单测仍全绿却产出坏产物。本测试直接对构建产物
// 做语法与关键内容校验，把"生产可用性"纳入自动化验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBridgeClient } from '../../scripts/bridge-build.mjs';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('buildBridgeClient 内联产物语法合法且不含 export/占位符残留', () => {
  // 输出到系统临时目录，避免污染 out/；测试结束（含断言失败）都删除临时目录
  const outDir = join(tmpdir(), `dsh-bridge-smoke-${process.pid}-${Date.now()}`);
  // 输入指向真实源码与模板（npm test 在项目根运行，故用 process.cwd() 定位）
  const coreSource = join(process.cwd(), 'bridge-client', 'lib', 'core.js');
  const clientTemplate = join(process.cwd(), 'bridge-client', 'lib', 'client.js');
  const built = buildBridgeClient({ coreSource, clientTemplate, outDir });
  try {
    // 返回值应为 outDir/lib/client.js
    assert.equal(built, join(outDir, 'lib', 'client.js'));
    const code = readFileSync(built, 'utf8');
    // ① 语法合法：new Function 构造时即做语法解析、不执行函数体，
    //    因此即使产物内含 window 引用也是安全的（只解析、不运行）。
    assert.doesNotThrow(() => {
      new Function(code);
    });
    // ② 包含核心逻辑与包名标识
    assert.ok(code.includes('isBridgeMessage'), '产物应包含 isBridgeMessage');
    assert.ok(code.includes('isAllowedExternalUrl'), '产物应包含 isAllowedExternalUrl');
    assert.ok(code.includes('buildCopyTextMessage'), '产物应包含剪贴板桥接消息构造');
    assert.ok(code.includes('copyViaBridge'), '产物应包含 writeText 接管逻辑');
    assert.ok(code.includes('dsh-vscode-bridge'), '产物应包含包名 dsh-vscode-bridge');
    // ③ 不含占位符（替换应已完成）
    assert.ok(!code.includes('/*__CORE_INLINE__*/'), '产物不应残留占位符');
    // ④ 不含 export 前缀残留（去 export 正则应生效）
    assert.ok(!/^export\s+/m.test(code), '产物不应残留行首 export 前缀');
    // 顺带验证复制出的 package.json 与 index.js 存在（outDir 应为完整可安装包）
    assert.ok(existsSync(join(outDir, 'package.json')), '应复制出 package.json');
    assert.ok(existsSync(join(outDir, 'lib', 'index.js')), '应复制出 lib/index.js');
  } finally {
    // 无论通过与否，都清理临时目录
    rmSync(outDir, { recursive: true, force: true });
  }
});
