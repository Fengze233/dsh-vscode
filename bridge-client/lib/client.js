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
    // —— 握手与同步状态 ——
    let bridgeToken = ""; // 父页面下发的握手 token；未握手前为空，不激活任何拦截
    let sessionCwd = undefined; // 当前会话 cwd（由工作区同步兜底写入，供 openFile 消息使用）

    // —— DOM 拦截：外链与 fileMention 点击 → postMessage 转发给父页面（扩展） ——
    function bindLinkInterception() {
      document.addEventListener("click", (e) => {
        if (bridgeToken === "") return; // 未握手（普通浏览器打开）不激活
        const target = e.target;
        if (!target || typeof target.closest !== "function") return;
        // 外链：DSH 前端渲染为 <a target="_blank">，白名单校验后转发系统浏览器打开
        const anchor = target.closest("a");
        if (anchor && isAllowedExternalUrl(anchor.href)) {
          e.preventDefault();
          e.stopPropagation();
          parent.postMessage(buildOpenExternalMessage(anchor.href), "*");
          return;
        }
        // 文件路径按钮：DSH fileMention 渲染为 button.fileMention，label 取 aria-label/title/textContent
        const btn = target.closest("button[title], button[aria-label]");
        if (btn && btn.classList && btn.classList.contains("fileMention")) {
          e.preventDefault();
          e.stopPropagation();
          const label = btn.getAttribute("aria-label") || btn.getAttribute("title") || btn.textContent || "";
          parent.postMessage(buildOpenFileMessage(label, sessionCwd), "*");
        }
      }, true); // 捕获阶段：先于 DSH 自身处理器
    }

    // —— 接收父页面消息：握手 + 工作区同步 ——
    function onParentMessage(e) {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      // 握手：父页面下发 { kind: 'bridgeHello', token }，校验非空后回执 bridgeAck
      if (d.kind === "bridgeHello" && typeof d.token === "string" && d.token !== "") {
        bridgeToken = d.token;
        // 回执统一用 core.js 的 buildSyncWorkspaceAck 构造，形状与工作区同步回执一致
        // （{ kind: 'bridgeAck', ok }，不带 token 字段）；顶层 webview 靠 origin + source
        // 校验消息来源，按 { kind: 'bridgeAck', ok } 解析，避免同 kind 两种形状。
        parent.postMessage(buildSyncWorkspaceAck(true), "*");
        return;
      }
      // 工作区同步：父页面下发 { kind:'syncWorkspace', path, token }，token 校验通过后落地
      // （parseWorkspaceMessage 内部已完成 token 与形状校验，未握手时 bridgeToken 为空恒不通过）
      const path = parseWorkspaceMessage(d, bridgeToken);
      if (path !== undefined) syncWorkspaceFromParent(path);
    }

    // —— 工作区同步落地：fetch 拦截注入 cwd 兜底 ——
    // Task 0 未验证出可靠的前端"选中 workspace"触发路径，故采用兜底方案：
    // 包装 window.fetch，对 POST /api/session.create 信封在无 cwd/workspaceId 时注入 cwd，
    // 使新会话自动落在 VS Code 工作区（服务端已实证接受 cwd 字段，互斥于 workspaceId）。
    function syncWorkspaceFromParent(path) {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        try {
          const url = typeof input === "string" ? input : input && input.url;
          if (url && url.endsWith("/api/session.create") && init && init.method === "POST") {
            const body = JSON.parse(String(init.body));
            if (body && body.method === "session.create" && body.payload
                && body.payload.cwd === undefined && body.payload.workspaceId === undefined) {
              body.payload.cwd = path;
              init = { ...init, body: JSON.stringify(body) };
            }
          }
        } catch { /* 非 JSON 请求体忽略，不阻断原始请求 */ }
        return originalFetch(input, init);
      };
      // 记录会话 cwd，供 openFile 消息的相对路径解析使用
      sessionCwd = path;
    }

    // —— 入口：立即绑定 DOM 拦截与父消息监听，等待父页面握手 ——
    bindLinkInterception();
    window.addEventListener("message", onParentMessage);
    // cordis 插件约定：apply 挂载点（本桥接无需额外挂载，保留占位以符合插件契约）
    exports.apply = () => {};
    return module.exports;
  }
});
