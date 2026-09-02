const state = {
  config: null,
  savedConfig: null,
  plugins: [],
  configFile: null,
  clipboardStorage: null,
  selectedId: "",
  pendingAddId: "",
  mode: "structure",
  module: "core",
  dirty: false,
  jsonDirty: false,
  expanded: new Set(),
  draggingId: "",
  treeFilter: "",
  draftSavedAt: 0,
  selectedMemoId: "",
  memoFilter: "",
  coreSection: "general",
  appUpdate: { supported: false, currentVersion: "", status: "unsupported", availableVersion: "", percent: 0, error: "" },
  diagnostics: { enabled: false, available: false, path: "" }
};

const DRAFT_KEY_PREFIX = "flowhub:settings-draft:v1:";
const DEFAULT_SCOPE_SHORTCUTS = { all: "Shift+1", clipboard: "Shift+2", app: "Shift+3", web: "Shift+4", memo: "Shift+5" };
const PROXY_ADAPTERS = new Set(["auto", "mihomo", "clash-rest", "system"]);
const TOOL_SETTINGS = {
  calculator: "计算表达式",
  timestamp: "时间戳转换",
  jwt: "JWT 解析",
  dns: "DNS 解析",
  dnsIpGeo: "DNS 自动查询 IP 归属地",
  cloudflare: "Cloudflare 检测",
  localIp: "本机 IP 查询",
  proxy: "代理信息检测",
  ip: "IP 识别与归属地"
};
let draftTimer = null;

const $ = (selector) => document.querySelector(selector);
const clone = (value) => JSON.parse(JSON.stringify(value));
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

