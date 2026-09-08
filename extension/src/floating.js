(() => {
  const hostId = "weborg-floating-host";
  const FLOATING_VERSION = "floating.js v0.3.0"; // 提交 9604828 之后
  if (document.getElementById(hostId)) return;

  const state = {
    config: null,
    mode: "minimized",
    query: "",
    searchIndex: 0,
    root: "",
    selected: "",
    expanded: {},
    status: "加载中",
    position: null,
    dragging: null,
    dragMoved: false,
    suppressClick: false,
    hoverMode: "manual",
    hoverSession: false,
    hoverOpenTimer: 0,
    hoverCloseTimer: 0,
    f12Hijack: false,
    debug: []
  };
  let searchCatalogSource = null;
  let searchCatalog = [];

  // ---- 调试日志 ----
  let debugConsoleVisible = false;
  let logSeq = 0;
  function logDebug(level, message, extra) {
    const entry = { t: Date.now(), n: ++logSeq, level, message: String(message), extra };
    state.debug.push(entry);
    if (state.debug.length > 200) state.debug.shift();
    try { console[level === "error" ? "error" : "log"](`[flowhub] ${message}`, extra ?? ""); } catch {}
    if (debugConsoleVisible) renderDebugConsole();
  }
  // 暴露给页面，便于从原生 DevTools 直接查询
  try {
    const g = window.__weborgDebug || (window.__weborgDebug = {});
    g.getState = () => JSON.parse(JSON.stringify({
      version: FLOATING_VERSION,
      mode: state.mode, root: state.root, selected: state.selected,
      expanded: Object.keys(state.expanded).filter((k) => state.expanded[k]),
      hoverMode: state.hoverMode, configLoaded: Boolean(state.config),
      configItems: state.config?.items?.length ?? 0, status: state.status
    }));
    g.getLog = () => state.debug.slice();
    g.toggle = () => toggleDebugConsole();
  } catch {}
  logDebug("info", `${FLOATING_VERSION} 已注入`, { href: location.href });

  const host = document.createElement("div");
  host.id = hostId;
  document.documentElement.dataset.weborgFloating = "ready";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const css = `
    :host {
      all: initial;
      position: fixed;
      right: 22px;
      bottom: 22px;
      z-index: 2147483647;
      color: #10202f;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
    }
    * { box-sizing: border-box; }
    button, input { font: inherit; }
    button { border: 0; }
    .bubble {
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      border-radius: 18px;
      color: #fff;
      background: #12a9d4;
      box-shadow: 0 18px 40px rgba(16, 32, 47, 0.22);
      cursor: pointer;
      font-weight: 800;
      user-select: none;
    }
    .panel {
      width: min(408px, calc(100vw - 34px));
      max-height: min(680px, calc(100vh - 34px));
      display: none;
      grid-template-rows: auto auto minmax(0, 1fr);
      overflow: hidden;
      border: 1px solid #dfe8eb;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.98);
      box-shadow: 0 22px 52px rgba(16, 32, 47, 0.22);
    }
    :host(.open) .bubble { display: none; }
    :host(.open) .panel { display: grid; }
    .head {
      min-height: 60px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid #e5eaee;
      background: #fbffff;
      cursor: grab;
      touch-action: none;
      user-select: none;
    }
    :host(.dragging) .head { cursor: grabbing; }
    .brand { min-width: 0; }
    .brand strong, .brand span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .brand strong { font-size: 15px; line-height: 1.2; }
    .brand span { margin-top: 3px; color: #66727f; font-size: 12px; }
    .close, .open-link {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      color: #66727f;
      background: #fff;
      cursor: pointer;
    }
    .close {
      width: 32px;
      height: 32px;
      border: 1px solid #e5eaee;
      border-radius: 10px;
    }
    .close:hover, .open-link:hover { color: #058bb5; background: #eef8fb; }
    .head-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
    .web-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 32px;
      padding: 0 10px;
      border: 1px solid #d7e8ee;
      border-radius: 10px;
      color: #058bb5;
      background: #f2fbfe;
      cursor: pointer;
      font-weight: 700;
      font-size: 12px;
      white-space: nowrap;
    }
    .web-btn:hover { color: #058bb5; background: #def3fa; border-color: #a9d6e6; }
    .search-wrap { padding: 12px 14px; border-bottom: 1px solid #e5eaee; }
    .preference-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
    }
    .preference-label {
      color: #66727f;
      font-size: 12px;
      font-weight: 700;
    }
    .preference-chips {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .pref-chip {
      min-height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      color: #66727f;
      background: #fff;
      cursor: pointer;
    }
    .pref-chip.active {
      color: #fff;
      background: #12a9d4;
    }
    .search {
      width: 100%;
      height: 40px;
      padding: 0 12px;
      border: 1px solid #dfe7eb;
      border-radius: 12px;
      color: #10202f;
      background: #fff;
      outline: 0;
    }
    .search:focus { border-color: rgba(18, 169, 212, 0.65); box-shadow: 0 0 0 3px rgba(18, 169, 212, 0.12); }
    .body { min-height: 0; overflow: auto; padding: 12px 14px 14px; background: #f7fbfb; }
    .roots { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 11px; }
    .root-control { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
    .root {
      height: 34px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      flex: 0 0 auto;
      padding: 0 11px;
      border-radius: 11px;
      color: #66727f;
      background: #fff;
      cursor: pointer;
    }
    .root.active { color: #fff; background: #12a9d4; }
    .root-open {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border-radius: 9px;
      color: #66727f;
      background: #fff;
      cursor: pointer;
      font-size: 16px;
    }
    .root-open:hover { color: #058bb5; background: #eef8fb; }
    .section-label { margin: 2px 0 8px; color: #66727f; font-size: 12px; font-weight: 700; }
    .tree, .results { display: grid; gap: 4px; }
    .tree-group { display: grid; gap: 4px; }
    .tree-row {
      min-width: 0;
      display: grid;
      grid-template-columns: 26px minmax(0, 1fr) 30px;
      align-items: center;
      min-height: 40px;
      gap: 4px;
      padding: 3px 4px;
      border: 1px solid transparent;
      border-radius: 10px;
    }
    .tree-row:hover, .tree-row.selected { border-color: #d8edf3; background: #edf9fc; }
    .toggle, .node-select {
      min-width: 0;
      color: #10202f;
      background: transparent;
      text-align: left;
      cursor: pointer;
    }
    .toggle { width: 26px; height: 26px; display: grid; place-items: center; color: #7a8792; }
    .toggle-spacer { width: 26px; height: 26px; display: block; }
    .chevron { width: 8px; height: 8px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform 140ms ease; }
    .chevron.open { transform: rotate(45deg); }
    .node-select { padding: 3px 0; display: flex; align-items: flex-start; gap: 6px; min-width: 0; }
    .node-inner { min-width: 0; }
    .node-title, .node-meta { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .node-title { font-weight: 700; }
    .node-meta { margin-top: 1px; color: #7a8792; font-size: 11px; }
    .node-meta.note { color: #058bb5; }
    .icon { flex: 0 0 auto; display: inline-grid; place-items: center; }
    .icon.in-root { line-height: 0; }
    .icon.in-select { width: 22px; height: 22px; margin-top: 2px; border-radius: 6px; overflow: hidden; font-size: 15px; }
    .icon-img { width: 22px; height: 22px; object-fit: contain; border-radius: 5px; display: block; background: #fff; }
    .in-root .icon-img { width: 18px; height: 18px; }
    .node-icon-char { line-height: 1; }
    .directory .node-title::before { content: "目录 · "; color: #7a8792; font-weight: 500; }
    .page .node-title::before { content: "网页 · "; color: #058bb5; font-weight: 500; }
    .open-link { width: 28px; height: 28px; border-radius: 8px; font-size: 17px; line-height: 1; }
    .branch { display: grid; gap: 4px; margin-left: 12px; padding-left: 10px; border-left: 1px solid #dce7ea; }
    .result {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 30px;
      align-items: center;
      gap: 8px;
      padding: 7px 8px;
      border: 1px solid transparent;
      border-radius: 10px;
      background: #fff;
    }
    .result.active, .result:hover { border-color: #d8edf3; background: #eef8fb; }
    .result-select { min-width: 0; color: #10202f; background: transparent; text-align: left; cursor: pointer; display: flex; align-items: flex-start; gap: 8px; }
    .result-inner { min-width: 0; }
    .result-kind { color: #058bb5; font-size: 11px; font-weight: 700; }
    .result-title, .result-path, .result-url, .result-note { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .result-title { margin-top: 2px; font-weight: 700; }
    .result-path, .result-url, .result-note { margin-top: 2px; color: #66727f; font-size: 11px; }
    .result-url, .result-note { color: #058bb5; }
    .empty { padding: 16px; border: 1px dashed #d7dee4; border-radius: 12px; color: #66727f; background: #fff; }
    .debug-console {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 2147483646;
      margin: 12px;
      padding: 12px 14px;
      border: 1px solid #333;
      border-radius: 12px;
      background: rgba(18, 22, 28, 0.97);
      color: #d7e2ea;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      max-height: 46vh;
      overflow: auto;
      box-shadow: 0 -10px 40px rgba(0,0,0,0.4);
    }
    .debug-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; color: #fff; font-weight: 700; }
    .debug-hint { color: #8fa3b3; font-weight: 400; font-size: 11px; }
    .debug-head-actions { display: flex; align-items: center; gap: 8px; }
    .debug-f12-toggle {
      padding: 4px 10px;
      border: 1px solid #3a4a58;
      border-radius: 999px;
      background: #1f2933;
      color: #8fa3b3;
      cursor: pointer;
      font-weight: 600;
      font-size: 11px;
    }
    .debug-f12-toggle.on { color: #0e0e0e; background: #3ddc84; border-color: #3ddc84; }
    .debug-f12-toggle:hover { border-color: #7fd0ff; }
    .debug-stats { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 8px; margin-bottom: 8px; border-radius: 8px; background: rgba(255,255,255,0.05); font-weight: 400; }
    .debug-stats b.ok { color: #3ddc84; }
    .debug-stats b.bad { color: #ff5a5a; }
    .debug-stats .cycle-warn { color: #ffc24b; width: 100%; }
    .debug-log { display: grid; gap: 2px; min-height: 40px; max-height: 24vh; overflow: auto; }
    .dbg-row { display: flex; gap: 8px; padding: 2px 4px; border-radius: 4px; white-space: pre-wrap; word-break: break-all; }
    .dbg-row:nth-child(odd) { background: rgba(255,255,255,0.03); }
    .dbg-time { color: #8fa3b3; flex: 0 0 auto; }
    .dbg-row code { color: #7fd0ff; }
    .dbg-error { color: #ffb3b3; }
  `;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

  function normalizeUrl(url) {
    const value = String(url || "").trim();
    if (/^https?:\/\//i.test(value)) return value;
    if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(value)) return `https://${value}`;
    return "";
  }

  function pathText(path) {
    return (path || []).map((item) => item.title).join(" / ");
  }

  function noteText(node) {
    return String(node?.note || "").trim();
  }

  // 图标 HTML：icon 值若是 http(s) 链接则渲染为图片，否则作为 emoji/字符渲染。
  function iconHtml(obj, fallback = "□", extraClass = "") {
    const raw = String(obj?.icon || "").trim();
    const cls = extraClass ? `icon ${extraClass}` : "icon";
    if (/^https?:\/\//i.test(raw)) {
      return `<span class="${cls}"><img class="icon-img" src="${escapeHtml(raw)}" alt="${escapeHtml(obj?.title || obj?.id || "icon")}" loading="lazy" /></span>`;
    }
    return `<span class="${cls} node-icon-char">${escapeHtml(raw || fallback)}</span>`;
  }

  function rootItems() {
    return state.config?.items || [];
  }

  function activeRoot() {
    return rootItems().find((item) => item.id === state.root) || rootItems()[0] || null;
  }

  function collectNodes(nodes, path = []) {
    const result = [];
    const visited = new WeakSet();
    const walk = (list, currentPath) => {
      for (const node of list || []) {
        if (!node || typeof node !== "object" || visited.has(node)) continue;
        visited.add(node);
        const nextPath = [...currentPath, { id: node.id, title: node.title }];
        result.push({ ...node, path: nextPath });
        if (node.children && node.children.length) walk(node.children, nextPath);
      }
    };
    walk(nodes, path);
    return result;
  }

  // 如果配置里出现循环引用，递归会无限深入。用一次性对象标记避免重复进入同一节点，
  // 并设定最大深度兜底，保证永远不会栈溢出。
  function findNode(id, nodes = rootItems(), ancestors = []) {
    const maxDepth = 256;
    const stack = [{ nodes, ancestors, depth: 0 }];
    const visited = new WeakSet();

    while (stack.length) {
      const { nodes: current, ancestors: currentAncestors, depth } = stack.pop();
      for (const node of current || []) {
        if (depth >= maxDepth || !node || typeof node !== "object") continue;
        if (!visited.has(node)) {
          visited.add(node);
        } else {
          // 出现环：跳过该节点，避免重复展开后再陷入自身子树。
          continue;
        }
        const nextAncestors = [...currentAncestors, node];
        if (node.id === id) return { node, ancestors: nextAncestors };
        if (node.children && node.children.length) {
          stack.push({ nodes: node.children, ancestors: nextAncestors, depth: depth + 1 });
        }
      }
    }
    return null;
  }

  function searchMatches() {
    const keyword = state.query.trim().toLowerCase();
    if (!keyword) return [];
    if (searchCatalogSource !== state.config) {
      searchCatalogSource = state.config;
      searchCatalog = collectNodes(rootItems()).map((node) => ({
        ...node,
        searchText: `${node.title || ""} ${node.url || ""} ${pathText(node.path)} ${noteText(node)}`.toLowerCase()
      }));
    }
    return searchCatalog
      .filter((node) => node.searchText.includes(keyword))
      .slice(0, 12);
  }

  function selectNode(id) {
    const found = findNode(id);
    if (!found) return;
    state.selected = id;
    state.root = found.ancestors[0]?.id || state.root;
    found.ancestors.forEach((node) => { state.expanded[node.id] = true; });
    state.query = "";
    state.searchIndex = 0;
    persistNav();
    render();
  }

  function clearHoverTimers() {
    clearTimeout(state.hoverOpenTimer);
    clearTimeout(state.hoverCloseTimer);
    state.hoverOpenTimer = 0;
    state.hoverCloseTimer = 0;
  }

  function setMode(mode, options = {}) {
    const nextMode = mode === "open" ? "open" : "minimized";
    state.mode = nextMode;
    state.hoverSession = nextMode === "open" ? Boolean(options.hover) : false;
    clearHoverTimers();
    chrome.runtime.sendMessage({ type: "weborg:set-floating-state", mode: nextMode }).catch(() => {});
    persistFloatingUI();
    render();
  }

  function scheduleHoverOpen() {
    if (state.hoverMode !== "hover" || state.mode === "open") return;
    clearTimeout(state.hoverCloseTimer);
    if (state.hoverOpenTimer) return;
    state.hoverOpenTimer = setTimeout(() => {
      state.hoverOpenTimer = 0;
      setMode("open", { hover: true });
    }, 140);
  }

  function scheduleHoverClose() {
    if (!state.hoverSession || state.mode !== "open") return;
    clearTimeout(state.hoverOpenTimer);
    clearTimeout(state.hoverCloseTimer);
    state.hoverCloseTimer = setTimeout(() => {
      state.hoverCloseTimer = 0;
      setMode("minimized");
    }, 180);
  }

  async function loadPreferences() {
    const result = await chrome.storage.local.get({ "weborg.floating-hover-mode": "manual", "weborg.f12-hijack": false });
    state.hoverMode = result["weborg.floating-hover-mode"] === "hover" ? "hover" : "manual";
    state.f12Hijack = result["weborg.f12-hijack"] === true;
  }

  function saveF12Hijack(value) {
    state.f12Hijack = value === true;
    chrome.storage.local.set({ "weborg.f12-hijack": state.f12Hijack }).catch(() => {});
    if (state.f12Hijack) logDebug("info", "已开启 F12 劫持（F12 打开插件调试面板）");
    else { debugConsoleVisible = false; logDebug("info", "已关闭 F12 劫持（F12 恢复为浏览器原生 DevTools）"); }
    render();
  }

  function saveHoverMode(mode) {
    state.hoverMode = mode === "hover" ? "hover" : "manual";
    chrome.storage.local.set({ "weborg.floating-hover-mode": state.hoverMode }).catch(() => {});
    if (state.hoverMode !== "hover" && state.hoverSession) {
      setMode("minimized");
      return;
    }
    render();
  }

  function applyPosition(position) {
    if (!position) return;
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.left = `${position.left}px`;
    host.style.top = `${position.top}px`;
  }

  function boundedPosition(left, top) {
    const rect = host.getBoundingClientRect();
    return {
      left: Math.round(Math.max(8, Math.min(left, window.innerWidth - rect.width - 8))),
      top: Math.round(Math.max(8, Math.min(top, window.innerHeight - rect.height - 8)))
    };
  }

  async function loadPosition() {
    const result = await chrome.storage.local.get({ "weborg.floating-position": null });
    const position = result["weborg.floating-position"];
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
    state.position = boundedPosition(position.left, position.top);
    applyPosition(state.position);
  }

  async function openPage(url, nodeId) {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      state.status = "此节点没有可打开的 HTTP 网页";
      render();
      return;
    }
    let destination = normalized;
    try {
      const response = await chrome.runtime.sendMessage({ type: "weborg:get-last-location", nodeId });
      if (response?.location && httpOrigin(response.location.url) === httpOrigin(normalized)) destination = response.location.url;
      await chrome.runtime.sendMessage({
        type: "weborg:activate-page",
        nodeId,
        url: destination,
        fallbackUrl: normalized
      });
    } catch {
      // Navigation still works when browser storage is temporarily unavailable.
    }

    // 先保存当前滚动，作为"全局组件状态"，供目标页还原。
    rememberScrollNow();

    // 同 URL（含 hash/query 差异抵消后基础相同）时，避免整页 reload 丢位置。
    // 用 history.replaceState 更新地址但不刷新页面，保持当前滚动不被扰动。
    try {
      if (destination.split("#")[0] === location.href.split("#")[0] && httpOrigin(destination) === httpOrigin(location.href)) {
        if (location.href !== destination) {
          history.replaceState(null, "", destination);
        }
        state.status = "已在当前页面";
        render();
        return;
      }
    } catch {
      // 历史 API 不可用时退化为正常跳转。
    }
    logDebug("info", "跳转到页面", { url: destination, from: location.href });
    window.location.href = destination;
  }

  const WEB_CONSOLE_URL = "http://localhost:4173/";
  async function openWebConsole() {
    const online = await probeLocalServer();
    if (!online) {
      state.status = "Web 管理台未启动：请双击项目的 start.command 一键启动";
      logDebug("error", "打开 Web 管理台失败：服务未在运行", { url: WEB_CONSOLE_URL });
      render();
      return;
    }
    logDebug("info", "打开 Web 管理台", { url: WEB_CONSOLE_URL });
    window.open(WEB_CONSOLE_URL, "_blank", "noopener");
  }
  async function probeLocalServer() {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2500);
      const res = await fetch("http://localhost:4173/api/config", { cache: "no-store", signal: controller.signal }).catch(() => null);
      clearTimeout(t);
      return Boolean(res && res.ok);
    } catch {
      return false;
    }
  }

  function httpOrigin(url) {
    try {
      const parsed = new URL(url);
      return /^https?:$/.test(parsed.protocol) ? parsed.origin : "";
    } catch {
      return "";
    }
  }

  function renderTree(nodes) {
    return (nodes || []).map((node) => {
      const hasChildren = Boolean(node.children?.length);
      const expanded = Boolean(state.expanded[node.id]);
      const selected = node.id === state.selected;
      const baseMeta = node.url ? normalizeUrl(node.url) || node.url : hasChildren ? `${node.children.length} 个下级节点` : "目录节点";
      const note = noteText(node);
      const selectTitle = note
        ? `${escapeHtml(node.title || node.id)}\n${escapeHtml(note)}`
        : `选择 ${escapeHtml(node.title || node.id)}`;
      return `
        <div class="tree-group">
          <div class="tree-row ${node.url ? "page" : "directory"} ${selected ? "selected" : ""}">
            ${hasChildren
              ? `<button class="toggle" data-toggle="${escapeHtml(node.id)}" title="${expanded ? "收起下级" : "展开下级"}"><span class="chevron ${expanded ? "open" : ""}"></span></button>`
              : `<span class="toggle-spacer" aria-hidden="true"></span>`}
            <button class="node-select" data-select="${escapeHtml(node.id)}" title="${selectTitle}">
              ${iconHtml(node, "□", "in-select")}
              <span class="node-inner">
                <span class="node-title">${escapeHtml(node.title || node.id)}</span>
                <span class="node-meta">${escapeHtml(baseMeta)}</span>
                ${note ? `<span class="node-meta note">${escapeHtml(note)}</span>` : ""}
              </span>
            </button>
            ${node.url ? `<button class="open-link" data-open="${escapeHtml(node.url)}" data-node-id="${escapeHtml(node.id)}" title="打开 ${escapeHtml(node.title || node.id)}">↗</button>` : "<span></span>"}
          </div>
          ${hasChildren && expanded ? `<div class="branch">${renderTree(node.children)}</div>` : ""}
        </div>
      `;
    }).join("");
  }

  function renderResults() {
    const results = searchMatches();
    if (!results.length) return `<div class="empty">没有匹配的目录或网页</div>`;
    return `<div class="results">${results.map((node, index) => `
      <div class="result ${index === state.searchIndex ? "active" : ""}">
        <button class="result-select" data-select="${escapeHtml(node.id)}" title="${noteText(node) ? `${escapeHtml(node.title || node.id)}\n${escapeHtml(noteText(node))}` : escapeHtml(node.title || node.id)}">
          ${iconHtml(node, "□", "in-select")}
          <span class="result-inner">
            <span class="result-kind">${node.url ? "网页" : "目录"}</span>
            <span class="result-title">${escapeHtml(node.title || node.id)}</span>
            <span class="result-path">${escapeHtml(pathText(node.path))}</span>
            ${noteText(node) ? `<span class="result-note">${escapeHtml(noteText(node))}</span>` : ""}
            ${node.url ? `<span class="result-url">${escapeHtml(normalizeUrl(node.url) || node.url)}</span>` : ""}
          </span>
        </button>
        ${node.url ? `<button class="open-link" data-open="${escapeHtml(node.url)}" data-node-id="${escapeHtml(node.id)}" title="打开网页">↗</button>` : "<span></span>"}
      </div>
    `).join("")}</div>`;
  }

  function updateNavigationView() {
    const label = shadow.querySelector(".section-label");
    const content = shadow.querySelector(".navigation-content");
    if (!label || !content) return render();
    const isSearching = Boolean(state.query.trim());
    const root = activeRoot();
    label.textContent = isSearching ? "查询结果" : `${root?.title || "分类"}的目录结构`;
    content.innerHTML = isSearching
      ? renderResults()
      : `<div class="tree">${root ? renderTree(root.children || []) : `<div class="empty">暂无分类</div>`}</div>`;
  }

  function render() {
    host.classList.toggle("open", state.mode === "open");
    // 记住面板正文(.body)当前的滚动位置，避免全量重绘后"跳到顶部"。
    const prevBody = shadow.querySelector(".body");
    const prevScrollTop = prevBody ? prevBody.scrollTop : 0;
    const roots = rootItems();
    if (!state.root && roots[0]) state.root = roots[0].id;
    const root = activeRoot();
    const isSearching = Boolean(state.query.trim());
    shadow.innerHTML = `
      <style>${css}</style>
      <button class="bubble" data-action="open" title="${state.hoverMode === "hover" ? "悬停或点击展开导航" : "点击展开导航"}">W</button>
      <section class="panel">
        <header class="head">
          <div class="brand">
          <strong>${escapeHtml(state.config?.app?.title || "FlowHub")}</strong>
            <span>${escapeHtml(state.status || "悬浮导航 · 当前页打开")} · 最小化后${state.hoverMode === "hover" ? "悬停展开" : "点击展开"}</span>
          </div>
          <div class="head-actions">
            <button class="web-btn" data-action="open-web" title="打开 Web 管理台">⚙ Web</button>
            <button class="web-btn" data-action="open-debug" title="打开调试控制台（也可在设置里开启 F12 劫持）">🐞</button>
            <button class="close" data-action="minimize" title="最小化">-</button>
          </div>
        </header>
        <div class="search-wrap">
          <input class="search" value="${escapeHtml(state.query)}" placeholder="查询目录、页面或网址" autocomplete="off" aria-label="查询目录、页面或网址" />
          <div class="preference-row">
            <span class="preference-label">最小化后</span>
            <div class="preference-chips" role="group" aria-label="最小化后展开方式">
              <button class="pref-chip ${state.hoverMode === "manual" ? "active" : ""}" data-hover-mode="manual">点击展开</button>
              <button class="pref-chip ${state.hoverMode === "hover" ? "active" : ""}" data-hover-mode="hover">悬停展开</button>
            </div>
          </div>
        </div>
        <div class="body">
          <div class="roots">
            ${roots.map((item) => `
              <div class="root-control">
                <button class="root ${item.id === state.root ? "active" : ""}" data-root="${escapeHtml(item.id)}">${iconHtml(item, "□", "in-root")}<strong>${escapeHtml(item.title || item.id)}</strong></button>
                ${item.url ? `<button class="root-open" data-open="${escapeHtml(item.url)}" data-node-id="${escapeHtml(item.id)}" title="打开 ${escapeHtml(item.title || item.id)}">↗</button>` : ""}
              </div>
            `).join("")}
          </div>
          <div class="section-label">${isSearching ? "查询结果" : `${escapeHtml(root?.title || "分类")}的目录结构`}</div>
          <div class="navigation-content">${isSearching ? renderResults() : `<div class="tree">${root ? renderTree(root.children || []) : `<div class="empty">暂无分类</div>`}</div>`}</div>
        </div>
      </section>
      ${debugConsoleVisible ? renderDebugConsole() : ""}
    `;
    const input = shadow.querySelector(".search");
    if (input && state.mode === "open") input.selectionStart = input.selectionEnd = input.value.length;
    // 恢复面板正文的滚动位置（若内容条数变化导致超界则钳制到最大）。
    const newBody = shadow.querySelector(".body");
    if (newBody && prevScrollTop > 0) {
      requestAnimationFrame(() => {
        const max = newBody.scrollHeight - newBody.clientHeight;
        newBody.scrollTop = Math.min(prevScrollTop, Math.max(0, max));
      });
    }
  }

  function renderDebugConsole() {
    const cfgOk = Boolean(state.config);
    const chromeOk = Boolean(globalThis.chrome?.runtime?.sendMessage);
    const tree = collectNodes(rootItems());
    let cycleWarn = "";
    for (const node of tree) {
      if (node.children && node.children.length && node.children.some((c) => c && tree.some((t) => t.id === c.id && t !== c))) {
        cycleWarn = "（已在 findNode/collectNodes 中应用环检测）";
        break;
      }
    }
    const rows = state.debug.slice(-60).reverse().map((e) => `
      <div class="dbg-row dbg-${e.level}" data-seq="${e.n}">
        <span class="dbg-time">${new Date(e.t).toTimeString().slice(0,8)}</span>
        <span>${escapeHtml(e.message)}</span>
        ${e.extra ? `<code>${escapeHtml(JSON.stringify(e.extra))}</code>` : ""}
      </div>
    `).join("");
    return `
      <aside class="debug-console">
        <div class="debug-head">
          <strong>FlowHub · 调试控制台</strong>
          <div class="debug-head-actions">
            <button class="debug-f12-toggle ${state.f12Hijack ? "on" : ""}" data-f12-toggle title="开启后按 F12 打开本调试面板；关闭后 F12 恢复为浏览器原生 DevTools">
              F12 劫持：${state.f12Hijack ? "开" : "关"}
            </button>
            <span class="debug-hint">${state.f12Hijack ? "按 F12 关闭" : "点下方 F12 开关开启劫持"}</span>
          </div>
        </div>
        <div class="debug-stats">
          <span>注入状态：<b class="ok">已注入</b></span>
          <span>chrome.runtime：<b class="${chromeOk ? "ok" : "bad"}">${chromeOk ? "可用" : "不可用"}</b></span>
          <span>配置：<b class="${cfgOk ? "ok" : "bad"}">${cfgOk ? `已加载（${state.config?.items?.length ?? 0} 个根分类）` : "未加载"}</b></span>
          <span>模式：<b>${state.mode}</b> / 悬停：<b>${state.hoverMode}</b></span>
          <span>状态：<b>${escapeHtml(state.status)}</b></span>
          ${cycleWarn ? `<span class="cycle-warn">${cycleWarn}</span>` : ""}
        </div>
        <div class="debug-log">${rows || `<div class="dbg-row">（暂无日志）</div>`}</div>
      </aside>
    `;
  }

  function toggleDebugConsole() {
    debugConsoleVisible = !debugConsoleVisible;
    logDebug("info", "调试控制台 " + (debugConsoleVisible ? "打开" : "关闭"));
    render();
  }

  document.addEventListener("keydown", (event) => {
    // 只有开启 F12 劫持开关时才拦截 F12 打开插件调试面板；
    // 默认关，F12 保持浏览器原生 DevTools。
    if (event.key === "F12" && state.f12Hijack) {
      event.preventDefault();
      toggleDebugConsole();
    }
  });

  shadow.addEventListener("click", (event) => {
    if (state.suppressClick) {
      state.suppressClick = false;
      return;
    }
    const target = event.target.closest("button");
    if (!target) return;
    logDebug("info", "点击事件已到达 shadow-root 监听器", { targetId: target.id, action: target.dataset.action || target.dataset.select || target.dataset.open || target.dataset.root || null });
    if (target.dataset.action === "open") {
      setMode("open");
      shadow.querySelector(".search")?.focus();
      return;
    }
    if (target.dataset.action === "minimize") {
      setMode("minimized");
      return;
    }
    if (target.dataset.action === "open-web") {
      openWebConsole().catch(() => {});
      return;
    }
    if (target.dataset.action === "open-debug") {
      debugConsoleVisible = !debugConsoleVisible;
      logDebug("info", "调试控制台 " + (debugConsoleVisible ? "打开" : "关闭"));
      render();
      return;
    }
    if (target.dataset.f12Toggle !== undefined) {
      saveF12Hijack(!state.f12Hijack);
      return;
    }
    if (target.dataset.hoverMode) {
      saveHoverMode(target.dataset.hoverMode);
      return;
    }
    if (target.dataset.root) {
      state.root = target.dataset.root;
      state.query = "";
      state.searchIndex = 0;
      persistNav();
      render();
      return;
    }
    if (target.dataset.toggle) {
      state.expanded[target.dataset.toggle] = !state.expanded[target.dataset.toggle];
      persistNav();
      render();
      return;
    }
    if (target.dataset.select) {
      selectNode(target.dataset.select);
      return;
    }
    if (target.dataset.open !== undefined) openPage(target.dataset.open, target.dataset.nodeId).catch(() => {});
  });

  host.addEventListener("pointerenter", () => {
    clearTimeout(state.hoverCloseTimer);
    state.hoverCloseTimer = 0;
    if (state.hoverMode === "hover" && state.mode === "minimized") scheduleHoverOpen();
  });

  host.addEventListener("pointerleave", () => {
    clearTimeout(state.hoverOpenTimer);
    state.hoverOpenTimer = 0;
    scheduleHoverClose();
  });

  shadow.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    const nearBubble = target.closest?.(".bubble");
    const nearHead = target.closest?.(".head");
    const nearButton = target.closest?.("button");
    // 可拖区域：整个 W 泡泡(.bubble)；或面板头部(.head) 的空白区域（不在头部内按钮上）。
    const onBubble = Boolean(nearBubble);
    const onHeadEmpty = Boolean(nearHead) && !Boolean(nearButton);
    if (!(onBubble || onHeadEmpty)) return;

    const rect = host.getBoundingClientRect();
    state.dragging = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY };
    state.dragMoved = false;
    state.position = { left: rect.left, top: rect.top };
    applyPosition(state.position);
    host.classList.add("dragging");
    event.preventDefault();
  });

  window.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    const dx = event.clientX - state.dragging.startX;
    const dy = event.clientY - state.dragging.startY;
    if (!state.dragMoved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    state.dragMoved = true;
    state.position = boundedPosition(event.clientX - state.dragging.offsetX, event.clientY - state.dragging.offsetY);
    applyPosition(state.position);
  });

  window.addEventListener("pointerup", () => {
    if (!state.dragging) return;
    const didDrag = state.dragMoved;
    state.dragging = null;
    state.dragMoved = false;
    host.classList.remove("dragging");
    if (didDrag) state.suppressClick = true;
    chrome.storage.local.set({ "weborg.floating-position": state.position }).catch(() => {});
    persistFloatingUI();
  });

  shadow.addEventListener("input", (event) => {
    if (!event.target.classList.contains("search")) return;
    state.query = event.target.value;
    state.searchIndex = 0;
    updateNavigationView();
  });

  shadow.addEventListener("keydown", (event) => {
    if (!event.target.classList.contains("search") || !state.query.trim()) return;
    const results = searchMatches();
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      state.searchIndex = Math.min(state.searchIndex + 1, results.length - 1);
      updateNavigationView();
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      state.searchIndex = Math.max(state.searchIndex - 1, 0);
      updateNavigationView();
      event.preventDefault();
    } else if (event.key === "Enter") {
      selectNode(results[state.searchIndex].id);
      event.preventDefault();
    }
  });

  // 全局、与 URL 无关的滚动记忆：把悬浮窗视为一个独立组件，
  // 无论页面跳到哪个 URL / 是否刷新，都尽量停在"上一次的位置"。
  const GLOBAL_SCROLL_KEY = "weborg.global-scroll";
  let lastRememberedScroll = null;

  // ---- 全局、与 URL 无关的目录浏览状态（展开层级 + 选中节点）----
  // 悬浮窗视为独立组件：无论在哪个页面、跳到哪个 URL，都还原到上次展开/选中的层级。
  const GLOBAL_NAV_KEY = "weborg.global-nav";

  // ---- 全局、与 URL 无关的悬浮窗自身 UI 状态（开关 + 位置）----
  const GLOBAL_FLOATING_KEY = "weborg.global-floating";
  const CONFIG_CACHE_KEY = "weborg.config-cache";
  function persistFloatingUI() {
    const payload = { mode: state.mode, position: state.position || null, ts: Date.now() };
    try {
      if (globalThis.chrome?.storage?.local) {
        chrome.storage.local.set({ [GLOBAL_FLOATING_KEY]: payload }).catch(() => {});
      }
    } catch {}
  }
  async function restoreFloatingUI() {
    let saved;
    try {
      const r = await chrome.storage.local.get({ [GLOBAL_FLOATING_KEY]: null });
      saved = r[GLOBAL_FLOATING_KEY];
    } catch {}
    if (!saved || typeof saved !== "object") return;
    if (saved.mode === "open" || saved.mode === "minimized") {
      state.mode = saved.mode;
    }
    if (saved.position && Number.isFinite(saved.position.left) && Number.isFinite(saved.position.top)) {
      state.position = { left: saved.position.left, top: saved.position.top };
      applyPosition(state.position);
    }
    logDebug("info", "已还原悬浮窗状态", { mode: state.mode, position: state.position });
    render();
  }

  // ---- 跨页面实时同步：任一页面的悬浮窗状态或配置变化，其他已打开页面不刷新即同步 ----
  function setupStorageSync() {
    if (!globalThis.chrome?.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      try {
        const navChange = changes[GLOBAL_NAV_KEY];
        if (navChange) {
          const saved = navChange.newValue;
          if (saved && typeof saved === "object") {
            const items = rootItems();
            const validIds = new Set(collectNodes(items).map((n) => n.id));
            if (typeof saved.root === "string" && validIds.has(saved.root)) state.root = saved.root;
            if (typeof saved.selected === "string" && validIds.has(saved.selected)) state.selected = saved.selected;
            const expandedObj = state.expanded || (state.expanded = {});
            if (Array.isArray(saved.expanded)) {
              for (const k of Object.keys(expandedObj)) if (!saved.expanded.includes(k)) delete expandedObj[k];
              for (const k of saved.expanded) if (validIds.has(k)) expandedObj[k] = true;
            }
            state.query = "";
            state.searchIndex = 0;
            logDebug("info", "收到其他页面的目录状态同步", { root: state.root, selected: state.selected });
            render();
          }
        }
        const floatChange = changes[GLOBAL_FLOATING_KEY];
        if (floatChange) {
          const saved = floatChange.newValue;
          if (saved && typeof saved === "object") {
            if (saved.mode === "open" || saved.mode === "minimized") {
              state.mode = saved.mode;
              state.hoverSession = false;
            }
            if (saved.position && Number.isFinite(saved.position.left) && Number.isFinite(saved.position.top)) {
              state.position = { left: saved.position.left, top: saved.position.top };
              applyPosition(state.position);
            }
            logDebug("info", "收到其他页面的悬浮窗状态同步", { mode: state.mode });
            render();
          }
        }
        const configChange = changes[CONFIG_CACHE_KEY];
        if (configChange && configChange.newValue?.config) {
          try {
            const incoming = FlowHubLegacyCatalog.validate(configChange.newValue.config);
            if (!state.config || JSON.stringify(state.config) !== JSON.stringify(incoming)) {
              state.config = incoming;
              state.status = "悬浮导航 · 当前页打开";
              logDebug("info", "已实时同步最新配置", { items: state.config.items?.length ?? 0 });
              render();
              restoreNav();
              restoreFloatingUI();
            }
          } catch (error) {
            state.status = error.message;
            logDebug("error", "配置同步失败，保留当前目录", { reason: error.message });
            render();
          }
        }
      } catch (error) {
        logDebug("error", "storage 同步处理出错", { reason: String(error) });
      }
    });
    logDebug("info", "已启用跨页面实时同步（storage.onChanged）");
  }

  function navSnapshot() {
    return {
      root: state.root || "",
      selected: state.selected || "",
      expanded: Object.keys(state.expanded).filter((k) => state.expanded[k]),
      ts: Date.now()
    };
  }
  function persistNav() {
    let payload;
    try { payload = navSnapshot(); } catch { return; }
    try {
      if (globalThis.chrome?.storage?.local) {
        chrome.storage.local.set({ [GLOBAL_NAV_KEY]: payload }).catch(() => {
          try { localStorage.setItem(GLOBAL_NAV_KEY, JSON.stringify(payload)); } catch {}
        });
      } else {
        localStorage.setItem(GLOBAL_NAV_KEY, JSON.stringify(payload));
      }
    } catch {
      try { localStorage.setItem(GLOBAL_NAV_KEY, JSON.stringify(payload)); } catch {}
    }
  }
  async function restoreNav() {
    let saved;
    try {
      if (globalThis.chrome?.storage?.local) {
        const r = await chrome.storage.local.get({ [GLOBAL_NAV_KEY]: null });
        saved = r[GLOBAL_NAV_KEY];
      }
      if (!saved) { const s = localStorage.getItem(GLOBAL_NAV_KEY); if (s) { try { saved = JSON.parse(s); } catch {} } }
    } catch {
      try { const s = localStorage.getItem(GLOBAL_NAV_KEY); if (s) saved = JSON.parse(s); } catch {}
    }
    if (!saved || typeof saved !== "object") return;
    const items = rootItems();
    const validIds = new Set(collectNodes(items).map((n) => n.id));
    // 校验保存的节点仍存在于当前配置，避免还原出已经不存在的节点。
    let changed = false;
    if (typeof saved.root === "string" && validIds.has(saved.root)) { if (state.root !== saved.root) changed = true; state.root = saved.root; }
    if (typeof saved.selected === "string" && validIds.has(saved.selected)) { state.selected = saved.selected; }
    const expandedObj = state.expanded || (state.expanded = {});
    for (const key of Array.isArray(saved.expanded) ? saved.expanded : []) {
      if (!expandedObj[key] && validIds.has(key)) { expandedObj[key] = true; changed = true; }
    }
    state.query = "";
    state.searchIndex = 0;
    if (changed || state.selected) logDebug("info", "已还原目录浏览状态", { fromStorage: saved, root: state.root, selected: state.selected, expanded: Object.keys(expandedObj).length });
    render();
  }

  function rememberScrollNow() {
    const y = Math.max(0, Math.round(window.scrollY || 0));
    const payload = { scrollY: y, href: location.href, ts: Date.now() };
    try {
      if (globalThis.chrome?.storage?.local) {
        chrome.storage.local.set({ [GLOBAL_SCROLL_KEY]: payload }).catch(() => {
          try { localStorage.setItem(GLOBAL_SCROLL_KEY, JSON.stringify(payload)); } catch {}
        });
      } else {
        localStorage.setItem(GLOBAL_SCROLL_KEY, JSON.stringify(payload));
      }
    } catch {
      try { localStorage.setItem(GLOBAL_SCROLL_KEY, JSON.stringify(payload)); } catch {}
    }
  }
  function rememberLocation() {
    const y = Math.max(0, Math.round(window.scrollY || 0));
    if (y === lastRememberedScroll) return;
    lastRememberedScroll = y;
    rememberScrollNow();
  }

  async function restoreLocation() {
    let saved;
    try {
      if (globalThis.chrome?.storage?.local) {
        const r = await chrome.storage.local.get({ [GLOBAL_SCROLL_KEY]: null });
        saved = r[GLOBAL_SCROLL_KEY];
      }
      if (!saved) {
        const s = localStorage.getItem(GLOBAL_SCROLL_KEY);
        if (s) { try { saved = JSON.parse(s); } catch {} }
      }
    } catch {
      try { const s = localStorage.getItem(GLOBAL_SCROLL_KEY); if (s) saved = JSON.parse(s); } catch {}
    }
    // 还原到此前的位置。storedHref 仅用于诊断/日志，不参与是否还原的判断。
    const storedHref = saved?.href || "";
    const targetY = Math.max(0, Number(saved?.scrollY) || 0);
    if (Number.isFinite(targetY) && targetY > 0) {
      const maxScroll = Math.max(0, (document.documentElement.scrollHeight || 0) - (window.innerHeight || 0));
      const clampY = Math.min(targetY, maxScroll);
      const restore = () => { try { window.scrollTo({ top: clampY, behavior: "instant" }); } catch {} };
      restore();
      requestAnimationFrame(restore);
      setTimeout(restore, 120);
      setTimeout(restore, 450);
      logDebug("info", "已还原全局滚动位置", { from: storedHref, targetY: clampY });
    }
  }

  async function restoreFloatingState() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "weborg:get-floating-state" });
      const mode = response?.state?.mode || (response?.open ? "open" : "minimized");
      if (response?.ok) {
        state.mode = mode === "open" ? "open" : "minimized";
        render();
      }
    } catch {
      // The navigation remains available even when session state is unavailable.
    }
  }

  window.addEventListener("scroll", () => {
    clearTimeout(rememberLocation.timer);
    rememberLocation.timer = setTimeout(rememberLocation, 180);
  }, { passive: true });
  window.addEventListener("pagehide", rememberLocation);
  window.addEventListener("hashchange", rememberLocation);
  window.addEventListener("popstate", rememberLocation);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") rememberLocation();
  });
  setInterval(rememberLocation, 4000);

  chrome.runtime.sendMessage({ type: "weborg:get-config" })
    .then((response) => {
      if (!response?.ok) throw new Error(response?.reason || "配置加载失败");
      state.config = FlowHubLegacyCatalog.validate(response.config);
      state.status = "悬浮导航 · 当前页打开";
      logDebug("info", "配置加载成功", { items: state.config.items?.length ?? 0, sources: "background->localhost:4173" });
      render();
      restoreNav();
      restoreFloatingUI();
    })
    .catch((error) => {
      state.status = error.message;
      logDebug("error", "配置加载失败", { reason: error.message });
      render();
    });

  loadPreferences()
    .catch(() => {})
    .finally(() => render());
  // 开关(mode)和位置(position)统一由 config 加载后的 restoreFloatingUI() 还原，
  // 以消除与 loadPosition/restoreFloatingState 之间的异步竞态。
  restoreLocation().finally(() => setTimeout(rememberLocation, 600));
  setupStorageSync();
  render();
})();
