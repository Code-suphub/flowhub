const state = {
  config: null,
  plugins: [],
  configFile: null,
  clipboardStorage: null,
  selectedId: "",
  mode: "structure",
  module: "core",
  dirty: false,
  expanded: new Set(),
  draggingId: ""
};

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
    return `<span class="${className} image-icon"><img src="${esc(raw)}" ${fallback ? `data-fallback="${esc(fallback)}"` : ""} referrerpolicy="no-referrer" alt="" /></span>`;
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
  if (!config.plugins || typeof config.plugins !== "object") throw new Error("配置缺少 plugins 对象");
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

function expandAll() {
  state.expanded = new Set(nodeEntries().filter(({ node }) => node.children?.length).map(({ node }) => node.id));
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

function markDirty(message = "有未保存修改") {
  state.dirty = true;
  const status = $("#status");
  status.textContent = message;
  status.classList.add("dirty");
  const saveButton = $("#saveBtn");
  if (saveButton) saveButton.disabled = false;
}

let toastTimer;
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
  status.textContent = state.dirty ? "有未保存修改" : "已保存";
  status.classList.toggle("dirty", state.dirty);
  $("#saveBtn").disabled = !state.dirty;
}

function renderTree() {
  const tree = $("#tree");
  const entries = visibleNodeEntries();
  if (!entries.length) {
    tree.innerHTML = `<div class="tree-empty">还没有目录节点。<br />点击右上角 ＋ 添加一级目录。</div>`;
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
      <div class="form-grid">
        <div class="field"><label>标题</label><input data-node-field="title" value="${esc(node.title || "")}" /></div>
        <div class="field"><label>节点 ID</label><input readonly value="${esc(node.id)}" /><div class="field-hint">ID 用于目录定位，JSON 模式可手动调整。</div></div>
        <div class="field wide"><label>页面链接 URL</label><input data-node-field="url" value="${esc(node.url || "")}" placeholder="https://example.com/" /><div class="field-hint">没有 URL 时作为目录节点；有 URL 时可直接打开，也可以同时保留子节点。</div></div>
        <div class="field"><label>图标（Emoji 或图片 URL）</label><input data-node-field="icon" value="${esc(node.icon || "")}" placeholder="☁ 或 https://..." /></div>
        <div class="field"><label>强调色</label><input data-node-field="accent" value="${esc(node.accent || "#4bd0b8")}" placeholder="#4bd0b8" /></div>
        <div class="field wide"><label>备注</label><textarea data-node-field="note" placeholder="可选：显示在搜索结果或页面说明中">${esc(node.note || "")}</textarea></div>
      </div>
    </div>
  `;
  bindIconFallbacks();
}

function renderSettingsFields() {
  $("#coreHotkey").value = state.config?.core?.hotkey || "Alt+Space";
  $("#coreLaunchAtLogin").checked = state.config?.core?.launchAtLogin === true;
  renderConfigPath();
  $("#clipboardRetentionDays").value = Number(pluginConfig("clipboard")?.settings?.retentionDays ?? 30);
  renderClipboardStorage();
  renderClipboardSummary();
}

function renderConfigPath() {
  const configuredPath = String(state.config?.core?.configPath || "").trim();
  const resolvedPath = configuredPath || state.configFile?.defaultPath || state.configFile?.resolvedPath || "项目目录/config.json";
  $("#coreConfigPath").value = resolvedPath;
  $("#coreConfigPathHint").textContent = state.configFile?.available === false
    ? "浏览器仅用于预览，请在 Electron App 中选择或打开配置文件。"
    : "保存后切换到新的配置文件；原文件会保留。";
}

function renderClipboardStorage() {
  const configuredPath = String(pluginConfig("clipboard")?.settings?.storagePath || "").trim();
  const resolvedPath = configuredPath || state.clipboardStorage?.defaultPath || state.clipboardStorage?.resolvedPath || "Electron 用户数据目录/clipboard";
  $("#clipboardStoragePath").value = resolvedPath;
  $("#clipboardStorageMode").textContent = configuredPath ? "自定义目录" : "默认目录";
  $("#clipboardStorageSummary").textContent = resolvedPath;
  $("#clipboardStorageHint").textContent = state.clipboardStorage?.available === false
    ? "浏览器仅用于预览，请在 Electron App 中选择或打开目录。"
    : "保存配置后切换位置；现有记录会安全复制到新的空目录。";
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

function syncJson() {
  $("#jsonEditor").value = JSON.stringify(state.config || {}, null, 2);
}

function renderMode() {
  $("#structurePanel").classList.toggle("hidden", state.mode !== "structure");
  $("#jsonPanel").classList.toggle("hidden", state.mode !== "json");
  document.querySelectorAll(".mode-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === state.mode));
}

function renderModule() {
  document.querySelectorAll("[data-module-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.modulePanel !== state.module);
  });
  document.querySelectorAll("[data-module]").forEach((item) => {
    const active = item.dataset.module === state.module;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
}

function renderPluginModules() {
  const plugins = [...state.plugins].sort((a, b) => Number(a.settingsOrder || a.order) - Number(b.settingsOrder || b.order));
  const coreButton = `<button class="module-button${state.module === "core" ? " active" : ""}" type="button" data-module="core"><span>通用设置</span><small>${state.module === "core" ? "当前模块" : "App 配置"}</small></button>`;
  const pluginButtons = plugins.map((plugin) => {
    const moduleId = plugin.settingsPanel || "";
    const active = moduleId === state.module;
    const disabled = !plugin.available || !moduleId;
    const hint = active ? "当前模块" : !plugin.available ? "未安装" : plugin.enabled ? plugin.settingsHint : "已停用";
    return `<div class="plugin-module-row"><button class="module-button${active ? " active" : ""}" type="button" ${moduleId ? `data-module="${esc(moduleId)}"` : ""} ${disabled ? "disabled" : ""}><span>${esc(plugin.settingsName || plugin.name)}</span><small>${esc(hint || "")}</small></button><label class="plugin-enable" title="${plugin.available ? (plugin.enabled ? "停用插件" : "启用插件") : "插件未安装"}"><input type="checkbox" data-plugin-toggle="${esc(plugin.id)}" ${plugin.enabled ? "checked" : ""} ${plugin.available ? "" : "disabled"} aria-label="启用${esc(plugin.name)}" /></label></div>`;
  }).join("");
  $("#moduleSwitcher").innerHTML = coreButton + pluginButtons;
}

function render() {
  ensureSelection();
  renderPluginModules();
  renderSettingsFields();
  renderTree();
  renderSelected();
  syncJson();
  renderMode();
  renderModule();
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
    if (state.mode === "json") state.config = clone(readJsonEditor());
    normalizeConfig(state.config);
    const result = await window.weborg.saveConfig(state.config);
    if (!result?.ok) throw new Error(result?.reason || "保存失败");
    state.config = result.config || state.config;
    [state.plugins, state.clipboardStorage, state.configFile] = await Promise.all([window.weborg.listPlugins(), window.weborg.getClipboardStorageInfo(), window.weborg.getConfigPathInfo()]);
    state.dirty = false;
    render();
    toast(result.pluginFailures?.length ? `配置已保存，但 ${result.pluginFailures.length} 个插件启动失败` : "配置已保存，插件状态已生效", Boolean(result.pluginFailures?.length));
  } catch (error) {
    toast(error.message, true);
  }
}

async function reload() {
  if (state.dirty && !window.confirm("当前有未保存修改，确定重新读取并丢弃这些修改吗？")) return;
  try {
    [state.plugins, state.config, state.clipboardStorage, state.configFile] = await Promise.all([window.weborg.listPlugins(), window.weborg.getConfig(), window.weborg.getClipboardStorageInfo(), window.weborg.getConfigPathInfo()]);
    normalizeConfig(state.config);
    state.dirty = false;
    render();
    toast("已重新读取 config.json");
  } catch (error) {
    toast(error.message, true);
  }
}

async function openAccessibilitySettings() {
  const result = await window.weborg.openAccessibilitySettings();
  if (!result?.ok) toast(result?.reason || "无法打开系统设置", true);
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

function handleAction(action) {
  if (action === "add-root") return addRoot();
  if (action === "expand-all") { expandAll(); return renderTree(); }
  if (action === "collapse-all") { collapseAll(); return renderTree(); }
  if (action === "add-child") return addChild();
  if (action === "add-sibling") return addSibling();
  if (action === "delete") return deleteSelected();
  if (action === "move-up") return moveSelected(-1);
  if (action === "move-down") return moveSelected(1);
  if (action === "save") return save();
  if (action === "reload") return reload();
  if (action === "open-accessibility-settings") return openAccessibilitySettings();
  if (action === "choose-config-path") return chooseConfigPath();
  if (action === "open-config-path") return openConfigPath();
  if (action === "reset-config-path") return resetConfigPath();
  if (action === "choose-clipboard-storage") return chooseClipboardStorage();
  if (action === "open-clipboard-storage") return openClipboardStorage();
  if (action === "reset-clipboard-storage") return resetClipboardStorage();
  if (action === "close") return window.close();
  if (action === "format-json") {
    try { $("#jsonEditor").value = JSON.stringify(readJsonEditor(), null, 2); toast("JSON 已格式化"); }
    catch (error) { toast(error.message, true); }
  }
  if (action === "apply-json") {
    try {
      state.config = clone(readJsonEditor());
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
  if (!["core", "web", "clipboard", "app"].includes(module)) return;
  state.module = module;
  renderPluginModules();
  renderModule();
}

document.addEventListener("click", (event) => {
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
    if (mode === "json") syncJson();
    renderMode();
  }
  const nodeId = event.target.closest("[data-node-id]")?.dataset.nodeId;
  if (nodeId) {
    state.selectedId = nodeId;
    renderTree();
    renderSelected();
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
    markDirty("JSON 已修改");
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
  const coreField = event.target.dataset.coreField;
  if (coreField) {
    state.config.core ||= {};
    state.config.core[coreField] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
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
    const banner = $(".selected-banner strong");
    if (nodeField === "title" && banner) banner.textContent = value || "未命名节点";
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    save();
  }
  if (event.key === "Escape") window.close();
});

Promise.all([window.weborg.listPlugins(), window.weborg.getConfig(), window.weborg.getClipboardStorageInfo(), window.weborg.getConfigPathInfo()]).then(([plugins, config, clipboardStorage, configFile]) => {
  state.plugins = plugins || [];
  state.config = clone(normalizeConfig(config));
  state.clipboardStorage = clipboardStorage;
  state.configFile = configFile;
  expandAll();
  render();
}).catch((error) => toast(`配置加载失败：${error.message}`, true));