function iconHtml(node, className = "tree-icon") {
  const raw = String(node?.icon || "").trim();
  const isImage = /^https?:\/\//i.test(raw)
    || /^data:image\//i.test(raw)
    || /^(?:\.\/|\/)?assets\/[^?#]+\.(?:png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(raw);
  if (isImage) {
    const simpleIcon = raw.match(/^https:\/\/cdn\.simpleicons\.org\/([^/?#]+)/i);
    const fallback = simpleIcon
      ? `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${encodeURIComponent(simpleIcon[1])}.svg`
      : "";
    return `<span class="${className} image-icon"><img src="${esc(raw)}" ${fallback ? `data-fallback="${esc(fallback)}"` : ""} width="23" height="23" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" /></span>`;
  }
  if (raw) return `<span class="${className} text-icon">${esc(raw)}</span>`;
  const glyph = node?.url
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 4.5h7l3 3v12h-11v-15Z"/><path d="M14.5 4.5v3h3M9.5 12h5M9.5 15h4"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l1.7 2h9.3v9.5h-17V7.5Z"/><path d="M3.5 7.5V5h6l1.7 2h6.3v2.5"/></svg>`;
  return `<span class="${className} glyph-icon">${glyph}</span>`;
}

function normalizeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("配置必须是 JSON 对象");
  if (!config.core || typeof config.core !== "object") throw new Error("配置缺少 core 对象");
  if (config.core.configPath !== undefined && typeof config.core.configPath !== "string") throw new Error("配置文件位置必须是字符串");
  const configuredShortcuts = config.core.scopeShortcuts;
  if (configuredShortcuts !== undefined && (!configuredShortcuts || typeof configuredShortcuts !== "object" || Array.isArray(configuredShortcuts))) throw new Error("范围快捷键必须是对象");
  const scopeShortcuts = { ...DEFAULT_SCOPE_SHORTCUTS, ...(configuredShortcuts || {}) };
  const usedShortcuts = new Map();
  const modifierAliases = { option: "alt", control: "ctrl", cmd: "meta", command: "meta", cmdorctrl: "commandorcontrol" };
  const modifiers = new Set(["shift", "alt", "ctrl", "meta", "commandorcontrol"]);
  for (const [scope, shortcut] of Object.entries(scopeShortcuts)) {
    if (!(scope in DEFAULT_SCOPE_SHORTCUTS)) continue;
    if (typeof shortcut !== "string") throw new Error(`${scope} 的范围快捷键必须是字符串`);
    const normalized = shortcut.replace(/\s+/g, "").toLowerCase();
    if (!normalized) continue;
    const parts = normalized.split("+").filter(Boolean).map((part) => modifierAliases[part] || part);
    const keys = parts.filter((part) => !modifiers.has(part));
    if (keys.length !== 1 || (!parts.some((part) => modifiers.has(part)) && !/^f(?:[1-9]|1\d|2[0-4])$/.test(keys[0]))) {
      throw new Error(`${scope} 的范围快捷键格式无效：${shortcut}`);
    }
    const canonical = [...new Set(parts.filter((part) => modifiers.has(part)))].sort().join("+") + `+${keys[0]}`;
    if (usedShortcuts.has(canonical)) throw new Error(`范围快捷键重复：${shortcut}`);
    usedShortcuts.set(canonical, scope);
  }
  config.core.scopeShortcuts = scopeShortcuts;
  if (!config.plugins || typeof config.plugins !== "object") throw new Error("配置缺少 plugins 对象");
  config.plugins.memo ||= { enabled: true, settings: {} };
  config.plugins.memo.settings ||= {};
  config.plugins.tools ||= { enabled: true, settings: {} };
  config.plugins.tools.settings ||= {};
  if (!PROXY_ADAPTERS.has(config.plugins.tools.settings.proxyAdapter)) config.plugins.tools.settings.proxyAdapter = "auto";
  Object.keys(TOOL_SETTINGS).forEach((key) => {
    if (typeof config.plugins.tools.settings[key] !== "boolean") config.plugins.tools.settings[key] = true;
  });
  const items = config.plugins.web?.settings?.items;
  if (!Array.isArray(items)) throw new Error("网页插件配置缺少 items 数组");
  const ids = new Set();
  const visit = (nodes) => {
    nodes.forEach((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("目录节点必须是对象");
      const id = String(node.id || "").trim();
      if (!id) throw new Error("每个目录节点都需要 id");
      if (ids.has(id)) throw new Error(`目录 id 重复：${id}`);
      ids.add(id);
      if (node.children !== undefined && !Array.isArray(node.children)) throw new Error(`节点 ${id} 的 children 必须是数组`);
      visit(node.children || []);
    });
  };
  visit(items);
  return config;
}

function pluginConfig(id) {
  return state.config?.plugins?.[id];
}

function webItems() {
  return pluginConfig("web")?.settings?.items || [];
}

function configuredMemoItems() {
  const items = pluginConfig("memo")?.settings?.items;
  return Array.isArray(items) ? items : null;
}

function memoItems() {
  return configuredMemoItems() || window.FlowHubMemoCatalog?.cloneDefaults?.() || [];
}

function memoTags(item) {
  return Array.isArray(item?.tags)
    ? item.tags
    : String(item?.tags || "").split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean);
}

function memoCategorySegments(item) {
  return window.FlowHubMemoCatalog?.categorySegments?.(item?.category) || [String(item?.category || "其他")];
}

function memoCategoryPath(item) {
  return memoCategorySegments(item).join(" / ");
}

function memoTree(items) {
  const root = { children: new Map(), items: [] };
  for (const item of items) {
    let branch = root;
    for (const segment of memoCategorySegments(item)) {
      if (!branch.children.has(segment)) branch.children.set(segment, { children: new Map(), items: [] });
      branch = branch.children.get(segment);
    }
    branch.items.push(item);
  }
  return root;
}

function renderMemoTreeBranch(branch, depth = 0) {
  let html = "";
  for (const [label, child] of branch.children) {
    const total = countMemoTreeItems(child);
    html += `<div class="memo-tree-group" style="--memo-depth:${depth}">
      <div class="memo-tree-label"><span class="memo-tree-joint" aria-hidden="true"></span><strong>${esc(label)}</strong><small>${total}</small></div>
      ${renderMemoTreeBranch(child, depth + 1)}
      ${child.items.map((item) => renderMemoListItem(item, depth + 1)).join("")}
    </div>`;
  }
  html += branch.items.map((item) => renderMemoListItem(item, depth)).join("");
  return html;
}

function countMemoTreeItems(branch) {
  let total = branch.items.length;
  for (const child of branch.children.values()) total += countMemoTreeItems(child);
  return total;
}

function renderMemoListItem(item, depth) {
  return `<button class="memo-list-item${item.id === state.selectedMemoId ? " active" : ""}" style="--memo-depth:${depth}" type="button" data-memo-id="${esc(item.id)}">
    <span class="memo-list-bullet" aria-hidden="true">›_</span>
    <strong>${esc(item.title || "未命名备忘")}</strong>
    <code>${esc(String(item.content || "").split("\n")[0])}</code>
  </button>`;
}

function materializeMemoItems() {
  const memo = pluginConfig("memo");
  memo.settings ||= {};
  if (!Array.isArray(memo.settings.items)) memo.settings.items = window.FlowHubMemoCatalog?.cloneDefaults?.() || [];
  return memo.settings.items;
}

function ensureMemoSelection(items = memoItems()) {
  if (!items.some((item) => item.id === state.selectedMemoId)) state.selectedMemoId = items[0]?.id || "";
}

function selectedMemo(items = memoItems()) {
  ensureMemoSelection(items);
  return items.find((item) => item.id === state.selectedMemoId) || null;
}

function uniqueMemoId() {
  const ids = new Set(memoItems().map((item) => item.id));
  let id = `memo-${Date.now().toString(36)}`;
  let suffix = 2;
  while (ids.has(id)) id = `memo-${Date.now().toString(36)}-${suffix++}`;
  return id;
}

function nodeEntries(nodes = webItems(), level = 0, parent = null, result = []) {
  nodes.forEach((node, index) => {
    result.push({ node, level, parent, index });
    nodeEntries(node.children || [], level + 1, node, result);
  });
  return result;
}

function visibleNodeEntries(nodes = webItems(), level = 0, parent = null, result = []) {
  nodes.forEach((node, index) => {
    result.push({ node, level, parent, index });
    if (node.children?.length && state.expanded.has(node.id)) {
      visibleNodeEntries(node.children, level + 1, node, result);
    }
  });
  return result;
}

function filteredNodeEntries() {
  const query = state.treeFilter.trim().toLowerCase();
  if (!query) return visibleNodeEntries();
  const collect = (nodes, level = 0, parent = null) => {
    const result = [];
    for (const [index, node] of nodes.entries()) {
      const childResult = collect(node.children || [], level + 1, node);
      const text = [node.title, node.id, node.url, node.note].filter(Boolean).join(" ").toLowerCase();
      if (text.includes(query) || childResult.length) {
        result.push({ node, level, parent, index }, ...childResult);
      }
    }
    return result;
  };
  return collect(webItems());
}

function expandAll() {
  state.expanded = new Set(nodeEntries().filter(({ node }) => node.children?.length).map(({ node }) => node.id));
}

function expandInitialTree() {
  state.expanded = new Set(webItems().filter((node) => node.children?.length).map((node) => node.id));
}

function collapseAll() {
  state.expanded.clear();
}

function toggleNode(nodeId) {
  if (state.expanded.has(nodeId)) state.expanded.delete(nodeId);
  else state.expanded.add(nodeId);
  renderTree();
}

function bindIconFallbacks() {
  document.querySelectorAll("img[data-fallback]").forEach((image) => {
    if (image.dataset.fallbackBound) return;
    image.dataset.fallbackBound = "true";
    image.addEventListener("error", () => {
      const fallback = image.dataset.fallback;
      if (fallback && image.src !== fallback) {
        image.src = fallback;
        image.removeAttribute("data-fallback");
        return;
      }
      image.replaceWith(document.createTextNode("□"));
    });
  });
}

function selectedNode() {
  return nodeEntries().find((entry) => entry.node.id === state.selectedId)?.node || null;
}

function selectedContext() {
  return nodeEntries().find((entry) => entry.node.id === state.selectedId) || null;
}

function ensureSelection() {
  const entries = nodeEntries();
  if (!entries.some((entry) => entry.node.id === state.selectedId)) state.selectedId = entries[0]?.node.id || "";
}

function pathFor(nodeId) {
  const path = [];
  function visit(nodes, parents = []) {
    for (const node of nodes) {
      const next = [...parents, node.title || node.id];
      if (node.id === nodeId) { path.push(...next); return true; }
      if (visit(node.children || [], next)) return true;
    }
    return false;
  }
  visit(webItems());
  return path.join(" / ");
}

function uniqueId(base = "new-node") {
  const ids = new Set(nodeEntries().map((entry) => entry.node.id));
  let id = `${base}-${Date.now().toString(36)}`;
  let suffix = 2;
  while (ids.has(id)) id = `${base}-${Date.now().toString(36)}-${suffix++}`;
  return id;
}

function newNode() {
  return { id: uniqueId(), title: "新建节点", children: [] };
}

function cancelPendingAdd() {
  const pendingId = state.pendingAddId;
  if (!pendingId) return;
  const context = nodeEntries().find((entry) => entry.node.id === pendingId);
  if (!context) {
    state.pendingAddId = "";
    return render();
  }
  const siblings = context.parent ? context.parent.children : webItems();
  siblings.splice(context.index, 1);
  state.expanded.delete(pendingId);
  state.pendingAddId = "";
  state.selectedId = siblings[context.index]?.id || siblings[context.index - 1]?.id || context.parent?.id || "";
  markDirty("已取消添加网页");
  render();
  toast("已取消添加，不会写入配置");
}

function prepareAddWebUrl(value) {
  const url = String(value || "").trim();
  if (!state.config || !/^https?:\/\//i.test(url)) return;
  let canonical = url;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    canonical = parsed.href.replace(/\/$/, "");
  } catch { return; }
  const existing = nodeEntries().find(({ node }) => {
    if (!node.url) return false;
    try {
      const parsed = new URL(node.url);
      parsed.hash = "";
      return parsed.href.replace(/\/$/, "") === canonical;
    } catch { return String(node.url).trim() === url; }
  });
  if (existing) {
    state.pendingAddId = "";
    state.module = "web";
    state.selectedId = existing.node.id;
    render();
    toast("这个链接已经在网页配置中");
    return;
  }
  const node = newNode();
  let title = canonical;
  try { title = new URL(canonical).hostname.replace(/^www\./i, "") || canonical; } catch {}
  node.title = title;
  node.url = url;
  webItems().unshift(node);
  state.pendingAddId = node.id;
  state.module = "web";
  state.selectedId = node.id;
  markDirty("已添加待确认的网页链接");
  render();
  toast("链接已填入网页配置，请确认后保存");
}
window.prepareAddWebUrl = prepareAddWebUrl;

function draftStorageKey(configFile = state.configFile) {
  const identity = String(configFile?.activePath || configFile?.resolvedPath || configFile?.defaultPath || "default");
  return `${DRAFT_KEY_PREFIX}${identity}`;
}

function readDraft(configFile = state.configFile) {
  try {
    const raw = localStorage.getItem(draftStorageKey(configFile));
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn("[FlowHub] 无法读取配置草稿", error);
    return null;
  }
}

function clearDraft(key = draftStorageKey()) {
  clearTimeout(draftTimer);
  draftTimer = null;
  try { localStorage.removeItem(key); }
  catch (error) { console.warn("[FlowHub] 无法清除配置草稿", error); }
  state.draftSavedAt = 0;
}

function persistDraftNow() {
  clearTimeout(draftTimer);
  draftTimer = null;
  if (!state.dirty || !state.config) return;
  try {
    const savedAt = Date.now();
    localStorage.setItem(draftStorageKey(), JSON.stringify({
      version: 1,
      savedAt,
      baseSignature: configSignature(state.savedConfig),
      config: state.config,
      selectedId: state.selectedId,
      selectedMemoId: state.selectedMemoId,
      memoFilter: state.memoFilter,
      expanded: [...state.expanded],
      module: state.module,
      mode: state.mode,
      jsonText: state.mode === "json" ? $("#jsonEditor")?.value || "" : ""
    }));
    state.draftSavedAt = savedAt;
    updateStatus();
  } catch (error) {
    console.warn("[FlowHub] 无法保存配置草稿", error);
  }
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(persistDraftNow, 120);
}

function configSignature(config) {
  const text = JSON.stringify(config || null);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function configsEqual(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function jsonTextDiffersFromConfig(text, config) {
  try {
    const parsed = clone(normalizeConfig(JSON.parse(text)));
    return !configsEqual(parsed, config);
  } catch {
    return text !== JSON.stringify(config || {}, null, 2);
  }
}

function jsonEditorDiffersFromConfig() {
  const editor = $("#jsonEditor");
  if (!editor) return false;
  return jsonTextDiffersFromConfig(editor.value, state.config);
}

function markDirty(message = "有未保存修改") {
  state.dirty = !configsEqual(state.config, state.savedConfig) || state.jsonDirty;
  state.draftSavedAt = 0;
  if (!state.dirty) {
    clearDraft();
    updateStatus();
    return;
  }
  const status = $("#status");
  status.textContent = message;
  status.classList.add("dirty");
  const saveButton = $("#saveBtn");
  if (saveButton) saveButton.disabled = false;
  scheduleDraftSave();
}

let toastTimer;
let allowUnload = false;
function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

function updateStatus() {
  const status = $("#status");
  const message = state.dirty ? (state.draftSavedAt ? "草稿已自动保存" : "有未保存修改") : "已保存";
  status.textContent = message;
  status.title = state.dirty && state.draftSavedAt
    ? `草稿保存于 ${new Date(state.draftSavedAt).toLocaleTimeString()}，尚未写入正式配置`
    : "";
  status.classList.toggle("dirty", state.dirty);
  const actionbarStatus = $("#actionbarStatus");
  if (actionbarStatus) actionbarStatus.textContent = message;
  const saveButton = $("#saveBtn");
  if (saveButton) saveButton.disabled = !state.dirty;
  const reloadButton = document.querySelector('[data-action="reload"]');
  if (reloadButton) {
    reloadButton.textContent = state.dirty ? "放弃修改" : "重新加载";
    reloadButton.title = state.dirty ? "放弃未保存修改并重新加载配置" : "从配置文件重新加载";
  }
}

function renderTree() {
  const tree = $("#tree");
  const allEntries = nodeEntries();
  const entries = filteredNodeEntries();
  const filterCount = $("#treeFilterCount");
  if (filterCount) filterCount.textContent = state.treeFilter.trim() ? `${entries.length} 项` : "";
  const treeSummary = $("#treeSummary");
  if (treeSummary) {
    const pageCount = allEntries.filter(({ node }) => node.url).length;
    treeSummary.textContent = state.treeFilter.trim()
      ? `${entries.length} 项匹配 · 共 ${allEntries.length} 个节点`
      : `${allEntries.length - pageCount} 个目录 · ${pageCount} 个页面`;
  }
  if (!entries.length) {
    tree.innerHTML = state.treeFilter.trim()
      ? `<div class="tree-empty">没有匹配的目录或页面。<br />可以尝试标题、域名或节点 ID。</div>`
      : `<div class="tree-empty">还没有目录节点。<br />点击右上角 ＋ 添加一级目录。</div>`;
    return;
  }
  tree.innerHTML = entries.map(({ node, level }) => `
    <div class="tree-row ${node.id === state.selectedId ? "active" : ""}" style="--depth:${level}" data-node-id="${esc(node.id)}" role="button" tabindex="0" aria-grabbed="${state.draggingId === node.id}">
      <span class="tree-drag-handle" draggable="true" title="拖拽移动节点" aria-label="拖拽移动 ${esc(node.title || node.id)}"><i></i><i></i><i></i><i></i><i></i><i></i></span>
      ${node.children?.length ? `<button class="tree-toggle" data-toggle-node="${esc(node.id)}" aria-expanded="${state.expanded.has(node.id)}" aria-label="${state.expanded.has(node.id) ? "收缩" : "展开"}"></button>` : `<span class="tree-toggle-spacer"></span>`}
      ${iconHtml(node)}
      <span class="tree-copy"><strong>${esc(node.title || node.id)}</strong><small>${node.url ? "页面" : `${node.children?.length || 0} 个下级`}</small></span>
    </div>
  `).join("");
  bindIconFallbacks();
}

function renderSelected() {
  const node = selectedNode();
  const editor = $("#nodeEditor");
  if (!node) {
    editor.innerHTML = `<div class="empty-editor"><strong>从左侧选择一个节点</strong>你可以先添加一级目录，再继续添加子节点。</div>`;
    return;
  }
  editor.innerHTML = `
    <div class="selected-card">
      <div class="selected-banner">
        ${iconHtml(node, "selected-icon")}
        <div><strong>${esc(node.title || "未命名节点")}</strong><small>${esc(pathFor(node.id))}</small></div>
      </div>
      <div class="form-section">
        <div class="form-section-head"><strong>基础信息</strong><small>决定搜索结果中的名称与打开行为</small></div>
        <div class="form-grid">
          <div class="field"><label>标题</label><input data-node-field="title" value="${esc(node.title || "")}" /></div>
          <div class="field"><label>节点 ID</label><input readonly value="${esc(node.id)}" /><div class="field-hint">用于目录定位；需要修改时请切换 JSON 模式。</div></div>
          <div class="field wide"><label>页面链接 URL</label><input data-node-field="url" value="${esc(node.url || "")}" placeholder="https://example.com/" /><div class="field-hint">留空时作为目录；填写后可以直接打开，同时仍可保留子节点。</div></div>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-head"><strong>外观与说明</strong><small>可选，不影响节点打开</small></div>
        <div class="form-grid">
          <div class="field"><label>图标（Emoji 或图片 URL）</label><input data-node-field="icon" value="${esc(node.icon || "")}" placeholder="☁ 或 https://..." /></div>
          <div class="field"><label>强调色</label><input data-node-field="accent" value="${esc(node.accent || "#4bd0b8")}" placeholder="#4bd0b8" /></div>
          <div class="field wide"><label>备注</label><textarea data-node-field="note" placeholder="可选：显示在搜索结果或页面说明中">${esc(node.note || "")}</textarea></div>
        </div>
      </div>
    </div>
  `;
  bindIconFallbacks();
}

function renderSettingsFields() {
  $("#coreHotkey").value = state.config?.core?.hotkey || "Alt+Space";
  $("#coreLaunchAtLogin").checked = state.config?.core?.launchAtLogin === true;
  if ($("#autoUpdateCheck")) $("#autoUpdateCheck").checked = state.config?.core?.autoUpdateCheck !== false;
  if ($("#autoUpdateInstall")) $("#autoUpdateInstall").checked = state.config?.core?.autoUpdateInstall === true;
  document.querySelectorAll("[data-core-scope-shortcut]").forEach((input) => {
    input.value = state.config?.core?.scopeShortcuts?.[input.dataset.coreScopeShortcut] ?? DEFAULT_SCOPE_SHORTCUTS[input.dataset.coreScopeShortcut] ?? "";
  });
  renderConfigPath();
  const proxyAdapter = $("#proxyAdapter");
  if (proxyAdapter) proxyAdapter.value = pluginConfig("tools")?.settings?.proxyAdapter || "auto";
  document.querySelectorAll("[data-tool-setting]").forEach((input) => {
    input.checked = pluginConfig("tools")?.settings?.[input.dataset.toolSetting] !== false;
  });
  $("#clipboardRetentionDays").value = Number(pluginConfig("clipboard")?.settings?.retentionDays ?? 30);
  renderClipboardStorage();
  renderClipboardSummary();
  renderAppUpdate();
  renderDiagnostics();
}

function renderDiagnostics() {
  const diagnostics = state.diagnostics || {};
  const toggle = $("#diagnosticsEnabled");
  if (!toggle) return;
  toggle.checked = diagnostics.enabled === true;
  toggle.disabled = document.documentElement.dataset.weborgRuntime === "browser";
  $("#diagnosticsPath").textContent = diagnostics.path || "仅正式 App 可用";
}

async function toggleDiagnostics(event) {
  const result = await window.weborg.setDiagnosticsEnabled(event.target.checked);
  if (!result?.ok && result?.enabled === undefined) {
    event.target.checked = !event.target.checked;
    return toast(result?.reason || "无法修改监控设置", true);
  }
  state.diagnostics = { ...state.diagnostics, enabled: event.target.checked, path: result.path || state.diagnostics.path, available: true };
  renderDiagnostics();
  toast(event.target.checked ? "已开启本地性能监控" : "已关闭本地性能监控");
}

async function sampleDiagnosticsFromSettings() {
  const result = await window.weborg.sampleDiagnostics();
  if (result?.preview || result?.disabled) return toast(result.reason || "监控未开启", true);
  toast("已记录一次进程性能采样");
}

async function clearDiagnosticsFromSettings() {
  if (!window.confirm("确定清理本机性能监控数据吗？不会影响网页、剪切板或备忘录数据。")) return;
  const result = await window.weborg.clearDiagnostics();
  if (!result?.ok) return toast(result?.reason || "清理失败", true);
  toast("性能监控数据已清理");
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const size = bytes / (1024 ** unitIndex);
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function renderAppUpdate() {
  const update = state.appUpdate || {};
  const currentVersion = String(update.currentVersion || "—");
  const availableVersion = String(update.availableVersion || "");
  const percent = Math.max(0, Math.min(100, Number(update.percent) || 0));
  const labels = {
    unsupported: "不可用",
    idle: "待检查",
    checking: "检查中",
    available: "发现新版",
    "not-available": "已是最新",
    downloading: "下载中",
    downloaded: "等待安装",
    installing: "正在重启",
    error: "检查失败"
  };
  const descriptions = {
    unsupported: "浏览器预览和开发模式不会连接更新服务；安装后的正式版本才会启用。",
    idle: "启动后会自动检查 GitHub Release，也可以立即手动检查。",
    checking: "正在连接 GitHub Release 检查最新稳定版本…",
    available: `发现 FlowHub v${availableVersion || "—"}，确认后开始下载，完成前不会退出当前应用。`,
    "not-available": `当前 v${currentVersion} 已是最新稳定版本。`,
    downloading: availableVersion ? `正在下载 FlowHub v${availableVersion}，可以继续使用其他设置。` : "正在下载新版本，可以继续使用其他设置。",
    downloaded: `FlowHub v${availableVersion || "新版本"} 已下载完成，重启后将自动替换当前版本。`,
    installing: "正在关闭 FlowHub 并安装新版本…",
    error: update.error || "无法连接更新服务，请稍后重试。"
  };
  const badge = $("#updateBadge");
  if (!badge) return;
  const isLocalBuild = /(?:-local(?:[.+-]|$)|\+local)/i.test(currentVersion);
  $("#currentVersion").textContent = `v${currentVersion}`;
  const topbarVersion = $("#topbarVersion");
  if (topbarVersion) {
    const visibleVersion = currentVersion === "—" ? "浏览器预览" : `v${currentVersion}`;
    topbarVersion.textContent = visibleVersion;
    topbarVersion.title = currentVersion === "—" ? "浏览器预览，不代表已安装的 App 版本" : `当前版本 ${visibleVersion}`;
  }
  badge.textContent = labels[update.status] || "待检查";
  badge.dataset.status = update.status || "idle";
  $("#updateDescription").textContent = descriptions[update.status] || descriptions.idle;

  const progress = $("#updateProgress");
  const showProgress = ["downloading", "downloaded"].includes(update.status);
  progress.classList.toggle("hidden", !showProgress);
  progress.setAttribute("aria-valuenow", String(Math.round(percent)));
  $("#updateProgressFill").style.width = `${percent}%`;
  $("#updateProgressText").textContent = `${Math.round(percent)}%`;

  let meta = isLocalBuild ? "本地迭代版 · 可回退 GitHub Release" : "稳定通道 · GitHub Release";
  if (update.status === "downloading" && update.total) {
    meta = `${formatBytes(update.transferred)} / ${formatBytes(update.total)} · ${formatBytes(update.bytesPerSecond)}/s`;
  } else if (update.checkedAt) {
    meta = `上次检查 ${new Date(update.checkedAt).toLocaleString()}`;
  }
  $("#updateMeta").textContent = meta;

  const checkButton = $("#checkUpdateBtn");
  checkButton.disabled = !update.supported || ["checking", "downloading", "downloaded", "installing"].includes(update.status);
  checkButton.textContent = update.status === "checking" ? "正在检查…" : update.status === "error" ? "重新检查" : isLocalBuild ? "检查正式版" : "检查更新";

  const primaryButton = $("#updatePrimaryBtn");
  const quickButton = $("#updateQuickBtn");
  const showPrimary = ["available", "downloading", "downloaded", "installing"].includes(update.status);
  const primaryLabel = update.status === "available"
    ? `下载 v${availableVersion || "新版本"}`
    : update.status === "downloading"
    ? `下载中 ${Math.round(percent)}%`
    : update.status === "downloaded"
    ? "重启并安装"
    : "正在重启…";
  for (const button of [primaryButton, quickButton]) {
    button.classList.toggle("hidden", !showPrimary);
    button.disabled = ["downloading", "installing"].includes(update.status);
    button.textContent = primaryLabel;
  }
}

function renderConfigPath() {
  const configuredPath = String(state.config?.core?.configPath || "").trim();
  const resolvedPath = configuredPath || state.configFile?.defaultPath || state.configFile?.resolvedPath || "项目目录/config.json";
  $("#coreConfigPath").value = resolvedPath;
  $("#coreConfigPathHint").textContent = state.configFile?.available === false
    ? "浏览器仅用于预览，请在 FlowHub App 中选择或打开配置文件。"
    : "保存后切换到新的配置文件；原文件会保留。";
}

function renderClipboardStorage() {
  const configuredPath = String(pluginConfig("clipboard")?.settings?.storagePath || "").trim();
  const resolvedPath = configuredPath || state.clipboardStorage?.defaultPath || state.clipboardStorage?.resolvedPath || "FlowHub 用户数据目录/clipboard";
  $("#clipboardStoragePath").value = resolvedPath;
  $("#clipboardStorageMode").textContent = configuredPath ? "自定义目录" : "默认目录";
  $("#clipboardStorageSummary").textContent = resolvedPath;
  $("#clipboardStorageHint").textContent = state.clipboardStorage?.available === false
    ? "浏览器仅用于预览，请在 FlowHub App 中选择或打开目录。"
    : "保存配置后切换位置；网页目录、使用记录和剪切板数据会安全复制到新的空目录。";
}

function renderClipboardSummary() {
  const enabled = pluginConfig("clipboard")?.enabled !== false;
  const retentionDays = Number(pluginConfig("clipboard")?.settings?.retentionDays ?? 30);
  const statusText = enabled ? "正在记录" : "已暂停";
  if ($("#clipboardStatusValue")) $("#clipboardStatusValue").textContent = statusText;
  if ($("#clipboardRetentionValue")) $("#clipboardRetentionValue").textContent = retentionDays === 0 ? "永久保留" : `${retentionDays} 天`;
  if ($("#clipboardModuleState")) {
    $("#clipboardModuleState").textContent = statusText;
    $("#clipboardModuleState").classList.toggle("paused", !enabled);
  }
}

function renderMemoSettings() {
  const items = memoItems();
  ensureMemoSelection(items);
  const filter = state.memoFilter.trim().toLowerCase();
  const visibleItems = filter
    ? items.filter((item) => [item.title, item.category, item.description, ...memoTags(item), item.content].join(" ").toLowerCase().includes(filter))
    : items;
  const categories = new Set(items.map(memoCategoryPath));
  const selected = selectedMemo(items);
  if ($("#memoCountValue")) $("#memoCountValue").textContent = `${items.length} 条`;
  if ($("#memoCategoryValue")) $("#memoCategoryValue").textContent = `${categories.size} 类`;
  if ($("#memoSourceValue")) $("#memoSourceValue").textContent = configuredMemoItems() ? "自定义库" : "内置命令库";
  if ($("#memoFilter") && $("#memoFilter").value !== state.memoFilter) $("#memoFilter").value = state.memoFilter;
  if ($("#memoList")) {
    $("#memoList").innerHTML = visibleItems.length ? renderMemoTreeBranch(memoTree(visibleItems)) : `<div class="tree-empty">没有匹配的备忘录</div>`;
  }
  if ($("#memoEditor")) {
    $("#memoEditor").innerHTML = selected ? `
      <div class="memo-editor-head"><div><span>${esc(memoCategoryPath(selected).replaceAll(" / ", "  ›  "))}</span><strong>${esc(selected.title || "未命名备忘")}</strong></div><button class="button danger" type="button" data-action="delete-memo">删除</button></div>
      <div class="form-grid memo-form">
        <div class="field"><label>标题</label><input data-memo-field="title" value="${esc(selected.title)}" /></div>
        <div class="field"><label>目录路径</label><input data-memo-field="category" value="${esc(memoCategoryPath(selected))}" placeholder="编程 / 数据库 / MySQL" /><div class="field-hint">使用 / 分隔层级，例如“编程 / 数据库 / MySQL”。</div></div>
        <div class="field wide"><label>说明</label><input data-memo-field="description" value="${esc(selected.description)}" placeholder="这条命令用于什么场景" /></div>
        <div class="field wide"><label>搜索标签</label><input data-memo-field="tags" value="${esc(memoTags(selected).join(", "))}" placeholder="磁盘, 占用, du" /><div class="field-hint">使用逗号分隔；标题、分类、说明、标签和命令正文都会参与搜索。</div></div>
        <div class="field wide"><label>命令或备忘内容</label><textarea class="memo-content-editor" data-memo-field="content" spellcheck="false">${esc(selected.content)}</textarea></div>
      </div>` : `<div class="empty-editor"><strong>还没有备忘录</strong>点击“新增备忘”创建第一条内容。</div>`;
  }
}

function syncJson({ force = false } = {}) {
  if (state.jsonDirty && !force) return;
  $("#jsonEditor").value = JSON.stringify(state.config || {}, null, 2);
  if (force) state.jsonDirty = false;
}

function renderMode() {
  $("#structurePanel").classList.toggle("hidden", state.mode !== "structure");
  $("#jsonPanel").classList.toggle("hidden", state.mode !== "json");
  document.querySelectorAll(".mode-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === state.mode));
}

function renderModule() {
  const workspace = document.querySelector(".workspace");
  workspace?.classList.toggle("single-pane", state.module !== "web");
  document.querySelectorAll("[data-module-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.modulePanel !== state.module);
  });
  document.querySelectorAll("[data-module]").forEach((item) => {
    const active = item.dataset.module === state.module;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
}

function renderCoreSection() {
  const sections = {
    general: { icon: "F", title: "启动与唤出", description: "修改快捷键或登录启动设置，保存后立即生效。" },
    search: { icon: "⌘", title: "搜索入口", description: "集中管理搜索来源、启停状态和范围快捷键。" },
    network: { icon: "↗", title: "网络与代理", description: "选择 FlowHub 读取本机代理状态的方式。" },
    system: { icon: "⌂", title: "数据与更新", description: "管理主配置文件位置并检查 FlowHub 更新。" }
  };
  if (!sections[state.coreSection]) state.coreSection = "general";
  document.querySelectorAll("[data-core-section]").forEach((button) => {
    const active = button.dataset.coreSection === state.coreSection;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-core-section-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.coreSectionPanel !== state.coreSection);
  });
  const section = sections[state.coreSection];
  $("#coreSectionIcon").textContent = section.icon;
  $("#coreSectionTitle").textContent = section.title;
  $("#coreSectionDescription").textContent = section.description;
}

function renderPluginModules() {
  const plugins = [...state.plugins].sort((a, b) => Number(a.settingsOrder || a.order) - Number(b.settingsOrder || b.order));
  const pluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const pluginButton = (plugin) => {
    const moduleId = plugin.settingsPanel || "";
    const active = moduleId === state.module;
    const disabled = !plugin.available || !moduleId;
    const hint = !plugin.available ? "未安装" : !plugin.enabled ? "已停用" : plugin.settingsHint;
    return `<button class="module-button${active ? " active" : ""}" type="button" ${moduleId ? `data-module="${esc(moduleId)}"` : ""} ${disabled ? "disabled" : ""} title="${esc(hint || plugin.name)}"><i class="module-nav-icon">${esc(plugin.icon || "·")}</i><span class="module-nav-copy"><strong>${esc(plugin.settingsName || plugin.name)}</strong><small>${esc(hint || "")}</small></span></button>`;
  };
  const coreButton = `<button class="module-button${state.module === "core" ? " active" : ""}" type="button" data-module="core"><i class="module-nav-icon">F</i><span class="module-nav-copy"><strong>通用设置</strong><small>App 配置</small></span></button>`;
  const categoryMenu = (label, icon, ids) => {
    const items = ids.map((id) => pluginsById.get(id)).filter(Boolean);
    const activePlugin = items.find((plugin) => plugin.settingsPanel === state.module);
    const title = activePlugin ? `${label} · 当前为${activePlugin.settingsName || activePlugin.name}` : `${label} · ${items.length} 个模块`;
    return `<details class="module-nav-menu${activePlugin ? " current" : ""}"><summary class="module-nav-menu-trigger" title="${esc(title)}"><i class="module-nav-icon">${esc(activePlugin?.icon || icon)}</i><strong>${esc(label)}</strong><span class="module-nav-menu-chevron">⌄</span></summary><div class="module-nav-popover">${items.map(pluginButton).join("")}</div></details>`;
  };
  $("#moduleSwitcher").innerHTML = [
    coreButton,
    categoryMenu("入口", "◇", ["web", "app"]),
    categoryMenu("文本", "▤", ["clipboard", "memo"]),
    categoryMenu("工具", "✦", ["tools"])
  ].join("");

  const controls = $("#corePluginControls");
  if (!controls) return;
  const controlGroups = [
    { label: "入口", description: "网页与本机应用", ids: ["web", "app"] },
    { label: "文本", description: "剪切板与备忘录", ids: ["clipboard", "memo"] },
    { label: "工具", description: "格式识别与网络查询", ids: ["tools"] }
  ];
  controls.innerHTML = controlGroups.map((group) => {
    const items = group.ids.map((id) => pluginsById.get(id)).filter(Boolean).map((plugin) => {
      const hint = !plugin.available ? "插件未安装" : plugin.description || plugin.settingsHint || "";
      const shortcut = Object.prototype.hasOwnProperty.call(DEFAULT_SCOPE_SHORTCUTS, plugin.id)
        ? `<label class="plugin-shortcut" for="scopeShortcut${esc(plugin.id)}"><span>范围键</span><input id="scopeShortcut${esc(plugin.id)}" data-core-scope-shortcut="${esc(plugin.id)}" value="${esc(state.config?.core?.scopeShortcuts?.[plugin.id] ?? DEFAULT_SCOPE_SHORTCUTS[plugin.id] ?? "")}" placeholder="${esc(DEFAULT_SCOPE_SHORTCUTS[plugin.id] || "")}" /></label>`
        : `<span></span>`;
      return `<div class="plugin-control-item" title="${esc(hint)}"><i class="plugin-control-icon">${esc(plugin.icon || "·")}</i><span class="plugin-control-copy"><strong>${esc(plugin.settingsName || plugin.name)}</strong><small>${esc(plugin.settingsHint || hint)}</small></span>${shortcut}<label class="plugin-enable" title="${plugin.enabled ? "停用" : "启用"}${esc(plugin.name)}"><input type="checkbox" data-plugin-toggle="${esc(plugin.id)}" ${plugin.enabled ? "checked" : ""} ${plugin.available ? "" : "disabled"} aria-label="启用${esc(plugin.name)}" /></label></div>`;
    }).join("");
    return `<section class="plugin-control-group"><header class="plugin-control-group-head"><strong>${esc(group.label)}</strong><small>${esc(group.description)}</small></header>${items}</section>`;
  }).join("");
}

function render() {
  ensureSelection();
  renderPluginModules();
  renderSettingsFields();
  renderTree();
  renderSelected();
  renderMemoSettings();
  updateMoveActions();
  syncJson();
  renderMode();
  renderModule();
  renderCoreSection();
  const cancelAddButton = $("#cancelAddBtn");
  if (cancelAddButton) cancelAddButton.hidden = !(state.module === "web" && state.pendingAddId);
  updateStatus();
}

function addRoot() {
  const node = newNode();
  webItems().push(node);
  state.selectedId = node.id;
  markDirty();
  render();
}

function addChild() {
  const parent = selectedNode();
  if (!parent) return addRoot();
  parent.children ||= [];
  const node = newNode();
  parent.children.push(node);
  state.expanded.add(parent.id);
  state.selectedId = node.id;
  markDirty();
  render();
}

function addSibling() {
  const context = selectedContext();
  if (!context) return addRoot();
  const siblings = context.parent ? (context.parent.children ||= []) : webItems();
  const node = newNode();
  siblings.splice(context.index + 1, 0, node);
  state.selectedId = node.id;
  markDirty();
  render();
}

function deleteSelected() {
  const context = selectedContext();
  if (!context) return;
  const childCount = context.node.children?.length || 0;
  const message = childCount ? `“${context.node.title || context.node.id}” 下有 ${childCount} 个子节点，确定删除整个分支吗？` : `确定删除“${context.node.title || context.node.id}”吗？`;
  if (!window.confirm(message)) return;
  const siblings = context.parent ? context.parent.children : webItems();
  siblings.splice(context.index, 1);
  if (context.node.id === state.pendingAddId) state.pendingAddId = "";
  state.expanded.delete(context.node.id);
  state.selectedId = siblings[context.index]?.id || siblings[context.index - 1]?.id || context.parent?.id || "";
  markDirty();
  render();
}

function moveSelected(direction) {
  const context = selectedContext();
  if (!context) return;
  const siblings = context.parent ? context.parent.children : webItems();
  const nextIndex = context.index + direction;
  if (nextIndex < 0 || nextIndex >= siblings.length) return toast("已经到当前层级的边界");
  [siblings[context.index], siblings[nextIndex]] = [siblings[nextIndex], siblings[context.index]];
  markDirty("排序已调整");
  render();
}

function moveSelectedToBoundary(boundary) {
  const context = selectedContext();
  if (!context) return;
  const siblings = context.parent ? context.parent.children : webItems();
  const targetIndex = boundary === "top" ? 0 : siblings.length - 1;
  if (context.index === targetIndex) return toast(boundary === "top" ? "已经在当前同级顶部" : "已经在当前同级底部");
  const [node] = siblings.splice(context.index, 1);
  if (boundary === "top") siblings.unshift(node);
  else siblings.push(node);
  markDirty(boundary === "top" ? "已移到当前同级顶部" : "已移到当前同级底部");
  render();
}

function updateMoveActions() {
  const context = selectedContext();
  const siblings = context ? (context.parent ? context.parent.children : webItems()) : [];
  const states = {
    moveTopBtn: !context || context.index === 0,
    moveUpBtn: !context || context.index === 0,
    moveDownBtn: !context || context.index === siblings.length - 1,
    moveBottomBtn: !context || context.index === siblings.length - 1
  };
  Object.entries(states).forEach(([id, disabled]) => {
    const button = document.getElementById(id);
    if (button) button.disabled = disabled;
  });
}

function nodeContains(root, nodeId) {
  if (root.id === nodeId) return true;
  return (root.children || []).some((child) => nodeContains(child, nodeId));
}

function moveNodeByDrop(sourceId, targetId, position) {
  const source = nodeEntries().find((entry) => entry.node.id === sourceId);
  const target = nodeEntries().find((entry) => entry.node.id === targetId);
  if (!source || !target || sourceId === targetId) return false;
  if (nodeContains(source.node, targetId)) {
    toast("不能把目录移动到自己的下级中", true);
    return false;
  }

  const sourceSiblings = source.parent ? source.parent.children : webItems();
  const [movingNode] = sourceSiblings.splice(source.index, 1);
  const nextTarget = nodeEntries().find((entry) => entry.node.id === targetId);
  if (!nextTarget) {
    sourceSiblings.splice(source.index, 0, movingNode);
    return false;
  }

  if (position === "inside") {
    nextTarget.node.children ||= [];
    nextTarget.node.children.push(movingNode);
    state.expanded.add(nextTarget.node.id);
  } else {
    const targetSiblings = nextTarget.parent ? nextTarget.parent.children : webItems();
    targetSiblings.splice(nextTarget.index + (position === "after" ? 1 : 0), 0, movingNode);
  }

  state.selectedId = movingNode.id;
  markDirty("目录结构已调整");
  render();
  return true;
}

function clearDropIndicators() {
  document.querySelectorAll(".tree-row.drop-before, .tree-row.drop-inside, .tree-row.drop-after")
    .forEach((row) => row.classList.remove("drop-before", "drop-inside", "drop-after"));
}

function dropPositionFor(row, clientY) {
  const rect = row.getBoundingClientRect();
  const ratio = (clientY - rect.top) / Math.max(rect.height, 1);
  if (ratio < 0.28) return "before";
  if (ratio > 0.72) return "after";
  return "inside";
}

function readJsonEditor() {
  try {
    return normalizeConfig(JSON.parse($("#jsonEditor").value));
  } catch (error) {
    throw new Error(`JSON 无法应用：${error.message}`);
  }
}

async function save() {
  try {
    const previousDraftKey = draftStorageKey();
    if (state.mode === "json") {
      state.config = clone(readJsonEditor());
      state.jsonDirty = false;
    }
    normalizeConfig(state.config);
    const result = await window.weborg.saveConfig(state.config);
    if (!result?.ok) throw new Error(result?.reason || "保存失败");
    state.config = clone(normalizeConfig(result.config || state.config));
    state.savedConfig = clone(state.config);
    state.pendingAddId = "";
    [state.plugins, state.clipboardStorage, state.configFile] = await Promise.all([window.weborg.listPlugins(), window.weborg.getClipboardStorageInfo(), window.weborg.getConfigPathInfo()]);
    state.dirty = false;
    clearDraft(previousDraftKey);
    render();
    toast(result.pluginFailures?.length ? `配置已保存，但 ${result.pluginFailures.length} 个插件启动失败` : "配置已保存，插件状态已生效", Boolean(result.pluginFailures?.length));
  } catch (error) {
    toast(error.message, true);
  }
}

async function reload() {
  if (state.dirty && !window.confirm("当前有未保存修改，确定放弃修改并重新加载配置吗？")) return;
  try {
    clearDraft();
    [state.plugins, state.config, state.clipboardStorage, state.configFile] = await Promise.all([window.weborg.listPlugins(), window.weborg.getConfig(), window.weborg.getClipboardStorageInfo(), window.weborg.getConfigPathInfo()]);
    normalizeConfig(state.config);
    state.savedConfig = clone(state.config);
    state.jsonDirty = false;
    state.dirty = false;
    render();
    toast("已重新加载 config.json");
  } catch (error) {
    toast(error.message, true);
  }
}

async function openAccessibilitySettings() {
  const result = await window.weborg.openAccessibilitySettings();
  if (!result?.ok) toast(result?.reason || "无法打开系统设置", true);
}

async function checkAppUpdate() {
  if (!state.appUpdate?.supported) return toast("安装后的正式版本才支持检查更新", true);
  state.appUpdate = { ...state.appUpdate, status: "checking", error: "" };
  renderAppUpdate();
  const result = await window.weborg.checkForUpdates();
  if (result?.state) state.appUpdate = result.state;
  renderAppUpdate();
  if (!result?.ok) toast(result?.reason || "检查更新失败", true);
}

async function runPrimaryUpdateAction() {
  const status = state.appUpdate?.status;
  if (status === "available") {
    const result = await window.weborg.downloadUpdate();
    if (result?.state) state.appUpdate = result.state;
    renderAppUpdate();
    if (!result?.ok) toast(result?.reason || "下载更新失败", true);
    return;
  }
  if (status === "downloaded") {
    if (state.dirty) {
      toast("请先保存或放弃当前配置修改，再重启安装更新", true);
      return;
    }
    if (!window.confirm("更新已准备完成。现在重启 FlowHub 并安装吗？")) return;
    const result = await window.weborg.quitAndInstallUpdate();
    if (result?.state) state.appUpdate = result.state;
    renderAppUpdate();
    if (!result?.ok) toast(result?.reason || "无法启动更新安装", true);
  }
}

async function chooseConfigPath() {
  const result = await window.weborg.chooseConfigPath();
  if (!result?.ok) {
    if (!result?.canceled) toast(result?.reason || "无法选择配置文件位置", true);
    return;
  }
  state.config.core ||= {};
  state.config.core.configPath = result.path;
  markDirty("配置文件位置将在保存后切换");
  renderConfigPath();
}

async function openConfigPath() {
  if (state.dirty && String(state.config?.core?.configPath || "").trim() !== String(state.configFile?.configuredPath || "").trim()) {
    toast("请先保存新的配置文件位置，再打开文件");
    return;
  }
  const result = await window.weborg.openConfigPath();
  if (!result?.ok) toast(result?.reason || "无法打开配置文件位置", true);
}

function resetConfigPath() {
  state.config.core ||= {};
  state.config.core.configPath = "";
  markDirty("保存后将恢复默认配置文件位置");
  renderConfigPath();
}

async function chooseClipboardStorage() {
  const result = await window.weborg.chooseClipboardStorage();
  if (!result?.ok) {
    if (!result?.canceled) toast(result?.reason || "无法选择存放目录", true);
    return;
  }
  const clipboard = pluginConfig("clipboard");
  clipboard.settings ||= {};
  clipboard.settings.storagePath = result.path;
  state.clipboardStorage = { ...(state.clipboardStorage || {}), resolvedPath: result.path };
  markDirty("存放位置将在保存后切换");
  renderClipboardStorage();
}

async function openClipboardStorage() {
  if (state.dirty && String(pluginConfig("clipboard")?.settings?.storagePath || "").trim() !== String(state.clipboardStorage?.configuredPath || "").trim()) {
    toast("请先保存新的存放位置，再打开目录");
    return;
  }
  const result = await window.weborg.openClipboardStorage();
  if (!result?.ok) toast(result?.reason || "无法打开存放目录", true);
}

function resetClipboardStorage() {
  const clipboard = pluginConfig("clipboard");
  clipboard.settings ||= {};
  clipboard.settings.storagePath = "";
  markDirty("保存后将恢复默认存放位置");
  renderClipboardStorage();
}

function addMemo() {
  const items = materializeMemoItems();
  const memo = { id: uniqueMemoId(), title: "新建备忘", category: "个人 / 未分类", description: "", tags: [], content: "" };
  items.unshift(memo);
  state.selectedMemoId = memo.id;
  state.memoFilter = "";
  markDirty("已新增备忘录");
  renderMemoSettings();
}

function deleteMemo() {
  const items = materializeMemoItems();
  const index = items.findIndex((item) => item.id === state.selectedMemoId);
  if (index < 0) return;
  if (!window.confirm(`确定删除“${items[index].title || "未命名备忘"}”吗？`)) return;
  items.splice(index, 1);
  state.selectedMemoId = items[index]?.id || items[index - 1]?.id || "";
  markDirty("已删除备忘录");
  renderMemoSettings();
}

function resetMemos() {
  if (!window.confirm("确定恢复内置命令库吗？所有自定义备忘和修改都会被替换。")) return;
  const memo = pluginConfig("memo");
  memo.settings ||= {};
  delete memo.settings.items;
  state.selectedMemoId = "";
  state.memoFilter = "";
  markDirty("已恢复内置命令库");
  renderMemoSettings();
}

function closeSettings() {
  if (state.dirty && !window.confirm("当前有未保存修改，确定关闭设置吗？修改仍会保留在本地草稿中。")) return;
  allowUnload = true;
  if (document.documentElement.dataset.weborgRuntime !== "browser") {
    window.close();
    return;
  }
  if (window.opener && !window.opener.closed) {
    window.close();
    return;
  }
  window.location.assign("/search.html");
}

function applyInitialWebUrl() {
  const value = new URLSearchParams(window.location.search).get("addUrl");
  if (!value) return;
  window.history.replaceState({}, "", window.location.pathname);
  prepareAddWebUrl(value);
}

function handleAction(action) {
  if (action === "add-root") return addRoot();
  if (action === "expand-all") { expandAll(); return renderTree(); }
  if (action === "collapse-all") { collapseAll(); return renderTree(); }
  if (action === "add-child") return addChild();
  if (action === "add-sibling") return addSibling();
  if (action === "delete") return deleteSelected();
  if (action === "cancel-add") return cancelPendingAdd();
  if (action === "move-up") return moveSelected(-1);
  if (action === "move-down") return moveSelected(1);
  if (action === "move-top") return moveSelectedToBoundary("top");
  if (action === "move-bottom") return moveSelectedToBoundary("bottom");
  if (action === "save") return save();
  if (action === "reload") return reload();
  if (action === "open-accessibility-settings") return openAccessibilitySettings();
  if (action === "check-update") return checkAppUpdate();
  if (action === "update-primary") return runPrimaryUpdateAction();
  if (action === "sample-diagnostics") return sampleDiagnosticsFromSettings();
  if (action === "clear-diagnostics") return clearDiagnosticsFromSettings();
  if (action === "choose-config-path") return chooseConfigPath();
  if (action === "open-config-path") return openConfigPath();
  if (action === "reset-config-path") return resetConfigPath();
  if (action === "choose-clipboard-storage") return chooseClipboardStorage();
  if (action === "open-clipboard-storage") return openClipboardStorage();
  if (action === "reset-clipboard-storage") return resetClipboardStorage();
  if (action === "add-memo") return addMemo();
  if (action === "delete-memo") return deleteMemo();
  if (action === "reset-memos") return resetMemos();
  if (action === "close") return closeSettings();
  if (action === "format-json") {
    try {
      $("#jsonEditor").value = JSON.stringify(readJsonEditor(), null, 2);
      state.jsonDirty = jsonEditorDiffersFromConfig();
      markDirty("JSON 已格式化");
      toast("JSON 已格式化");
    }
    catch (error) { toast(error.message, true); }
  }
  if (action === "apply-json") {
    try {
      state.config = clone(readJsonEditor());
      state.jsonDirty = false;
      expandAll();
      ensureSelection();
      markDirty("JSON 已应用");
      state.mode = "structure";
      render();
      toast("JSON 已应用到结构化编辑器");
    } catch (error) { toast(error.message, true); }
  }
}

function switchModule(module) {
  if (!["core", "web", "clipboard", "app", "memo", "tools"].includes(module)) return;
  state.module = module;
  renderPluginModules();
  renderModule();
}

document.addEventListener("click", (event) => {
  const coreSection = event.target.closest("[data-core-section]")?.dataset.coreSection;
  if (coreSection) {
    state.coreSection = coreSection;
    renderCoreSection();
    return;
  }
  const module = event.target.closest("[data-module]")?.dataset.module;
  if (module) {
    switchModule(module);
    return;
  }
  const toggleId = event.target.closest("[data-toggle-node]")?.dataset.toggleNode;
  if (toggleId) return toggleNode(toggleId);
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action) return handleAction(action);
  const mode = event.target.closest("[data-mode]")?.dataset.mode;
  if (mode) {
    state.mode = mode;
    if (mode === "json") syncJson({ force: !state.jsonDirty });
    renderMode();
  }
  const nodeId = event.target.closest("[data-node-id]")?.dataset.nodeId;
  if (nodeId) {
    state.selectedId = nodeId;
    renderTree();
    renderSelected();
    updateMoveActions();
  }
  const memoId = event.target.closest("[data-memo-id]")?.dataset.memoId;
  if (memoId) {
    state.selectedMemoId = memoId;
    renderMemoSettings();
  }
});

document.addEventListener("keydown", (event) => {
  const row = event.target.closest?.("[data-node-id]");
  if (!row || event.target.closest("[data-toggle-node]")) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    state.selectedId = row.dataset.nodeId;
    renderTree();
    renderSelected();
    updateMoveActions();
  }
});

document.addEventListener("dragstart", (event) => {
  const handle = event.target.closest?.(".tree-drag-handle");
  const row = handle?.closest("[data-node-id]");
  if (!row) return;
  state.draggingId = row.dataset.nodeId;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.draggingId);
  requestAnimationFrame(() => row.classList.add("dragging"));
});

document.addEventListener("dragover", (event) => {
  const row = event.target.closest?.("[data-node-id]");
  if (!row || !state.draggingId || row.dataset.nodeId === state.draggingId) return;
  const source = nodeEntries().find((entry) => entry.node.id === state.draggingId)?.node;
  if (!source || nodeContains(source, row.dataset.nodeId)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const position = dropPositionFor(row, event.clientY);
  clearDropIndicators();
  row.classList.add(`drop-${position}`);
  row.dataset.dropPosition = position;
});

document.addEventListener("drop", (event) => {
  const row = event.target.closest?.("[data-node-id]");
  const sourceId = state.draggingId || event.dataTransfer.getData("text/plain");
  if (!row || !sourceId) return;
  event.preventDefault();
  const position = row.dataset.dropPosition || dropPositionFor(row, event.clientY);
  clearDropIndicators();
  moveNodeByDrop(sourceId, row.dataset.nodeId, position);
});

document.addEventListener("dragend", () => {
  document.querySelectorAll(".tree-row.dragging").forEach((row) => row.classList.remove("dragging"));
  clearDropIndicators();
  state.draggingId = "";
});

document.addEventListener("input", (event) => {
  if (event.target.id === "jsonEditor") {
    state.jsonDirty = jsonEditorDiffersFromConfig();
    markDirty("JSON 已修改");
    return;
  }
  if (event.target.id === "memoFilter") {
    state.memoFilter = event.target.value;
    renderMemoSettings();
    return;
  }
  if (event.target.id === "treeFilter") {
    state.treeFilter = event.target.value;
    renderTree();
    return;
  }
  const pluginId = event.target.dataset.pluginToggle;
  if (pluginId) {
    const config = pluginConfig(pluginId);
    const plugin = state.plugins.find((entry) => entry.id === pluginId);
    if (!config || !plugin?.available) return;
    config.enabled = event.target.checked;
    plugin.enabled = event.target.checked;
    markDirty(event.target.checked ? `${plugin.name}将在保存后启用` : `${plugin.name}将在保存后停用`);
    renderPluginModules();
    renderModule();
    renderClipboardSummary();
    return;
  }
  const toolSetting = event.target.dataset.toolSetting;
  if (toolSetting && Object.prototype.hasOwnProperty.call(TOOL_SETTINGS, toolSetting)) {
    const tools = pluginConfig("tools");
    if (!tools) return;
    tools.settings ||= {};
    tools.settings[toolSetting] = event.target.checked;
    markDirty();
    return;
  }
  const coreField = event.target.dataset.coreField;
  if (coreField) {
    state.config.core ||= {};
    state.config.core[coreField] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    markDirty();
    return;
  }
  const shortcutScope = event.target.dataset.coreScopeShortcut;
  if (shortcutScope) {
    state.config.core ||= {};
    state.config.core.scopeShortcuts ||= { ...DEFAULT_SCOPE_SHORTCUTS };
    state.config.core.scopeShortcuts[shortcutScope] = event.target.value;
    markDirty();
    return;
  }
  const configField = event.target.dataset.configField;
  if (configField) {
    if (configField === "clipboardRetentionDays") {
      const clipboard = pluginConfig("clipboard");
      clipboard.settings ||= {};
      const days = Number(event.target.value);
      clipboard.settings.retentionDays = Number.isFinite(days) ? Math.max(0, Math.min(3650, Math.floor(days))) : 0;
    } else if (configField === "proxyAdapter") {
      const tools = pluginConfig("tools");
      if (!tools) return;
      tools.settings ||= {};
      tools.settings.proxyAdapter = PROXY_ADAPTERS.has(event.target.value) ? event.target.value : "auto";
    } else {
      return;
    }
    markDirty();
    renderClipboardSummary();
    return;
  }
  const nodeField = event.target.dataset.nodeField;
  if (nodeField) {
    const node = selectedNode();
    if (!node) return;
    const value = event.target.value;
    if (value.trim()) node[nodeField] = value;
    else delete node[nodeField];
    markDirty();
    const banner = $("#nodeEditor .selected-banner strong");
    if (nodeField === "title" && banner) banner.textContent = value || "未命名节点";
    return;
  }
  const memoField = event.target.dataset.memoField;
  if (memoField) {
    const items = materializeMemoItems();
    const memo = items.find((item) => item.id === state.selectedMemoId);
    if (!memo) return;
    memo[memoField] = memoField === "tags"
      ? event.target.value.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean)
      : event.target.value;
    markDirty();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "diagnosticsEnabled") return toggleDiagnostics(event);
  if (event.target.dataset.configField === "proxyAdapter") {
    const tools = pluginConfig("tools");
    if (!tools) return;
    tools.settings ||= {};
    tools.settings.proxyAdapter = PROXY_ADAPTERS.has(event.target.value) ? event.target.value : "auto";
    markDirty();
    return;
  }
  if (!event.target.dataset.memoField) return;
  if (event.target.dataset.memoField === "category") {
    const memo = materializeMemoItems().find((item) => item.id === state.selectedMemoId);
    if (memo) memo.category = memoCategoryPath(memo);
  }
  renderMemoSettings();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    save();
  }
  if (event.key === "Escape") closeSettings();
});

const unsubscribeUpdateState = window.weborg.onUpdateState?.((nextState) => {
  state.appUpdate = nextState || state.appUpdate;
  renderAppUpdate();
});

window.addEventListener("beforeunload", (event) => {
  persistDraftNow();
  unsubscribeUpdateState?.();
  if (state.dirty && !allowUnload) {
    event.preventDefault();
    event.returnValue = "";
  }
});

Promise.all([window.weborg.listPlugins(), window.weborg.getConfig(), window.weborg.getClipboardStorageInfo(), window.weborg.getConfigPathInfo(), window.weborg.getUpdateState(), window.weborg.getDiagnosticsState()]).then(([plugins, config, clipboardStorage, configFile, appUpdate, diagnostics]) => {
  state.plugins = plugins || [];
  state.clipboardStorage = clipboardStorage;
  state.configFile = configFile;
  state.appUpdate = appUpdate || state.appUpdate;
  state.diagnostics = diagnostics || state.diagnostics;
  const loadedConfig = clone(normalizeConfig(config));
  state.savedConfig = clone(loadedConfig);
  const draft = readDraft(configFile);
  let draftConfig = null;
  try { if (draft?.config) draftConfig = clone(normalizeConfig(draft.config)); }
  catch (error) { console.warn("[FlowHub] 配置草稿已损坏，已忽略", error); }
  const hasConfigChanges = draftConfig && JSON.stringify(draftConfig) !== JSON.stringify(loadedConfig);
  const hasJsonChanges = draft?.mode === "json"
    && String(draft.jsonText || "").trim()
    && jsonTextDiffersFromConfig(draft.jsonText, draftConfig || loadedConfig);
  const sourceChanged = draft?.baseSignature && draft.baseSignature !== configSignature(loadedConfig);
  const recoveryMessage = `检测到 ${new Date(draft?.savedAt || Date.now()).toLocaleString()} 的未保存配置草稿${sourceChanged ? "，且正式配置在草稿保存后发生过变化" : ""}，是否恢复？`;
  if ((hasConfigChanges || hasJsonChanges) && window.confirm(recoveryMessage)) {
    state.config = draftConfig || loadedConfig;
    state.selectedId = String(draft.selectedId || "");
    state.selectedMemoId = String(draft.selectedMemoId || "");
    state.memoFilter = String(draft.memoFilter || "");
    state.expanded = new Set(Array.isArray(draft.expanded) ? draft.expanded : []);
    state.module = ["core", "web", "clipboard", "app", "memo", "tools"].includes(draft.module) ? draft.module : "core";
    state.mode = draft.mode === "json" ? "json" : "structure";
    state.dirty = Boolean(hasConfigChanges || hasJsonChanges);
    state.draftSavedAt = Number(draft.savedAt) || Date.now();
    render();
    applyInitialWebUrl();
    if (state.mode === "json" && draft.jsonText) {
      $("#jsonEditor").value = draft.jsonText;
      state.jsonDirty = jsonEditorDiffersFromConfig();
      state.dirty = !configsEqual(state.config, state.savedConfig) || state.jsonDirty;
      updateStatus();
    }
    toast("已恢复未保存的配置草稿");
    return;
  }
  if (draft) clearDraft(draftStorageKey(configFile));
  state.config = loadedConfig;
  state.jsonDirty = false;
  expandInitialTree();
  render();
  applyInitialWebUrl();
}).catch((error) => toast(`配置加载失败：${error.message}`, true));
