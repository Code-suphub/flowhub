const state = {
  config: null,
  selectedId: "",
  mode: "structure",
  dirty: false,
  expanded: new Set()
};

const $ = (selector) => document.querySelector(selector);
const clone = (value) => JSON.parse(JSON.stringify(value));
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

function iconHtml(node, className = "tree-icon") {
  const raw = String(node?.icon || "").trim();
  if (/^https?:\/\//i.test(raw)) {
    const simpleIcon = raw.match(/^https:\/\/cdn\.simpleicons\.org\/([^/?#]+)/i);
    const fallback = simpleIcon
      ? `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${encodeURIComponent(simpleIcon[1])}.svg`
      : "";
    return `<span class="${className}"><img src="${esc(raw)}" ${fallback ? `data-fallback="${esc(fallback)}"` : ""} referrerpolicy="no-referrer" alt="" /></span>`;
  }
  return `<span class="${className}">${esc(raw || "□")}</span>`;
}

function normalizeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("配置必须是 JSON 对象");
  if (!Array.isArray(config.items)) throw new Error("配置缺少 items 数组");
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
  visit(config.items);
  return config;
}

function nodeEntries(nodes = state.config?.items || [], level = 0, parent = null, result = []) {
  nodes.forEach((node, index) => {
    result.push({ node, level, parent, index });
    nodeEntries(node.children || [], level + 1, node, result);
  });
  return result;
}

function visibleNodeEntries(nodes = state.config?.items || [], level = 0, parent = null, result = []) {
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
  visit(state.config?.items || []);
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
    <div class="tree-row ${node.id === state.selectedId ? "active" : ""}" style="--depth:${level}" data-node-id="${esc(node.id)}" role="button" tabindex="0">
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

function renderAppFields() {
  $("#appTitle").value = state.config?.app?.title || "";
  $("#appSubtitle").value = state.config?.app?.subtitle || "";
  $("#probeEnabled").checked = state.config?.probe?.enabled !== false;
  $("#clipboardRetentionDays").value = Number(state.config?.clipboard?.retentionDays ?? 30);
  $("#clipboardEnabled").checked = state.config?.clipboard?.enabled !== false;
}

function syncJson() {
  $("#jsonEditor").value = JSON.stringify(state.config || {}, null, 2);
}

function renderMode() {
  $("#structurePanel").classList.toggle("hidden", state.mode !== "structure");
  $("#jsonPanel").classList.toggle("hidden", state.mode !== "json");
  document.querySelectorAll(".mode-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === state.mode));
}

function render() {
  ensureSelection();
  renderAppFields();
  renderTree();
  renderSelected();
  syncJson();
  renderMode();
  updateStatus();
}

function addRoot() {
  const node = newNode();
  state.config.items.push(node);
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
  const siblings = context.parent ? (context.parent.children ||= []) : state.config.items;
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
  const siblings = context.parent ? context.parent.children : state.config.items;
  siblings.splice(context.index, 1);
  state.expanded.delete(context.node.id);
  state.selectedId = siblings[context.index]?.id || siblings[context.index - 1]?.id || context.parent?.id || "";
  markDirty();
  render();
}

function moveSelected(direction) {
  const context = selectedContext();
  if (!context) return;
  const siblings = context.parent ? context.parent.children : state.config.items;
  const nextIndex = context.index + direction;
  if (nextIndex < 0 || nextIndex >= siblings.length) return toast("已经到当前层级的边界");
  [siblings[context.index], siblings[nextIndex]] = [siblings[nextIndex], siblings[context.index]];
  markDirty("排序已调整");
  render();
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
    state.dirty = false;
    render();
    toast("配置已保存，Web 端和搜索浮窗会使用最新内容");
  } catch (error) {
    toast(error.message, true);
  }
}

async function reload() {
  if (state.dirty && !window.confirm("当前有未保存修改，确定重新读取并丢弃这些修改吗？")) return;
  try {
    state.config = await window.weborg.getConfig();
    normalizeConfig(state.config);
    state.dirty = false;
    render();
    toast("已重新读取 config.json");
  } catch (error) {
    toast(error.message, true);
  }
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
  document.querySelectorAll("[data-module]").forEach((item) => {
    const active = item.dataset.module === module;
    item.classList.toggle("active", active);
    const hint = item.querySelector("small");
    if (hint && item.dataset.module === "clipboard") hint.textContent = active ? "当前模块" : "记录中";
    if (hint && item.dataset.module === "web") hint.textContent = active ? "当前模块" : "网页入口";
  });

  if (module === "clipboard") {
    $("#clipboardSettings")?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => $("#clipboardRetentionDays")?.focus({ preventScroll: true }), 180);
  } else {
    $("#tree")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
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

document.addEventListener("input", (event) => {
  if (event.target.id === "jsonEditor") {
    markDirty("JSON 已修改");
    return;
  }
  const configField = event.target.dataset.configField;
  if (configField) {
    state.config.app ||= {};
    if (configField === "probeEnabled") {
      state.config.probe ||= {};
      state.config.probe.enabled = event.target.checked;
    } else if (configField === "clipboardEnabled") {
      state.config.clipboard ||= {};
      state.config.clipboard.enabled = event.target.checked;
    } else if (configField === "clipboardRetentionDays") {
      state.config.clipboard ||= {};
      const days = Number(event.target.value);
      state.config.clipboard.retentionDays = Number.isFinite(days) ? Math.max(0, Math.min(3650, Math.floor(days))) : 0;
    } else {
      state.config.app[configField] = event.target.value;
    }
    markDirty();
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

window.weborg.getConfig().then((config) => {
  state.config = clone(normalizeConfig(config));
  expandAll();
  render();
}).catch((error) => toast(`配置加载失败：${error.message}`, true));
