// FlowHub 桌面启动器 - 渲染层逻辑
const q = document.getElementById("q");
const resultsEl = document.getElementById("results");
const pinBtn = document.getElementById("pinBtn");
const settingsBtn = document.getElementById("settingsBtn");
const clipboardKindRow = document.getElementById("clipboardKindRow");
const scopeOrder = ["all", "web", "clipboard", "app"];
const clipboardKinds = ["all", "text", "image", "file"];

const state = { config: null, pageIndex: [], query: "", index: 0, scope: "all", clipboardKind: "all", clipboardResults: [], appResults: [], usageSections: { frequent: [], recent: [] }, expandedClipboard: new Set() };
let clipboardSearchToken = 0;
let appSearchToken = 0;
let usageSearchToken = 0;
let clipboardSearchTimer = null;

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
function pathText(page) {
  if (typeof page?.path === "string") return page.path;
  if (page?.breadcrumb) return String(page.breadcrumb);
  return (page?.path || []).map((x) => x.title).join(" / ");
}
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
    .filter((record) => {
      if (state.scope !== "clipboard" || state.clipboardKind === "all") return true;
      if (state.clipboardKind === "image") return record.kind === "image" || record.fileType === "image";
      if (state.clipboardKind === "file") return record.kind === "file" && record.fileType !== "image";
      return record.kind === state.clipboardKind;
    })
    .map((record) => ({ ...record, type: "clipboard" }));
}

function appMatches() {
  return state.appResults.map((application) => ({ ...application, type: "app" }));
}

function usageKey(item) {
  return `${item.type}:${item.usageKey || item.id || item.path || item.url || item.title}`;
}

function usageMatches() {
  if (state.query.trim() || state.scope === "clipboard") return [];
  const entries = [];
  for (const section of ["frequent", "recent"]) {
    for (const item of state.usageSections?.[section] || []) {
      if (state.scope === "app" && item.type !== "app") continue;
      if (state.scope === "web" && item.type !== "page") continue;
      entries.push({ ...item, usageSection: section });
    }
  }
  return entries;
}

function withoutUsageDuplicates(items, usedItems) {
  const used = new Set(usedItems.map(usageKey));
  return items.filter((item) => !used.has(usageKey(item)));
}

function matches() {
  const pages = pageMatches().map((page) => ({ ...page, type: "page" }));
  const clips = clipboardMatches();
  const apps = appMatches();
  const usages = usageMatches();
  if (state.scope === "web") {
    if (!state.query.trim()) return [...usages, ...withoutUsageDuplicates(pages, usages)].slice(0, 12);
    return pages;
  }
  if (state.scope === "clipboard") return clips;
  if (state.scope === "app") {
    if (!state.query.trim()) return [...usages, ...withoutUsageDuplicates(apps, usages)].slice(0, 12);
    return apps;
  }
  if (!state.query.trim()) {
    const regularLimit = usages.length ? 4 : 6;
    return [...usages.slice(0, usages.length ? 8 : 0), ...clips.slice(0, regularLimit), ...withoutUsageDuplicates(pages, usages).slice(0, regularLimit)].slice(0, 12);
  }
  const appResults = state.query.trim() ? apps.slice(0, 4) : [];
  const regularLimit = appResults.length ? 4 : 6;
  return [...clips.slice(0, regularLimit), ...appResults, ...pages.slice(0, regularLimit)].slice(0, 12);
}

function isExpandableClipboard(item) {
  if (item.kind !== "text") return false;
  const content = String(item.content || "");
  return content.length > 120 || content.split("\n").length > 3;
}

