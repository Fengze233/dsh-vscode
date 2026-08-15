// bridge-client/lib/client.js — DSH 页面内桥接 bundle（浏览器端，工厂注册）
// 重要说明：本文件是"模板"，工厂体内的核心逻辑占位标记会在构建时（scripts/build.mjs）
// 被 core.js 的纯逻辑内容替换，输出到 out/bridge-client/lib/client.js。
// 这样做的原因：DSH 的 client bundle 通过普通 <script> 加载，工厂的 require 只解析
// 包名 / 平台种子词，不支持相对路径 require('./core.js')；ESM import 在普通 script 中
// 同样不可用。因此把 core.js 内联进工厂，保证"生产运行的逻辑 = 单测验证的逻辑"同一份源码。
// 分工：core.js 保持纯函数、无 DOM、无 window 引用；本文件只做 DOM 事件绑定与 postMessage。
window.__ModuleLoader__.load({
  // id 必须等于 package.json 的 name（节点侧以此作为图条目 id 与 URL 路径）
  id: "dsh-vscode-bridge",
  // factory 体在 materialize 阶段执行（shell 启动时为每个插件行触发）
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    /*__CORE_INLINE__*/
    // —— 验证标记：证明本 bundle 已在页面内 materialize 并执行（供 Task 0/9 回归用） ——
    window.__dshVscodeBridgeReady = true;
    console.log("[dsh-vscode-bridge] client.js executed");
    // —— 握手状态 ——
    let bridgeToken = ""; // 父页面下发的握手 token；未握手前为空，不激活任何拦截
    // —— postMessage：接收父页面消息（握手 + 工作区同步） ——
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      // 握手：父页面下发 { kind: 'bridgeHello', token }，校验非空后回执 bridgeAck
      if (d.kind === "bridgeHello" && typeof d.token === "string" && d.token !== "") {
        bridgeToken = d.token;
        parent.postMessage({ kind: "bridgeAck", ok: true, token: bridgeToken }, "*");
        return;
      }
      // 后续消息统一校验 token（isBridgeMessage 来自内联的 core.js）
      if (!isBridgeMessage(d, bridgeToken)) return;
      // 工作区同步等其余业务逻辑在 Task 5 补齐
    });
    // cordis 插件约定：apply 挂载点（Task 5 在此挂 DOM 拦截 / 读取注入的服务）
    exports.apply = () => {};
    return module.exports;
  }
});
