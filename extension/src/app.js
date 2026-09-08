import "./config-contract.js";

const app = document.querySelector("#app");
const surface = document.body.dataset.surface || "newtab";

const state = {
  config: null,
  root: "",
  level2: "",
  level3: "",
  search: "",
  searchIndex: 0,
  openTarget: "current"
};
let searchCatalogSource = null;
let searchCatalog = [];

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function flatten(nodes, path = []) {
  return (nodes || []).flatMap((node) => {
    const nextPath = [...path, { id: node.id, title: node.title }];
    const current = node.url ? [{ ...node, path: nextPath }] : [];
    return [...current, ...flatten(node.children || [], nextPath)];
  });
}

function allItems() {
  return state.config?.items || [];
}

function rootNode() {
  return allItems().find((item) => item.id === state.root) || allItems()[0] || { children: [] };
}

function level2Node() {
  const root = rootNode();
  return (root.children || []).find((item) => item.id === state.level2) || (root.children || [])[0] || { children: [] };
}

function level3Node() {
  const level2 = level2Node();
  return (level2.children || []).find((item) => item.id === state.level3) || null;
}

function syncDefaults() {
  const root = rootNode();
  state.root = root.id || "";
  const level2 = level2Node();
  state.level2 = level2.id || "";
  const level3Exists = (level2.children || []).some((item) => item.id === state.level3);
  if (!level3Exists) state.level3 = "";
}

function pathText(node) {
  return (node?.path || []).map((item) => item.title).join(" / ");
}

function noteText(node) {
  return String(node?.note || "").trim();
}

function normalizeUrl(url) {
  const value = String(url || "").trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(value)) return `https://${value}`;
  return "";
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

async function openUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    showToast("这个链接不是 HTTP 页面，插件不会打开 mock 演示地址。");
    return;
  }

  if (globalThis.chrome?.tabs) {
    if (state.openTarget === "new") {
      await chrome.tabs.create({ url: normalized });
    } else {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await chrome.tabs.update(tabs[0].id, { url: normalized });
      else await chrome.tabs.create({ url: normalized });
    }
    if (surface === "popup") window.close();
    return;
  }

  if (state.openTarget === "new") window.open(normalized, "_blank", "noopener,noreferrer");
  else location.href = normalized;
}

async function openExtensionSurface(targetSurface) {
  if (targetSurface === "popup" && globalThis.chrome?.action?.openPopup) {
    await chrome.action.openPopup();
    return;
  }

  if (targetSurface === "side" && globalThis.chrome?.sidePanel) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.sidePanel.open({ tabId: tabs[0]?.id });
    return;
  }

  const page = targetSurface === "popup" ? "popup.html" : "newtab.html";
  const url = globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL(page) : page;
  if (globalThis.chrome?.tabs) await chrome.tabs.create({ url });
  else window.open(url, "_blank", "noopener,noreferrer");
}

function searchMatches() {
  const keyword = state.search.trim().toLowerCase();
  if (!keyword) return [];
  if (searchCatalogSource !== state.config) {
    searchCatalogSource = state.config;
    searchCatalog = flatten(allItems()).map((page) => ({
      ...page,
      haystack: `${page.title || ""} ${page.url || ""} ${pathText(page)} ${noteText(page)}`.toLowerCase()
    }));
  }
  return searchCatalog
    .filter((page) => page.haystack.includes(keyword))
    .slice(0, 10);
}

function renderRootRail() {
  return `
    <aside class="root-rail">
      <div class="root-list">
        ${allItems().map((item) => `
          <button class="root-button ${item.id === state.root ? "active" : ""}" data-root="${escapeHtml(item.id)}" title="${escapeHtml(item.title || item.id)}">
            <span class="root-icon">${escapeHtml(item.icon || "□")}</span>
            <span class="root-label">${escapeHtml(item.title || item.id)}</span>
          </button>
        `).join("")}
      </div>
    </aside>
  `;
}

function renderLevelTabs() {
  return (rootNode().children || []).map((item) => `
    <button class="level-tab ${item.id === state.level2 ? "active" : ""}" data-level2="${escapeHtml(item.id)}">
      <span>${escapeHtml(item.title || item.id)}</span>
      ${item.children?.length ? `<span class="chevron"></span>` : ""}
    </button>
  `).join("");
}

