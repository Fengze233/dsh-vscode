// bridge-client/lib/index.js — host 侧空插件：仅用于插件树注册，无业务（业务全在浏览器端 client.js）
//
// 零外部依赖（重要约束）：本文件不得 import 任何外部包，包括 @deepseek-ai/cordis。
// 背景（Windows 实测根因，见 bridge-zero-dep 修复）：
// VS Code 扩展宿主 spawn 的 dsh 进程拿不到 dsh 内部模块加载 hook，include 条目
// 回退到「裸 ESM import」路径——其解析锚点是 cordis-plugin-loader 自身的文件位置
// （dsh 安装目录内部），因此桥接包会从 npm 全局顶层 node_modules 被加载；
// 而 npm 全局安装的依赖（如 cordis）嵌套在 @deepseek-ai/dsh/node_modules 内部，
// 顶层解析不到。桥接包自身的任何外部 import 都会在此场景抛出
// ERR_MODULE_NOT_FOUND（Cannot find package '@deepseek-ai/cordis'）。
// 解决办法：改用 cordis 官方支持的「函数式插件」（registry.plugin 对
// typeof plugin === "function" 直接作为插件回调，调用时传入 ctx），
// 使本文件成为零 import 的单文件，从根上消灭对依赖解析的依赖——
// 无论 dsh 从 profiles 还是 npm 全局顶层加载本包，都不再需要解析任何外部包。
const plugin = function dshVscodeBridge(ctx) {
  // 空实现：host 侧无需任何行为。桥接业务（外链跳转、文件路径跳转、
  // 握手校验等）全部在浏览器端 client.js（window.__ModuleLoader__.load 工厂）完成。
  // 参数 ctx 为 cordis 上下文，本插件不使用，保留形参以符合函数式插件契约。
  void ctx;
};
// 插件名与 package.json 的 name 一致（cordis 以函数对象的 name 属性作为插件名）。
// 注意：ESM 严格模式下函数对象的 name 属性只读（writable: false），直接赋值会抛
// TypeError，必须用 Object.defineProperty 改写（name 属性本身 configurable: true）。
Object.defineProperty(plugin, "name", { value: "dsh-vscode-bridge" });
export default plugin;