function clipboardFileIcon(type) {
  if (type === "folder") {
    return `<svg class="clipboard-file-symbol folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l1.8 2h9.2v9.7a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V6.5Z"/><path d="M3.5 8.5h17" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
  }
  if (type === "image") {
    return `<svg class="clipboard-file-symbol image" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.5" cy="9" r="1.5" fill="currentColor"/><path d="m5.5 17 4.2-4.2 2.8 2.4 2.3-2.2 3.7 4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/></svg>`;
  }
  return `<svg class="clipboard-file-symbol file" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l4 4v14.4H6z" fill="currentColor"/><path d="M14 2.8v4h4" fill="none" stroke="#17232d" stroke-linejoin="round" stroke-width="1.4"/><path d="M8.5 11h7M8.5 14h7M8.5 17h5" fill="none" stroke="#17232d" stroke-linecap="round" stroke-width="1.2"/></svg>`;
}

function clipboardFileTypeLabel(type) {
  return type === "folder" ? "文件夹" : type === "image" ? "图片" : "文件";
}

function usageSectionHeading(section) {
  const title = section === "frequent" ? "常用入口" : "最近使用";
  const hint = section === "frequent" ? "按热度" : "刚刚打开";
  return `<div class="usage-section"><span>${title}</span><small>${hint}</small></div>`;
}

function renderUsageSection(item, index, items) {
  if (!item.usageSection || (items[index - 1] && items[index - 1].usageSection === item.usageSection)) return "";
  return usageSectionHeading(item.usageSection);
}

function renderUsageTile(item, index) {
  const icon = item.type === "app"
    ? (item.iconUrl ? `<img src="${esc(item.iconUrl)}" loading="lazy" decoding="async" alt="" />` : "▣")
    : iconHtml(item);
  return `
    <div class="result usage-tile ${item.type === "app" ? "app" : "web"} ${index === state.index ? "active" : ""}" data-i="${index}" title="${esc(item.title || "")}">
      <span class="usage-tile-icon">${icon}</span>
      <span class="usage-tile-name">${esc(item.title || "未命名")}</span>
    </div>
  `;
}

function renderResults(items) {
  let html = "";
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (item.usageSection) {
      const start = index;
      const section = item.usageSection;
      while (index < items.length && items[index].usageSection === section) index += 1;
      html += usageSectionHeading(section);
      html += `<div class="usage-strip">${items.slice(start, index).map((entry, offset) => renderUsageTile(entry, start + offset)).join("")}</div>`;
      continue;
    }
    html += renderResult(item, index, items);
    index += 1;
  }
  return html;
}