function renderSearchResults() {
  const matches = searchMatches();
  if (!state.search.trim()) return "";
  if (!matches.length) return `<div class="search-results open"><div class="result-button">没有匹配项</div></div>`;
  return `
    <div class="search-results open" role="listbox">
      ${matches.map((page, index) => `
        <button class="result-button ${index === state.searchIndex ? "active" : ""}" data-open="${escapeHtml(page.url)}" role="option" aria-selected="${index === state.searchIndex}">
          <strong>${escapeHtml(page.title || page.id)}</strong>
          <small>${escapeHtml(pathText(page))}</small>
          ${noteText(page) ? `<small class="result-note">${escapeHtml(noteText(page))}</small>` : ""}
        </button>
      `).join("")}
    </div>
  `;
}

function updateSearchResults() {
  const input = app.querySelector("#searchInput");
  const current = app.querySelector(".search-results");
  const html = renderSearchResults();
  if (!html) {
    current?.remove();
    return;
  }
  if (current) current.outerHTML = html;
  else input?.insertAdjacentHTML("afterend", html);
}

function renderNodeCards(nodes, emptyTitle = "当前没有下级页面", emptyBody = "可以在 Web 管理台配置。") {
  if (!nodes?.length) return `<div class="node-card"><strong>${escapeHtml(emptyTitle)}</strong><small>${escapeHtml(emptyBody)}</small></div>`;
  return nodes.map((node) => {
    const pageLike = Boolean(node.url);
    const children = node.children?.length || 0;
    const note = noteText(node);
    return `
      <button class="node-card" ${pageLike ? `data-open="${escapeHtml(node.url)}"` : `data-drill="${escapeHtml(node.id)}"`}>
        <span>
          <strong>${escapeHtml(node.title || node.id)}</strong>
          <small class="node-meta">${escapeHtml(pageLike ? "打开页面" : `${children} 个下级`)}</small>
          ${note ? `<small class="node-note">${escapeHtml(note)}</small>` : ""}
        </span>
        <span class="dot" style="background:${escapeHtml(node.accent || "#25b8a4")}"></span>
      </button>
    `;
  }).join("");
}

function renderContent() {
  const l2 = level2Node();
  const l3 = level3Node();
  const selected = l3 || l2;
  const selectedAsPage = selected?.url ? [{ ...selected, path: [{ title: rootNode().title }, { title: l2.title }, ...(l3 ? [{ title: l3.title }] : [])] }] : [];
  const children = selected?.children || [];
  const cards = [...selectedAsPage, ...(l3 ? children : [])];
  const emptyTitle = l2.children?.length && !l3 ? "请选择上方三级目录" : "当前没有下级页面";
  const emptyBody = l2.children?.length && !l3 ? "也可以直接搜索需要打开的页面。" : "可以在 Web 管理台配置。";

  return `
    <section class="directory-panel">
      <div class="panel-head">
        <div>
          <h2>${escapeHtml(selected?.title || l2.title || "请选择目录")}</h2>
          <div class="path">${escapeHtml([rootNode().title, l2.title, l3?.title].filter(Boolean).join(" / "))}</div>
          ${noteText(selected) ? `<div class="panel-note">${escapeHtml(noteText(selected))}</div>` : ""}
        </div>
        <button class="primary-button" data-open="${escapeHtml(selected?.url || "")}" ${selected?.url ? "" : "disabled"}>打开当前</button>
      </div>
      ${l2.children?.length ? `
        <div class="node-grid">
          ${l2.children.map((node) => `
            <button class="node-card" data-level3="${escapeHtml(node.id)}">
              <span>
                <strong>${escapeHtml(node.title || node.id)}</strong>
                <small class="node-meta">${node.children?.length || 0} 个下级${node.url ? "，可直接打开" : ""}</small>
                ${noteText(node) ? `<small class="node-note">${escapeHtml(noteText(node))}</small>` : ""}
              </span>
              <span class="chevron"></span>
            </button>
          `).join("")}
        </div>
      ` : ""}
      <div class="node-grid">${renderNodeCards(cards, emptyTitle, emptyBody)}</div>
    </section>
  `;
}

