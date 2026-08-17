// Web Organization 桌面启动器 - 渲染层逻辑
const q = document.getElementById("q");
const resultsEl = document.getElementById("results");
const pinBtn = document.getElementById("pinBtn");

const state = { config: null, query: "", index: 0 };

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
function matches() {
  const kw = state.query.trim().toLowerCase();
  let pages = allPages();
  if (!kw) return pages.slice(0, 12);
  return pages
    .map((p) => ({ ...p, hay: `${p.title || ""} ${p.url || ""} ${pathText(p)} ${noteOf(p)}`.toLowerCase() }))
    .filter((p) => p.hay.includes(kw))
    .slice(0, 12);
}

function render() {
  if (!state.config) { resultsEl.innerHTML = `<div class="empty">配置加载中…</div>`; return; }
  const m = matches();
  if (!m.length) { resultsEl.innerHTML = `<div class="empty">没有匹配项</div>`; return; }
  resultsEl.innerHTML = m.map((p, i) => `
    <div class="result ${i === state.index ? "active" : ""}" data-i="${i}">
      <span class="r-icon">${iconHtml(p)}</span>
      <span class="r-body">
        <span class="r-title">${esc(p.title || p.id)}</span>
        <span class="r-meta"><span class="path">${esc(pathText(p))}</span>
          ${noteOf(p) ? ` · ${esc(noteOf(p))}` : ""} · ${esc(normalizeUrl(p.url) || p.url)}
        </span>
      </span>
      <span class="r-kind">${normalizeUrl(p.url) ? "网页" : "无链接"}</span>
    </div>
  `).join("");
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

q.addEventListener("input", () => { state.query = q.value; state.index = 0; render(); });
resultsEl.addEventListener("click", (e) => { const row = e.target.closest(".result"); if (row) { const p = matches()[+row.dataset.i]; if (p) choose(p); } });
resultsEl.addEventListener("mousemove", (e) => { const row = e.target.closest(".result"); if (row) { const i = +row.dataset.i; if (i !== state.index) { state.index = i; render(); } } });

function focusSearch() { q?.focus(); q?.select(); }
window.focusSearch = focusSearch;

// 初始加载
window.weborg.getConfig().then((cfg) => { state.config = cfg; render(); focusSearch(); });
