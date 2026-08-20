// bridge-client/lib/client.js — DSH 页面内桥接 bundle（浏览器端，工厂注册）
// 重要说明：本文件是"模板"，工厂体内的核心逻辑占位标记会在构建时（scripts/build.mjs）
// 被 core.js 的纯逻辑内容替换，输出到 out/bridge-client/lib/client.js。
// 这样做的原因：DSH 的 client bundle 通过普通 <script> 加载，工厂的 require 只解析
// 包名 / 平台种子词，不支持相对路径 require('./core.js')；ESM import 在普通 script 中
// 同样不可用。因此把 core.js 内联进工厂，保证"生产运行的逻辑 = 单测验证的逻辑"同一份源码。
// 分工：core.js 保持纯函数、无 DOM、无 window 引用；本文件只做 DOM 事件绑定与 postMessage。
// 额外职责（Task 复制修复 v0.2.4）：VS Code 在 macOS 上会吞掉嵌套 iframe 里的
// Cmd+C / Cmd+V / Cmd+A 等标准快捷键与右键菜单（microsoft/vscode#129178 / #180234），
// 因此握手成功后由本文件捕获 keydown/contextmenu：keydown 用 document.execCommand
// 模拟标准编辑命令（复制/粘贴/剪切/全选/撤销/重做），失败时经剪贴板桥接兜底；
// contextmenu 弹出自定义右键菜单，不再依赖 VS Code 的原生菜单。
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

    // —— 剪贴板写桥接：VS Code webview 对跨源 iframe 的 navigator.clipboard.writeText 有权限拦截 ——
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

    // —— 剪贴板读桥接：供 Cmd+V 粘贴兜底 ——
    // VS Code 对 iframe 内的 execCommand('paste') 不一定放行，因此扩展宿主直接读系统剪贴板
    // （vscode.env.clipboard.readText 无 webview 权限限制），把文本回传后插入焦点可编辑元素。
    let readRequestSeq = 0;
    const readPending = new Map();

    function readViaBridge() {
      return new Promise((resolve, reject) => {
        const requestId = "read-" + (++readRequestSeq) + "-" + Date.now();
        const timer = setTimeout(() => {
          readPending.delete(requestId);
          reject(new Error("dsh-vscode-bridge readText timeout"));
        }, 5000);
        readPending.set(requestId, {
          resolve: (ok, text) => {
            clearTimeout(timer);
            if (ok) resolve(text); else reject(new Error("dsh-vscode-bridge readText failed"));
          },
        });
        parent.postMessage(buildReadTextMessage(requestId), "*");
      });
    }

    // —— 标准编辑命令仿真（修复 VS Code 吞掉 iframe 内 Cmd+C/V/A/X/Z 的问题） ——
    // 原理：VS Code 只在顶层 webview 转发快捷键（setIgnoreMenuShortcuts + 命令回投），
    // 嵌套 iframe 收不到命令；但 iframe 内的 keydown 事件仍可达，于是这里捕获按键后
    // 自行调用 document.execCommand 模拟（Flutter DevTools 已在同类场景验证有效），
    // 失败时再用剪贴板桥接兜底，保证复制/粘贴在 macOS 上可用。

    // 读取当前选区文本（复制/剪切及右键菜单可用性判断用）。
    // 注意：Chromium 中 textarea/input 聚焦时的选区不体现在 window.getSelection()，
    // 因此除文档选区外，还要读聚焦可编辑元素内的选区，避免复制兜底/菜单置灰失效。
    function readSelectionText() {
      let text = "";
      try {
        const sel = window.getSelection();
        text = sel && sel.rangeCount ? sel.toString() : "";
      } catch {
        text = "";
      }
      if (text) return text;
      // 文档选区为空：尝试从聚焦的 textarea/input 读其内部选区
      try {
        const el = focusedEditable();
        if (el && typeof el.value === "string" && typeof el.selectionStart === "number") {
          text = el.value.slice(el.selectionStart, el.selectionEnd);
        }
      } catch {
        text = "";
      }
      return text;
    }

    // 执行页面级编辑命令；成功返回 true，失败（不支持/被拒）返回 false
    function tryExecCommand(cmd) {
      try {
        return document.execCommand(cmd);
      } catch {
        return false;
      }
    }

    // 当前焦点是否在可编辑元素（textarea / 可输入 input / contenteditable）
    function focusedEditable() {
      const el = document.activeElement;
      return isEditableElement(el) ? el : null;
    }

    // 用原生 setter 写入可编辑元素的值并触发 input 事件（兼容 React 受控组件，
    // 直接赋值 el.value 不会让 React onChange 感知状态变化）
    function writeEditableValue(el, value) {
      const proto =
        el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : el.tagName === "INPUT"
            ? HTMLInputElement.prototype
            : null;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      // 通知 React/原生监听器：input 事件会携带新值触发 onChange
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 把文本插入焦点可编辑元素（粘贴/剪切的兜底写入路径）
    function insertTextIntoFocused(el, text) {
      // contenteditable 用 execCommand 插入，自动处理光标/撤销栈
      if (isEditableElement(el) && el.isContentEditable) {
        try {
          document.execCommand("insertText", false, text);
          return true;
        } catch {
          return false;
        }
      }
      // textarea / input：手动替换选区并触发 input 事件
      try {
        const next = computeInsertedValue(el.value, el.selectionStart, el.selectionEnd, text);
        writeEditableValue(el, next);
        const pos = (el.selectionStart ?? 0) + text.length;
        try {
          el.setSelectionRange(pos, pos);
        } catch {
          // 非文本型元素可能不支持 setSelectionRange，忽略
        }
        return true;
      } catch {
        return false;
      }
    }

    // 执行一条被仿真的编辑命令（异步，粘贴/复制兜底需要桥接往返）
    async function handleEditCommand(cmd) {
      switch (cmd) {
        case "copy": {
          // 优先 execCommand（立即且不移动选区）；失败则把选区文本经桥接写入系统剪贴板
          if (tryExecCommand("copy")) return;
          const text = readSelectionText();
          if (!text) return;
          try {
            await copyViaBridge(text);
          } catch {
            // 写剪贴板失败：静默放弃（与没有选区时按 Cmd+C 行为一致）
          }
          break;
        }
        case "cut": {
          if (tryExecCommand("cut")) return;
          const el = focusedEditable();
          if (!el) return;
          const text = readSelectionText();
          // 剪贴板内容取 textarea 选区（readSelectionText 的 window.getSelection 在
          // 输入框内可能读不到），因此优先直接从元素选区读值
          const elText =
            typeof el.value === "string" && typeof el.selectionStart === "number"
              ? el.value.slice(el.selectionStart, el.selectionEnd)
              : text;
          if (!elText) return;
          try {
            await copyViaBridge(elText);
          } catch {
            return;
          }
          // 删除选区并同步 React 状态
          insertTextIntoFocused(el, "");
          break;
        }
        case "paste": {
          // 优先 execCommand('paste')：成功后浏览器会自行派发 paste 事件，
          // DSH 的输入控件（含富文本/代码编辑器）能按原生逻辑处理
          if (tryExecCommand("paste")) return;
          // 兜底：经桥接读取系统剪贴板，手动写入焦点可编辑元素
          const el = focusedEditable();
          if (!el) return;
          let text = null;
          try {
            text = await readViaBridge();
          } catch {
            return;
          }
          if (typeof text !== "string" || text === "") return;
          insertTextIntoFocused(el, text);
          break;
        }
        case "selectAll":
          tryExecCommand("selectAll");
          break;
        case "undo":
          tryExecCommand("undo");
          break;
        case "redo":
          tryExecCommand("redo");
          break;
      }
    }

    // —— 自定义右键菜单（VS Code 不向 iframe 上层弹原生菜单，此处自绘） ——
    // 菜单样式采用中性深色（带阴影与圆角），在浅/深色主题下都清晰可辨。
    const MENU_CSS =
      "#dsh-bridge-menu{position:fixed;z-index:2147483647;min-width:160px;margin:0;padding:4px;" +
      "background:#2d2d30;color:#cccccc;border:1px solid #454545;border-radius:6px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.35);font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "user-select:none;display:none;}" +
      "#dsh-bridge-menu button{display:block;width:100%;text-align:left;padding:5px 10px;" +
      "background:transparent;border:none;color:inherit;font:inherit;border-radius:4px;cursor:pointer;}" +
      "#dsh-bridge-menu button:hover:not(:disabled){background:#094771;color:#fff;}" +
      "#dsh-bridge-menu button:disabled{opacity:.38;cursor:default;}" +
      "#dsh-bridge-menu .dsh-bridge-sep{height:1px;background:#454545;margin:4px 8px;}" +
      "#dsh-bridge-menu .dsh-bridge-ok{color:#89d185;}" +
      "#dsh-bridge-menu button:focus{outline:none;}";
    let menuEl = null;
    let menuCopyBtn = null;
    let menuPasteBtn = null;
    let menuCutBtn = null;
    let menuUndoBtn = null;
    let menuRedoBtn = null;

    // 按当前焦点/选区状态刷新菜单项的可用性
    function updateMenuEnabled() {
      const editable = focusedEditable();
      const hasSelection = readSelectionText() !== "";
      menuCopyBtn.disabled = !hasSelection;
      menuCutBtn.disabled = !(editable && hasSelection);
      menuPasteBtn.disabled = !editable;
      menuUndoBtn.disabled = !editable;
      menuRedoBtn.disabled = !editable;
    }

    // 菜单项点击统一入口：隐藏菜单后执行对应编辑命令
    function menuAction(cmd) {
      hideMenu();
      void handleEditCommand(cmd);
    }

    // 懒创建菜单 DOM（首次右键时注入样式与按钮）
    function ensureMenu() {
      if (menuEl) return menuEl;
      const style = document.createElement("style");
      style.textContent = MENU_CSS;
      document.head.append(style);
      menuEl = document.createElement("div");
      menuEl.id = "dsh-bridge-menu";
      menuEl.setAttribute("role", "menu");
      const mkBtn = (label, cmd) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.setAttribute("role", "menuitem");
        b.addEventListener("click", () => menuAction(cmd));
        return b;
      };
      const sep = () => {
        const s = document.createElement("div");
        s.className = "dsh-bridge-sep";
        return s;
      };
      // 复制/粘贴/剪切/全选 + 撤销/重做（顺序与系统菜单惯例一致）
      menuCopyBtn = mkBtn("复制", "copy");
      menuPasteBtn = mkBtn("粘贴", "paste");
      menuCutBtn = mkBtn("剪切", "cut");
      const menuSelectAllBtn = mkBtn("全选", "selectAll");
      menuUndoBtn = mkBtn("撤销", "undo");
      menuRedoBtn = mkBtn("重做", "redo");
      menuEl.append(menuCopyBtn, menuPasteBtn, menuCutBtn, menuSelectAllBtn, sep(), menuUndoBtn, menuRedoBtn);
      document.body.append(menuEl);
      // 菜单自身点击不冒泡到"关闭菜单"的全局监听
      menuEl.addEventListener("pointerdown", (e) => e.stopPropagation());
      return menuEl;
    }

    // 在指定视口坐标显示菜单（自动翻转避免溢出窗口）
    function showMenuAt(x, y) {
      const menu = ensureMenu();
      updateMenuEnabled();
      menu.style.display = "block";
      const rect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x;
      let top = y;
      if (left + rect.width > vw - 4) left = Math.max(4, vw - rect.width - 4);
      if (top + rect.height > vh - 4) top = Math.max(4, top - rect.height - 8);
      menu.style.left = left + "px";
      menu.style.top = top + "px";
    }

    // 隐藏自定义右键菜单
    function hideMenu() {
      if (menuEl) menuEl.style.display = "none";
    }

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

    // —— keydown 拦截：仿真标准编辑快捷键（VS Code 吞掉 Cmd+C/V/A/X/Z 的修复） ——
    function onKeyDown(e) {
      // Esc 仅用于收起自定义右键菜单，任何状态下都响应
      if (e.key === "Escape") {
        hideMenu();
        // 不 preventDefault：把 Esc 继续交给 DSH 页面自身处理（如关闭弹窗）
        return;
      }
      if (bridgeToken === "") return; // 未握手（普通浏览器）不干涉原生行为
      const cmd = getShortcutCommand(e);
      if (!cmd) return;
      // 捕获阶段拦截：阻止事件继续传播，避免 DSH 自身处理器或 VS Code 二次处理产生冲突
      e.preventDefault();
      e.stopPropagation();
      hideMenu();
      void handleEditCommand(cmd);
    }

    // —— contextmenu 拦截：弹出自定义右键菜单（VS Code 不向 iframe 弹原生菜单） ——
    function onContextMenu(e) {
      if (bridgeToken === "") return; // 未握手（普通浏览器）保留原生右键菜单
      e.preventDefault();
      e.stopPropagation();
      showMenuAt(e.clientX, e.clientY);
    }

    // —— 接收父页面消息：握手 + 剪贴板回执 ——
    function onParentMessage(e) {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      // 握手：父页面下发 { kind: 'bridgeHello', token }，校验非空后回执 bridgeAck
      if (d.kind === "bridgeHello" && typeof d.token === "string" && d.token !== "") {
        bridgeToken = d.token;
        imageFallbackEnabled = d.imageFallback === true; // v0.3.0：非视觉模型图片降级开关（随 hello 下发）
        // 诊断日志：页面可据此确认握手成功与降级开关状态（排查“图片上传不生效”用）
        console.log("[dsh-vscode-bridge] handshake ok, v0.3.0, imageFallback=" + imageFallbackEnabled);
        // 附件图片捕获已由工厂期常驻绑定（bindImageCapture），此处仅刷新开关即可生效
        // 回执统一用 core.js 的 buildSyncWorkspaceAck 构造，形状与工作区同步回执一致
        // （{ kind: 'bridgeAck', ok }，不带 token 字段）；顶层 webview 靠 origin + source
        // 校验消息来源，按 { kind: 'bridgeAck', ok } 解析，避免同 kind 两种形状。
        parent.postMessage(buildSyncWorkspaceAck(true), "*");
        return;
      }
      // 剪贴板写回执：resolve / reject 对应的 writeText Promise
      if (d.kind === "copyTextAck" && typeof d.requestId === "string" && typeof d.ok === "boolean") {
        const pending = copyPending.get(d.requestId);
        if (pending) {
          copyPending.delete(d.requestId);
          pending.resolve(d.ok);
        }
        return;
      }
      // 剪贴板读回执：resolve / reject 对应的 readText Promise
      if (d.kind === "readTextAck" && typeof d.requestId === "string" && typeof d.ok === "boolean") {
        const pending = readPending.get(d.requestId);
        if (pending) {
          readPending.delete(d.requestId);
          pending.resolve(d.ok, d.ok && typeof d.text === "string" ? d.text : "");
        }
        return;
      }
    }


    // —— v0.3.0 图片自由上传：捕获图片字节 + 发送被拒(模型无视觉)自动降级为路径转发 ——
    // 全程仅在该标识为 true（父页面握手时随 bridgeHello 下发 dsh.image.fallback=true）时生效；
    // 未握手或降级关闭时，本段落不改变任何原生行为（与 v0.2.4 保持一致）。
    let imageFallbackEnabled = false; // 是否允许非视觉模型图片降级
    const imageCache = new Map(); // key(imageCacheKey) -> { name, b64, mime }
    let fallbackResendInFlight = false; // 幂等：一个被拒只触发一次重发
    const persistedForCleanup = []; // 本次已落盘路径（pagehide 时删除）

    // 字节数组 → base64（页面内 btoa 可用；仅用于桥接通道传输，不影响 DSH 原生附件）
    function bytesToBase64(bytes) {
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }

    // 附件捕获入口：图片类型 + 有指纹 + 未缓存，才把字节缓存起来
    function captureImageFile(file) {
      if (!imageFallbackEnabled) return; // 降级关闭不捕获
      if (!file || typeof file.arrayBuffer !== "function") return;
      if (typeof file.type !== "string" || !file.type.toLowerCase().startsWith("image/")) return;
      const key = imageCacheKey(file);
      if (!key || imageCache.has(key)) return; // 同指纹去重
      file.arrayBuffer()
        .then((buf) => { if (imageCache.has(key)) return; imageCache.set(key, { name: file.name, b64: bytesToBase64(new Uint8Array(buf)), mime: file.type }); })
        .catch(() => {});
    }

    // DOM 附件捕获：change(文件选择)/drop(拖拽)/paste(粘贴) 三路，捕获阶段先于 DSH 处理器
    // 注：本函数在握手成功时由 hello 分支调用（绑定一次即常驻，内部用开关过滤）
    function bindImageCapture() {
      if (bindImageCapture.bound) return; bindImageCapture.bound = true;
      document.addEventListener("change", (e) => {
        const t = e.target;
        if (t && t.files) { for (const f of Array.from(t.files)) captureImageFile(f); }
      }, true);
      document.addEventListener("drop", (e) => {
        if (e.dataTransfer && e.dataTransfer.files) { for (const f of Array.from(e.dataTransfer.files)) captureImageFile(f); }
      }, true);
      document.addEventListener("paste", (e) => {
        if (e.clipboardData && e.clipboardData.items) {
          for (const it of Array.from(e.clipboardData.items)) {
            if (it.kind === "file") { const f = it.getAsFile(); if (f) captureImageFile(f); }
          }
        }
      }, true);
    }

    // 经桥接把一张图片落盘到扩展宿主侧（工作区根），成功返回绝对路径，失败/超时返回 null
    function saveImageViaBridge(b64, name, requestId) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 5000);
        function onAck(e) {
          const parsed = parseSaveImageAck(e.data, requestId);
          if (!parsed) return;
          clearTimeout(timer);
          window.removeEventListener("message", onAck);
          resolve(parsed.ok && parsed.path ? parsed.path : null);
        }
        window.addEventListener("message", onAck);
        parent.postMessage(buildSaveImageRequest(requestId, name, b64, undefined), "*");
      });
    }

    // 图片被拒后：落盘全部缓存 → 纯文本+路径指针重发 → 通知与清理登记
    async function handlePromptImageRejected(parsed, url, init, origFetch) {
      try {
        const entries = Array.from(imageCache.values());
        const pointerLines = [];
        const savedPaths = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const ext = "." + (entry.mime ? entry.mime.split("/")[1].toLowerCase() : "png");
          const name = imageCacheFilename(String(Date.now()), i, ext);
          if (!name) continue; // 扩展名不在白名单：跳过该张
          const p = await saveImageViaBridge(entry.b64, name, "img-" + Date.now() + "-" + i);
          if (p) { savedPaths.push(p); pointerLines.push(buildImagePointerLine(p)); }
        }
        if (savedPaths.length === 0) { console.warn("[dsh-vscode-bridge] image fallback: 没有可落盘的图片缓存（未打开工作区?），保持原生报错"); return; } // 无可用落盘：不作降级
        // 用新 rpcId 以纯文本重发：payload 保留原 sessionId/mode，仅替换 content，避免与已拒请求撞车/重复投递
        const payload = unwrapRpcPayload(parsed);
        const content = buildTextOnlyContent(payload.content, pointerLines);
        const resendBody = buildTextResendRequest(parsed, content);
        // 重发时剥离原请求的 signal：避免复用可能已中止/中止中的 AbortSignal 导致重发被中途取消
        const { signal: _signal, ...initNoSignal } = init || {};
        await origFetch(url, { ...initNoSignal, body: JSON.stringify(resendBody) });
        persistedForCleanup.push(...savedPaths);
        console.log("[dsh-vscode-bridge] image fallback: 已以纯文本+路径指针重发 via", savedPaths.length + " 张图片");
        parent.postMessage(buildImageFallbackNotice(savedPaths), "*");
      } catch (err) {
        // 降级全程失败：保留可观察的原生错误，绝不吞用户消息
        console.error("[dsh-vscode-bridge] image fallback failed:", err);
      } finally {
        fallbackResendInFlight = false;
      }
    }

    // 拦截 prompt RPC：发送含图内容被「模型不支持图像输入」拒绝时，自动降级重发
    function interceptPromptFetch() {
      const origFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const res = await origFetch(input, init);
        try {
          if (!imageFallbackEnabled || bridgeToken === "") return res;
          if (!init || init.method !== "POST" || typeof init.body !== "string" || init.body === "") return res;
          const parsed = JSON.parse(init.body);
          // DSH 线格式：请求体为 { rpcId, payload }，业务 content 在 payload 下（payload 透传形态也兼容）
          const payload = unwrapRpcPayload(parsed);
          if (!payload || !Array.isArray(payload.content) || !isPromptWithImages(payload.content)) return res;
          const clone = res.clone();
          let respJson = null;
          try { respJson = await clone.json(); } catch {}
          if (detectModelReject(respJson)) {
            console.log("[dsh-vscode-bridge] image fallback: 模型不支持图片，尝试自动降级重发");
            if (fallbackResendInFlight) { console.log("[dsh-vscode-bridge] image fallback: 已有进行中的降级，跳过本次"); return res; }
            // input 多为 URL 实例（.href）；resolveFetchUrl 兼容 string/URL/Request 三种
            const u = resolveFetchUrl(input);
            if (u === "") { console.warn("[dsh-vscode-bridge] image fallback: 无法解析请求 URL，跳过自动重发"); return res; }
            fallbackResendInFlight = true;
            void handlePromptImageRejected(parsed, u, init, origFetch);
          }
        } catch {}
        return res;
      };
    }

    // 页面卸载清理：删除本次已由本页落盘的缓存图片（避免长期占用工作区存储）
    function bindPageCleanup() {
      window.addEventListener("pagehide", () => {
        if (persistedForCleanup.length === 0) return;
        parent.postMessage(buildDeleteImagesRequest("cleanup-" + Date.now(), persistedForCleanup.slice()), "*");
        persistedForCleanup.length = 0;
      });
    }

    // —— 入口：立即可绑定的拦截先挂载；图片捕获在握手后才绑定 ——
    bindLinkInterception();
    bindImageCapture(); // 附件图片捕获常驻挂载（未握手/关闭时经 imageFallbackEnabled 过滤，零干扰）
    interceptPromptFetch(); // fetch 拦截常驻挂载（内部用开关过滤，未握手/关闭时零干扰）
    bindPageCleanup();
    window.addEventListener("message", onParentMessage);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    // 点击菜单外任意处／滚动／窗口失焦时收起自定义菜单
    document.addEventListener("pointerdown", (e) => {
      if (menuEl && !menuEl.contains(e.target)) hideMenu();
    }, true);
    window.addEventListener("blur", hideMenu);
    window.addEventListener("scroll", hideMenu, true);
    // cordis 插件约定：apply 挂载点（本桥接无需额外挂载，保留占位以符合插件契约）
    exports.apply = () => {};
    return module.exports;
  }
});