function render() {
  syncDefaults();
  app.innerHTML = `
    <main class="workspace">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">W</div>
          <div class="brand-title">
            <strong>${escapeHtml(state.config?.app?.title || "FlowHub")}</strong>
            <span>Chrome Extension · ${surface === "side" ? "Side Panel" : surface === "popup" ? "Popup" : "New Tab"}</span>
          </div>
        </div>
        <div class="top-actions">
          <button class="icon-button" data-surface-open="side" title="打开侧边栏">侧</button>
          <button class="icon-button" data-surface-open="popup" title="打开弹出页">弹</button>
          <button class="icon-button" data-surface-open="newtab" title="打开新标签">页</button>
          <button class="icon-button" data-open="http://localhost:4173/" title="打开 Web 管理台">设</button>
        </div>
      </header>
      ${renderRootRail()}
      <section class="main">
        <div class="search-row">
          <div class="utility-row">
            <div class="open-mode" aria-label="打开方式">
              <button class="${state.openTarget === "current" ? "active" : ""}" data-open-target="current">当前标签</button>
              <button class="${state.openTarget === "new" ? "active" : ""}" data-open-target="new">新标签</button>
            </div>
          </div>
          <input class="search" id="searchInput" value="${escapeHtml(state.search)}" placeholder="搜索页面、路径或链接" autocomplete="off" />
          ${renderSearchResults()}
        </div>
        <nav class="level-tabs">${renderLevelTabs()}</nav>
        <div class="content">${renderContent()}</div>
      </section>
      <div class="toast" id="toast"></div>
    </main>
  `;
  const input = document.querySelector("#searchInput");
  input.selectionStart = input.selectionEnd = input.value.length;
}

async function loadConfig() {
  const liveSources = location.protocol.startsWith("http")
    ? [`${location.origin}/api/config`]
    : ["http://localhost:4173/api/config", "http://127.0.0.1:4173/api/config"];
  const sources = [...liveSources, "config.json"];
  state.config = await FlowHubLegacyCatalog.readSources(sources);
  state.root = state.config.items?.[0]?.id || "";
  syncDefaults();
}

async function loadPreferences() {
  if (globalThis.chrome?.storage?.local) {
    const result = await chrome.storage.local.get({ openTarget: "current" });
    state.openTarget = result.openTarget === "new" ? "new" : "current";
    return;
  }
  state.openTarget = localStorage.getItem("weborg.openTarget") === "new" ? "new" : "current";
}

function saveOpenTarget(value) {
  state.openTarget = value === "new" ? "new" : "current";
  if (globalThis.chrome?.storage?.local) chrome.storage.local.set({ openTarget: state.openTarget });
  else localStorage.setItem("weborg.openTarget", state.openTarget);
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;

  if (target.dataset.surfaceOpen) {
    openExtensionSurface(target.dataset.surfaceOpen).catch((error) => showToast(error.message));
    return;
  }

  if (target.dataset.openTarget) {
    saveOpenTarget(target.dataset.openTarget);
    render();
    return;
  }

  if (target.dataset.root) {
    state.root = target.dataset.root;
    state.level2 = "";
    state.level3 = "";
    render();
    return;
  }

  if (target.dataset.level2) {
    state.level2 = target.dataset.level2;
    state.level3 = "";
    render();
    return;
  }

  if (target.dataset.level3) {
    state.level3 = target.dataset.level3;
    render();
    return;
  }

  if (target.dataset.drill) {
    state.level3 = target.dataset.drill;
    render();
    return;
  }

  if (target.dataset.open !== undefined) {
    openUrl(target.dataset.open).catch((error) => showToast(error.message));
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "searchInput") return;
  state.search = event.target.value;
  state.searchIndex = 0;
  updateSearchResults();
});

document.addEventListener("keydown", (event) => {
  const inputFocused = document.activeElement?.id === "searchInput";
  const matches = searchMatches();
  if (!inputFocused || !matches.length) return;
  if (event.key === "ArrowDown") {
    state.searchIndex = Math.min(state.searchIndex + 1, matches.length - 1);
    updateSearchResults();
    event.preventDefault();
  }
  if (event.key === "ArrowUp") {
    state.searchIndex = Math.max(state.searchIndex - 1, 0);
    updateSearchResults();
    event.preventDefault();
  }
  if (event.key === "Enter") {
    openUrl(matches[state.searchIndex]?.url).catch((error) => showToast(error.message));
    event.preventDefault();
  }
  if (event.key === "Escape") {
    state.search = "";
    render();
  }
});

Promise.all([loadConfig(), loadPreferences()])
  .then(render)
  .catch((error) => {
    app.innerHTML = `<main class="workspace"><section class="content"><div class="directory-panel"><h2>配置加载失败</h2><p>${escapeHtml(error.message)}</p></div></section></main>`;
  });
