// Web Organization 桌面启动器 - 渲染层逻辑
const q = document.getElementById("q");
const resultsEl = document.getElementById("results");
const pinBtn = document.getElementById("pinBtn");
const settingsBtn = document.getElementById("settingsBtn");
const clipboardKindRow = document.getElementById("clipboardKindRow");
const clipboardContextMenu = document.getElementById("clipboardContextMenu");
const deleteClipboardBtn = document.getElementById("deleteClipboardBtn");
const scopeOrder = ["all", "web", "clipboard"];
const clipboardKinds = ["all", "text", "image", "file"];

const state = { config: null, pageIndex: [], query: "", index: 0, scope: "all", clipboardKind: "all", clipboardResults: [], expandedClipboard: new Set() };
let clipboardSearchToken = 0;
let clipboardSearchTimer = null;
let contextClipboardId = null;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function normalizeUrl(url) {
  const v = String(url || "").trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(v)) return `https://${v}`;
  return "";
}
const noteOf = (n) => String(n?.note || "").trim();

function iconHtml(n) {
  const raw = String(n?.icon || "").trim();
  if (/^https?:\/\//i.test(raw)) return `<img src="${esc(raw)}" alt="" />`;
  return esc(raw || "□");
}
function flatten(nodes, path = []) {
  const pages = [];
  (nodes || []).forEach((n) => {
    const p = [...path, { title: n.title, id: n.id, icon: n.icon }];
    if (n.url) {
      const page = { ...n, path: p };
      page.hay = `${page.title || ""} ${page.url || ""} ${pathText(page)} ${noteOf(page)}`.toLowerCase();
      pages.push(page);
    }
    pages.push(...flatten(n.children || [], p));
  });
  return pages;
}
function setConfig(config) {
  state.config = config;
  state.pageIndex = flatten(config?.items || []);
}
function allPages() { return state.pageIndex; }
function pathText(page) { return (page.path || []).map((x) => x.title).join(" / "); }
function pageMatches() {
  const kw = state.query.trim().toLowerCase();
  let pages = allPages();
  if (!kw) return pages.slice(0, 12);
  return pages
    .filter((p) => p.hay.includes(kw))
    .slice(0, 12);
}

function formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function clipboardMatches() {
  return state.clipboardResults
    .filter((record) => state.scope !== "clipboard" || state.clipboardKind === "all" || record.kind === state.clipboardKind)
    .map((record) => ({ ...record, type: "clipboard" }));
}

function matches() {
  const pages = pageMatches().map((page) => ({ ...page, type: "page" }));
  const clips = clipboardMatches();
  if (state.scope === "web") return pages;
  if (state.scope === "clipboard") return clips;
  return [...clips.slice(0, 6), ...pages.slice(0, 6)].slice(0, 12);
}

function isExpandableClipboard(item) {
  if (item.kind !== "text") return false;
  const content = String(item.content || "");
  return content.length > 120 || content.split("\n").length > 3;
}

function renderResult(item, index) {
  if (item.type === "clipboard") {
    const isFile = item.kind === "file";
    const content = String(item.content || "");
    const expandable = isExpandableClipboard(item);
    const expanded = expandable && state.expandedClipboard.has(item.id);
    const image = item.kind === "image" && item.imageUrl
      ? `<img src="${esc(item.imageUrl)}" loading="lazy" decoding="async" alt="" />`
      : isFile ? "📄" : "▤";
    const preview = item.kind === "image"
      ? `图片 · ${formatBytes(item.size)}`
      : isFile
        ? (item.fileNames || []).join(" · ") || `${item.fileCount || 0} 个文件`
      : content;
    const fileLabel = (item.fileNames || []).join(" · ") || `${item.fileCount || 0} 个文件`;
    const titleClass = `r-title clipboard-title${expandable ? " expandable" : ""}${expanded ? " is-expanded" : ""}`;
    const title = item.kind === "image"
      ? (item.sourceName ? `图片 · ${esc(item.sourceName)}` : "剪切板图片")
      : isFile ? `文件 · ${esc(fileLabel)}` : esc(preview || "空文本");
    const toggle = expandable
      ? `<button class="clipboard-toggle" type="button" data-clipboard-toggle="${item.id}" aria-expanded="${expanded}">${expanded ? "⌃ 收起" : "⌄ 展开"}</button>`
      : "";
    return `
      <div class="result clipboard-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon clipboard">${image}</span>
        <span class="r-body">
          <span class="${titleClass}">${title}</span>
          <span class="clipboard-meta-row">
            <span class="r-meta clipboard-meta"><span class="path">剪切板</span> · ${esc(formatTime(item.lastSeenAt))} · ${item.copyCount} 次 · ${esc(item.hash.slice(0, 12))}</span>
            ${toggle}
          </span>
        </span>
        <span class="r-kind clipboard">${item.kind === "image" ? "图片" : isFile ? "文件" : "文本"}</span>
      </div>
    `;
  }
  return `
    <div class="result ${index === state.index ? "active" : ""}" data-i="${index}">
      <span class="r-icon">${iconHtml(item)}</span>
      <span class="r-body">
        <span class="r-title">${esc(item.title || item.id)}</span>
        <span class="r-meta"><span class="path">${esc(pathText(item))}</span>
          ${noteOf(item) ? ` · ${esc(noteOf(item))}` : ""} · ${esc(normalizeUrl(item.url) || item.url)}
        </span>
      </span>
      <span class="r-kind">${normalizeUrl(item.url) ? "网页" : "无链接"}</span>
    </div>
  `;
}

function render() {
  hideClipboardContextMenu();
  if (!state.config) { resultsEl.innerHTML = `<div class="empty">配置加载中…</div>`; return; }
  const m = matches();
  if (!m.length) { resultsEl.innerHTML = `<div class="empty">没有匹配项</div>`; return; }
  resultsEl.innerHTML = m.map(renderResult).join("");
  const a = resultsEl.querySelector(".result.active");
  if (a) a.scrollIntoView({ block: "nearest" });
}

function openUrl(url) {
  const norm = normalizeUrl(url);
  if (norm && window.weborg) window.weborg.openUrl(norm);
}
function openLocal(action) {
  if (window.weborg) window.weborg.openLocal(action);
}
function choose(page) {
  if (page?.type === "clipboard") {
    window.weborg?.copyClipboard(page.id);
    return;
  }
  const norm = normalizeUrl(page?.url);
  if (norm) openUrl(norm);
  else window.weborg && window.weborg.openLocal(page?.title || "");
}

function hideClipboardContextMenu() {
  contextClipboardId = null;
  clipboardContextMenu?.classList.remove("visible");
  clipboardContextMenu?.setAttribute("aria-hidden", "true");
}

function showClipboardContextMenu(event, item) {
  if (!clipboardContextMenu) return;
  contextClipboardId = item.id;
  clipboardContextMenu.classList.add("visible");
  clipboardContextMenu.setAttribute("aria-hidden", "false");
  const rect = clipboardContextMenu.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const top = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  clipboardContextMenu.style.left = `${Math.max(8, left)}px`;
  clipboardContextMenu.style.top = `${Math.max(8, top)}px`;
}

function setScope(scope) {
  state.scope = scope;
  state.index = 0;
  document.querySelectorAll("[data-scope]").forEach((item) => item.classList.toggle("active", item.dataset.scope === scope));
  clipboardKindRow?.classList.toggle("visible", scope === "clipboard");
  render();
  void refreshClipboard();
}

function setClipboardKind(kind) {
  if (!clipboardKinds.includes(kind)) return;
  state.clipboardKind = kind;
  state.index = 0;
  document.querySelectorAll("[data-clipboard-kind]").forEach((item) => {
    const active = item.dataset.clipboardKind === kind;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  render();
}

// 更新配置（主进程每次呼出都会推送）
window.weborg.onConfig((cfg) => { setConfig(cfg); render(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (contextClipboardId !== null) { hideClipboardContextMenu(); e.preventDefault(); return; }
    e.preventDefault(); window.close();
  }
  if (document.activeElement !== q) return;
  const m = matches();
  if (e.key === "ArrowDown") { state.index = Math.min(state.index + 1, Math.max(0, m.length - 1)); render(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { state.index = Math.max(state.index - 1, 0); render(); e.preventDefault(); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const atStart = q.selectionStart === 0 && q.selectionEnd === 0;
    const atEnd = q.selectionStart === q.value.length && q.selectionEnd === q.value.length;
    const canSwitch = !q.value || (e.key === "ArrowLeft" ? atStart : atEnd);
    if (!canSwitch) return;
    const current = scopeOrder.indexOf(state.scope);
    const offset = e.key === "ArrowRight" ? 1 : -1;
    const next = (current + offset + scopeOrder.length) % scopeOrder.length;
    setScope(scopeOrder[next]);
    e.preventDefault();
  }
  else if (e.key === "Enter") { const p = m[state.index]; if (p) choose(p); }
});

async function refreshClipboard() {
  if (state.scope === "web") return;
  const token = ++clipboardSearchToken;
  try {
    const records = await window.weborg?.searchClipboard(state.query);
    if (token !== clipboardSearchToken) return;
    state.clipboardResults = records || [];
    render();
  } catch {}
}

function queueClipboardRefresh(delay = 180) {
  clearTimeout(clipboardSearchTimer);
  clipboardSearchTimer = setTimeout(() => { void refreshClipboard(); }, delay);
}

q.addEventListener("input", () => {
  state.query = q.value;
  state.index = 0;
  render();
  queueClipboardRefresh();
});
settingsBtn?.addEventListener("click", () => window.weborg?.openSettings());
document.querySelectorAll("[data-scope]").forEach((button) => button.addEventListener("click", () => setScope(button.dataset.scope)));
document.querySelectorAll("[data-clipboard-kind]").forEach((button) => button.addEventListener("click", () => setClipboardKind(button.dataset.clipboardKind)));
window.weborg.onClipboardUpdated(() => { queueClipboardRefresh(80); });
document.addEventListener("mousedown", (e) => {
  if (!clipboardContextMenu?.contains(e.target)) hideClipboardContextMenu();
});
document.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".result");
  if (!row || !resultsEl.contains(row)) return;
  const item = matches()[+row.dataset.i];
  if (item?.type !== "clipboard") return;
  e.preventDefault();
  showClipboardContextMenu(e, item);
});
deleteClipboardBtn?.addEventListener("click", async () => {
  const id = contextClipboardId;
  hideClipboardContextMenu();
  if (!id || !window.confirm("删除这条剪切板记录？\n应用保存的图片副本会被删除，但不会删除原始文件。")) return;
  const result = await window.weborg?.deleteClipboard(id);
  if (!result?.ok) {
    window.alert(result?.reason || "删除失败");
    return;
  }
  state.clipboardResults = state.clipboardResults.filter((item) => item.id !== id);
  state.index = Math.min(state.index, Math.max(0, matches().length - 1));
  render();
});
resultsEl.addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-clipboard-toggle]");
  if (toggle) {
    const id = Number(toggle.dataset.clipboardToggle);
    if (state.expandedClipboard.has(id)) state.expandedClipboard.delete(id);
    else state.expandedClipboard.add(id);
    render();
    return;
  }
  const row = e.target.closest(".result");
  if (row) { const p = matches()[+row.dataset.i]; if (p) choose(p); }
});
resultsEl.addEventListener("mousemove", (e) => { const row = e.target.closest(".result"); if (row) { const i = +row.dataset.i; if (i !== state.index) { state.index = i; render(); } } });

function focusSearch() { q?.focus(); q?.select(); }
window.focusSearch = focusSearch;

// 初始加载
Promise.all([window.weborg.getConfig(), window.weborg.searchClipboard("")]).then(([cfg, records]) => {
  setConfig(cfg);
  state.clipboardResults = records || [];
  render();
  focusSearch();
});
