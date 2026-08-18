// Web Organization 桌面启动器 - 渲染层逻辑
const q = document.getElementById("q");
const resultsEl = document.getElementById("results");
const pinBtn = document.getElementById("pinBtn");
const settingsBtn = document.getElementById("settingsBtn");
const scopeOrder = ["all", "web", "clipboard"];

const state = { config: null, pageIndex: [], query: "", index: 0, scope: "all", clipboardResults: [] };
let clipboardSearchToken = 0;
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
  return state.clipboardResults.map((record) => ({ ...record, type: "clipboard" }));
}

function matches() {
  const pages = pageMatches().map((page) => ({ ...page, type: "page" }));
  const clips = clipboardMatches();
  if (state.scope === "web") return pages;
  if (state.scope === "clipboard") return clips;
  return [...clips.slice(0, 6), ...pages.slice(0, 6)].slice(0, 12);
}

function renderResult(item, index) {
  if (item.type === "clipboard") {
    const isFile = item.kind === "file";
    const image = item.kind === "image" && item.imageUrl
      ? `<img src="${esc(item.imageUrl)}" loading="lazy" decoding="async" alt="" />`
      : isFile ? "📄" : "▤";
    const preview = item.kind === "image"
      ? `图片 · ${formatBytes(item.size)}`
      : isFile
        ? (item.fileNames || []).join(" · ") || `${item.fileCount || 0} 个文件`
      : String(item.content || "").replace(/\s+/g, " ").slice(0, 120);
    const detail = isFile ? ` · ${esc(preview.slice(0, 120))}` : "";
    return `
      <div class="result clipboard-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon clipboard">${image}</span>
        <span class="r-body">
          <span class="r-title clipboard-title">${item.kind === "image" ? "剪切板图片" : isFile ? `剪切板文件 · ${item.fileCount || 0} 个` : esc(preview || "空文本")}</span>
          <span class="r-meta clipboard-meta"><span class="path">剪切板</span>${detail} · ${esc(formatTime(item.lastSeenAt))} · ${item.copyCount} 次 · ${esc(item.hash.slice(0, 12))}</span>
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

function setScope(scope) {
  state.scope = scope;
  state.index = 0;
  document.querySelectorAll("[data-scope]").forEach((item) => item.classList.toggle("active", item.dataset.scope === scope));
  render();
  void refreshClipboard();
}

// 更新配置（主进程每次呼出都会推送）
window.weborg.onConfig((cfg) => { setConfig(cfg); render(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); window.close(); }
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
window.weborg.onClipboardUpdated(() => { queueClipboardRefresh(80); });
resultsEl.addEventListener("click", (e) => { const row = e.target.closest(".result"); if (row) { const p = matches()[+row.dataset.i]; if (p) choose(p); } });
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