function renderResult(item, index, items) {
  const usageSection = renderUsageSection(item, index, items);
  if (item.type === "app") {
    const icon = item.iconUrl
      ? `<img src="${esc(item.iconUrl)}" loading="lazy" decoding="async" alt="" />`
      : "▣";
    return `${usageSection}
      <div class="result app-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon app">${icon}</span>
        <span class="r-body">
          <span class="r-title">${esc(item.title || "未命名应用")}</span>
          <span class="r-meta"><span class="path">应用</span> · ${esc(item.path)}</span>
        </span>
        <span class="r-kind">应用</span>
      </div>
    `;
  }
  if (item.type === "clipboard") {
    const isFile = item.kind === "file";
    const fileType = isFile ? (item.fileType || "file") : "image";
    const content = String(item.content || "");
    const expandable = isExpandableClipboard(item);
    const expanded = expandable && state.expandedClipboard.has(item.id);
    const icon = item.kind === "image" && item.imageUrl
      ? `<img src="${esc(item.imageUrl)}" loading="lazy" decoding="async" alt="" />`
      : isFile && item.fileIconUrl
        ? `<img class="native-clipboard-icon" src="${esc(item.fileIconUrl)}" loading="lazy" decoding="async" alt="" />`
      : isFile ? clipboardFileIcon(fileType) : "▤";
    const iconMarkup = item.kind === "text" ? "" : `<span class="r-icon clipboard">${icon}</span>`;
    const preview = item.kind === "image"
      ? `图片 · ${formatBytes(item.size)}`
      : isFile
        ? (item.fileNames || []).join(" · ") || `${item.fileCount || 0} 个文件`
      : content;
    const fileLabel = (item.fileNames || []).join(" · ") || `${item.fileCount || 0} 个文件`;
    const titleClass = `r-title clipboard-title${expandable ? " expandable" : ""}${expanded ? " is-expanded" : ""}`;
    const title = item.kind === "image"
      ? (item.sourceName ? `图片 · ${esc(item.sourceName)}` : "剪切板图片")
      : isFile ? esc(fileLabel) : esc(preview || "空文本");
    const toggle = expandable
      ? `<button class="clipboard-toggle" type="button" data-clipboard-toggle="${item.id}" aria-expanded="${expanded}">${expanded ? "⌃ 收起" : "⌄ 展开"}</button>`
      : "";
    return `
      <div class="result clipboard-result ${index === state.index ? "active" : ""}" data-i="${index}">
        ${iconMarkup}
        <span class="r-body">
          <span class="${titleClass}">${title}</span>
          <span class="clipboard-meta-row">
            <span class="r-meta clipboard-meta"><span class="path">剪切板</span> · ${esc(formatTime(item.lastSeenAt))} · ${item.copyCount} 次 · ${esc(item.hash.slice(0, 12))}</span>
            ${toggle}
          </span>
        </span>
        <span class="r-kind clipboard">${item.kind === "image" ? "图片" : isFile ? clipboardFileTypeLabel(fileType) : "文本"}</span>
      </div>
    `;
  }
  return `${usageSection}
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
  if (!state.config) { resultsEl.innerHTML = `<div class="empty">配置加载中…</div>`; return; }
  const m = matches();
  if (!m.length) { resultsEl.innerHTML = `<div class="empty">没有匹配项</div>`; return; }
  resultsEl.innerHTML = renderResults(m);
  const a = resultsEl.querySelector(".result.active");
  if (a) a.scrollIntoView({ block: "nearest" });
}

function openUrl(url, page) {
  const norm = normalizeUrl(url);
  if (norm && window.weborg) {
    window.weborg.openUrl(norm, {
      type: "page",
      id: page?.id || page?.usageKey || norm,
      title: page?.title || norm,
      breadcrumb: pathText(page),
      icon: page?.icon || ""
    });
  }
}
function openLocal(action, usage) {
  if (window.weborg) window.weborg.openLocal(action, usage || {});
}
function choose(page) {
  if (page?.type === "clipboard") {
    if (document.documentElement.dataset.weborgReadonly === "true") return;
    window.weborg?.copyClipboard(page.id);
    return;
  }
  if (page?.type === "app") {
    openLocal(page.path, { type: "app", title: page.title, path: page.path });
    return;
  }
  const norm = normalizeUrl(page?.url);
  if (norm) openUrl(norm, page);
  else window.weborg && window.weborg.openLocal(page?.title || "");
}

function setScope(scope) {
  state.scope = scope;
  state.index = 0;
  document.querySelectorAll("[data-scope]").forEach((item) => item.classList.toggle("active", item.dataset.scope === scope));
  clipboardKindRow?.classList.toggle("visible", scope === "clipboard");
  render();
  void refreshClipboard();
  void refreshApps();
  void refreshUsage();
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
  void refreshClipboard();
}

// 更新配置（主进程每次呼出都会推送）
window.weborg.onConfig((cfg) => { setConfig(cfg); render(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); window.close(); }
  if (document.activeElement !== q) return;
  const m = matches();
  if (e.altKey && ["Backspace", "Delete"].includes(e.key)) {
    const selected = m[state.index];
    if (selected?.type === "clipboard" && document.documentElement.dataset.weborgReadonly !== "true") {
      window.weborg?.showClipboardMenu(selected.id);
      e.preventDefault();
      return;
    }
  }
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
    const records = await window.weborg?.searchClipboard(state.query, state.scope === "clipboard" ? state.clipboardKind : "all");
    if (token !== clipboardSearchToken) return;
    state.clipboardResults = records || [];
    render();
  } catch {}
}

async function refreshApps() {
  if (state.scope === "web") return;
  const token = ++appSearchToken;
  try {
    const applications = await window.weborg?.searchApps(state.query);
    if (token !== appSearchToken) return;
    state.appResults = applications || [];
    render();
  } catch {}
}

async function refreshUsage() {
  if (state.scope === "clipboard" || state.query.trim()) return;
  const token = ++usageSearchToken;
  try {
    const sections = await window.weborg?.searchUsage(state.scope);
    if (token !== usageSearchToken) return;
    state.usageSections = sections || { frequent: [], recent: [] };
    render();
  } catch {}
}

function queueClipboardRefresh(delay = 180) {
  clearTimeout(clipboardSearchTimer);
  clipboardSearchTimer = setTimeout(() => {
    void refreshClipboard();
    void refreshApps();
    void refreshUsage();
  }, delay);
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
window.weborg.onUsageUpdated(() => { void refreshUsage(); });
resultsEl.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".result");
  if (!row) return;
  const item = matches()[+row.dataset.i];
  if (item?.type !== "clipboard") return;
  e.preventDefault();
  if (document.documentElement.dataset.weborgReadonly === "true") return;
  void window.weborg?.showClipboardMenu(item.id);
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
Promise.all([window.weborg.getConfig(), window.weborg.searchClipboard(""), window.weborg.searchApps(""), window.weborg.searchUsage("all")]).then(([cfg, records, applications, usageSections]) => {
  setConfig(cfg);
  state.clipboardResults = records || [];
  state.appResults = applications || [];
  state.usageSections = usageSections || { frequent: [], recent: [] };
  render();
  focusSearch();
});
