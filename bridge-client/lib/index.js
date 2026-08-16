// bridge-client/lib/index.js — host 侧空插件：仅用于配置树注册，无业务（业务全在浏览器端 client.js）
import { Service } from "@deepseek-ai/cordis";
export const name = "dsh-vscode-bridge";
export default class extends Service {
  constructor(ctx) { super(ctx, name); }
}
