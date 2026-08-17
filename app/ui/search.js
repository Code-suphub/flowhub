// Web Organization 桌面启动器 - 渲染层逻辑
const q = document.getElementById("q");
const resultsEl = document.getElementById("results");
const pinBtn = document.getElementById("pinBtn");
const settingsBtn = document.getElementById("settingsBtn");

const state = { config: null, query: "", index: 0, scope: "all", clipboardResults: [] };
let clipboardSearchToken = 0;

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
  return (nodes || []).flatMap((n) => {
    const p = [...path, { title: n.title, id: n.id, icon: n.icon }];
    const self = n.url ? [{ ...n, path: p }] : [];
    return [...self, ...flatten(n.children || [], p)];
  });
}
function allPages() { return flatten(state.config?.items || []); }
function pathText(page) { return (page.path || []).map((x) => x.title).join(" / "); }
function pageMatches() {
  const kw = state.query.trim().toLowerCase();
  let pages = allPages();
  if (!kw) return pages.slice(0, 12);
  return pages
    .map((p) => ({ ...p, hay: `${p.title || ""} ${p.url || ""} ${pathText(p)} ${noteOf(p)}`.toLowerCase() }))
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
  return [...pages.slice(0, 6), ...clips.slice(0, 6)].slice(0, 12);
}

function renderResult(item, index) {
  if (item.type === "clipboard") {
    const image = item.kind === "image" && item.imageUrl
      ? `<img src="${esc(item.imageUrl)}" alt="" />`
      : "▤";
    const preview = item.kind === "image"
      ? `图片 · ${formatBytes(item.size)}`
      : String(item.content || "").replace(/\s+/g, " ").slice(0, 120);
    return `
      <div class="result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon clipboard">${image}</span>
        <span class="r-body">
          <span class="r-title">${item.kind === "image" ? "剪切板图片" : esc(preview || "空文本")}</span>
          <span class="r-meta"><span class="path">剪切板</span> · ${esc(formatTime(item.lastSeenAt))} · ${item.copyCount} 次 · ${esc(item.hash.slice(0, 12))}</span>
        </span>
        <span class="r-kind clipboard">${item.kind === "image" ? "图片" : "文本"}</span>
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

// 更新配置（主进程每次呼出都会推送）
window.weborg.onConfig((cfg) => { state.config = cfg; render(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); window.close(); }
  if (document.activeElement !== q) return;
  const m = matches();
  if (e.key === "ArrowDown") { state.index = Math.min(state.index + 1, Math.max(0, m.length - 1)); render(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { state.index = Math.max(state.index - 1, 0); render(); e.preventDefault(); }
  else if (e.key === "Enter") { const p = m[state.index]; if (p) choose(p); }
});

async function refreshClipboard() {
  const token = ++clipboardSearchToken;
  try {
    const records = await window.weborg?.searchClipboard(state.query);
    if (token !== clipboardSearchToken) return;
    state.clipboardResults = records || [];
    render();
  } catch {}
}

q.addEventListener("input", () => {
  state.query = q.value;
  state.index = 0;
  render();
  void refreshClipboard();
});
settingsBtn?.addEventListener("click", () => window.weborg?.openSettings());
document.querySelectorAll("[data-scope]").forEach((button) => button.addEventListener("click", () => {
  state.scope = button.dataset.scope;
  state.index = 0;
  document.querySelectorAll("[data-scope]").forEach((item) => item.classList.toggle("active", item === button));
  render();
  void refreshClipboard();
}));
window.weborg.onClipboardUpdated(() => { void refreshClipboard(); });
resultsEl.addEventListener("click", (e) => { const row = e.target.closest(".result"); if (row) { const p = matches()[+row.dataset.i]; if (p) choose(p); } });
resultsEl.addEventListener("mousemove", (e) => { const row = e.target.closest(".result"); if (row) { const i = +row.dataset.i; if (i !== state.index) { state.index = i; render(); } } });

function focusSearch() { q?.focus(); q?.select(); }
window.focusSearch = focusSearch;

// 初始加载
Promise.all([window.weborg.getConfig(), window.weborg.searchClipboard("")]).then(([cfg, records]) => {
  state.config = cfg;
  state.clipboardResults = records || [];
  render();
  focusSearch();
});
