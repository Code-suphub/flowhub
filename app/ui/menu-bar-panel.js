const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const list = document.querySelector("#items");
const notice = document.querySelector("#notice");
const refreshButton = document.querySelector("#refresh");
let items = [];
let order = [];
let busy = false;
let loading = false;
let trusted = false;

function status(text, error = false) {
  notice.textContent = text;
  notice.title = text;
  notice.classList.toggle("error", error);
}

function render() {
  const focusedId = document.activeElement?.dataset.windowId;
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  for (const item of items) {
    const name = item.displayName || item.accessibilityLabel || item.title || item.ownerName || "未命名图标";
    const shown = item.section !== "alwaysHidden";
    const row = document.createElement("div");
    row.className = "item";
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.textContent = name.slice(0, 1);
    glyph.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "copy";
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name;
    const detail = document.createElement("span");
    detail.className = "state";
    detail.textContent = !item.hideable ? "系统固定" : !shown ? "始终隐藏" : item.section === "hidden" ? "随箭头展开 / 收起" : "显示";
    copy.append(label, detail);
    const toggle = document.createElement("button");
    toggle.className = "switch";
    toggle.type = "button";
    toggle.dataset.windowId = String(item.windowId);
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(shown));
    toggle.setAttribute("aria-label", name + "显示");
    toggle.disabled = busy || loading || !trusted || !item.hideable;
    toggle.addEventListener("click", () => change(item, shown));
    row.append(glyph, copy, toggle);
    list.append(row);
  }
  list.scrollTop = scrollTop;
  if (focusedId) list.querySelector('[data-window-id="' + Number(focusedId) + '"]')?.focus({ preventScroll: true });
  refreshButton.disabled = busy || loading;
  document.querySelector("#summary").textContent = items.length + " 个图标 · " + items.filter(item => item.section === "alwaysHidden").length + " 个隐藏";
}

async function refresh(resetOrder = false) {
  if (loading) return;
  loading = true;
  render();
  try {
    const result = await invoke("list_menu_bar_items");
    if (result.ok === false) throw new Error(result.reason || "读取失败");
    trusted = result.trusted;
    const fresh = result.items || [];
    // Use actual menu-bar order on opening; keep rows stable during batch edits.
    if (resetOrder) order = [];
    const available = new Set(fresh.map(item => item.windowId));
    order = order.filter(id => available.has(id));
    for (const item of fresh) if (!order.includes(item.windowId)) order.push(item.windowId);
    const byId = new Map(fresh.map(item => [item.windowId, item]));
    items = order.map(id => byId.get(id));
    status(!result.organizerEnabled ? "请先启用隐藏分区" : !trusted ? "需要辅助功能权限，请在设置中授权" : !items.length ? "没有发现菜单栏图标" : "");
  } finally {
    loading = false;
    render();
  }
}

async function change(item, hidden) {
  if (busy) return;
  busy = true;
  render();
  status("正在" + (hidden ? "隐藏" : "显示") + "…");
  try {
    const result = await invoke("set_menu_bar_item_hidden", { windowId: item.windowId, hidden });
    // Re-read the actual layout, including after a failed attempt.
    await new Promise(resolve => setTimeout(resolve, 180));
    await refresh();
    if (!result.ok) throw new Error(result.reason || "操作未完成");
    const actual = items.find(candidate => candidate.windowId === item.windowId);
    if (!actual || (actual.section === "alwaysHidden") !== hidden) throw new Error("图标位置尚未更新，请重试");
    status("");
  } catch (error) {
    status(error.message || String(error), true);
  } finally {
    busy = false;
    render();
  }
}

async function open() {
  if (busy) return;
  try { await refresh(true); } catch (error) { status(error.message || String(error), true); }
}
refreshButton.addEventListener("click", open);
document.querySelector("#close").addEventListener("click", () => invoke("toggle_menu_bar_panel"));
document.addEventListener("keydown", event => {
  if (event.key === "Escape") void invoke("toggle_menu_bar_panel");
});
await listen("menu-bar-panel-opened", open);
await open();
