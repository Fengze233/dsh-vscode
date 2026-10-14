// src/bridge/profile-name.ts — profile 名称的合法形态（无 vscode 依赖，可被卸载钩子复用）
// 为什么单独成文件：config.ts 依赖 vscode，而 VS Code 卸载扩展时执行的 uninstall.ts
// 不能 import vscode（不在扩展宿主里）；把它放在无依赖模块，两边共用同一份规则。
/** profile 名称允许字母、数字、点、下划线与连字符，不能是路径或命令行选项。 */
export const PROFILE_NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._][A-Za-z0-9._-]*$/;
