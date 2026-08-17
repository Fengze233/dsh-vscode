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

    // —— 剪贴板桥接：VS Code webview 对跨源 iframe 的 navigator.clipboard.writeText 有权限拦截 ——
    // 背景：即使 iframe 声明 allow="clipboard-write"，VS Code（Electron）仍会拒绝写入
    // （microsoft/vscode#182642），DSH 的 execCommand('copy') 回退在内嵌场景也不可靠。
    // 因此握手成功后接管 writeText：文本经父页面转发给扩展宿主，由 vscode.env.clipboard 写系统剪贴板。
    let copyRequestSeq = 0;
    const copyPending = new Map();

    function copyViaBridge(text) {
      return new Promise((resolve, reject) => {
        const requestId = "copy-" + (++copyRequestSeq) + "-" + Date.now();
        const timer = setTimeout(() => {
          copyPending.delete(requestId);
          reject(new Error("dsh-vscode-bridge copyText timeout"));
        }, 5000);
        copyPending.set(requestId, {
          resolve: (ok) => {
            clearTimeout(timer);
            if (ok) resolve(); else reject(new Error("dsh-vscode-bridge copyText failed"));
          },
        });
        parent.postMessage(buildCopyTextMessage(text, requestId), "*");
      });
    }

    function installClipboardBridge() {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") return;
      const originalWriteText = clipboard.writeText.bind(clipboard);
      const bridgedWriteText = function (text) {
        // 未握手（普通浏览器 / 桥接禁用）走原生 API；已握手走扩展宿主，绕开 VS Code 权限拦截。
        if (bridgeToken === "") return originalWriteText(text);
        return copyViaBridge(String(text));
      };
      // 先 defineProperty（可覆盖 configurable 的实例自有属性），失败再退化为直接赋值。
      try {
        Object.defineProperty(clipboard, "writeText", { configurable: true, writable: true, value: bridgedWriteText });
      } catch {
        try {
          clipboard.writeText = bridgedWriteText;
        } catch {
          // 剪贴板对象完全不可改写时放弃接管：DSH 仍会走原生 API 与其 execCommand 回退。
        }
      }
    }
    installClipboardBridge();

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
          // openFile 消息仍发送 path；不带 cwd 字段（工作区同步已移除，会话 cwd 不再维护），
          // 扩展侧以工作区根目录作为相对路径解析兜底。
          parent.postMessage(buildOpenFileMessage(label), "*");
        }
      }, true); // 捕获阶段：先于 DSH 自身处理器
    }

    // —— 接收父页面消息：握手 + 剪贴板回执 ——
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
      // 剪贴板回执：resolve / reject 对应的 writeText Promise
      if (d.kind === "copyTextAck" && typeof d.requestId === "string" && typeof d.ok === "boolean") {
        const pending = copyPending.get(d.requestId);
        if (pending) {
          copyPending.delete(d.requestId);
          pending.resolve(d.ok);
        }
        return;
      }
    }

    // —— 入口：立即绑定 DOM 拦截与父消息监听，等待父页面握手 ——
    bindLinkInterception();
    window.addEventListener("message", onParentMessage);
    // cordis 插件约定：apply 挂载点（本桥接无需额外挂载，保留占位以符合插件契约）
    exports.apply = () => {};
    return module.exports;
  }
});
