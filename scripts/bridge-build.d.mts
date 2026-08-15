// scripts/bridge-build.d.mts — bridge-build.mjs 的类型声明（供 TS 侧 import 获得类型）

/** buildBridgeClient 的构建参数 */
export interface BuildBridgeClientOptions {
  /** core.js 源码文件路径（位于 <包根>/lib/core.js） */
  coreSource: string;
  /** client.js 工厂模板文件路径（含 CORE_INLINE 占位符标记） */
  clientTemplate: string;
  /** 输出目录（产物写入 outDir/lib/client.js，并复制 package.json 与 lib/index.js） */
  outDir: string;
}

/**
 * 构建桥接客户端内联产物：读取 core.js、去掉顶层 export 前缀、校验占位符唯一，
 * 内联进 client.js 模板并写入 outDir/lib/client.js，同时复制 package.json 与 lib/index.js。
 *
 * @returns 产物路径（outDir/lib/client.js）
 */
export function buildBridgeClient(opts: BuildBridgeClientOptions): string;
