const ACTIVE_TABS_KEY = "weborg.active-tabs";
const PAGE_HISTORY_KEY = "weborg.page-history";
const FLOATING_STATE_KEY = "weborg.floating-state";

async function readConfig() {
  const sources = [
    "http://localhost:4173/api/config",
    "http://127.0.0.1:4173/api/config",
    chrome.runtime.getURL("config.json")
  ];
  let lastError = null;

  for (const source of sources) {
    try {
      const response = await fetch(source, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`读取配置失败：${lastError?.message || "未知错误"}`);
}

function httpOrigin(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : "";
  } catch {
    return "";
  }
}

async function getActiveTabs() {
  const result = await chrome.storage.session.get({ [ACTIVE_TABS_KEY]: {} });
  return result[ACTIVE_TABS_KEY];
}

async function setActiveTab(tabId, page) {
  const activeTabs = await getActiveTabs();
  activeTabs[tabId] = page;
  await chrome.storage.session.set({ [ACTIVE_TABS_KEY]: activeTabs });
}

async function getFloatingStates() {
  const result = await chrome.storage.session.get({ [FLOATING_STATE_KEY]: {} });
  return result[FLOATING_STATE_KEY];
}

async function setFloatingState(tabId, open) {
  const states = await getFloatingStates();
  if (typeof open === "object" && open) {
    states[tabId] = { mode: open.mode === "open" ? "open" : "minimized" };
  } else {
    states[tabId] = { mode: open ? "open" : "minimized" };
  }
  await chrome.storage.session.set({ [FLOATING_STATE_KEY]: states });
}

async function getPageHistory() {
  const result = await chrome.storage.local.get({ [PAGE_HISTORY_KEY]: {} });
  return result[PAGE_HISTORY_KEY];
}

async function saveLocation(nodeId, url, scrollY = 0) {
  const origin = httpOrigin(url);
  if (!nodeId || !origin) return;
  const history = await getPageHistory();
  history[nodeId] = {
    url,
    scrollY: Math.max(0, Math.round(Number(scrollY) || 0)),
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [PAGE_HISTORY_KEY]: history });
}

async function rememberTabLocation(tabId, url, scrollY) {
  const activeTabs = await getActiveTabs();
  const active = activeTabs[tabId];
  if (!active || httpOrigin(url) !== active.origin) return;

  const history = await getPageHistory();
  const existing = history[active.nodeId];
  const nextScrollY = typeof scrollY === "number"
    ? scrollY
    : existing?.url === url ? existing.scrollY : 0;
  await saveLocation(active.nodeId, url, nextScrollY);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "weborg:get-config") {
    readConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "weborg:get-last-location") {
    getPageHistory()
      .then((history) => sendResponse({ ok: true, location: history[message.nodeId] || null }))
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "weborg:get-floating-state") {
    const tabId = sender.tab?.id;
    getFloatingStates()
      .then((states) => {
        const current = states[tabId];
        const mode = current?.mode || (current?.open ? "open" : "minimized");
        sendResponse({ ok: true, open: mode === "open", state: { mode } });
      })
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "weborg:set-floating-state") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, reason: "无法识别当前标签页" });
      return false;
    }
    setFloatingState(tabId, message.mode ? { mode: message.mode } : message.open)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "weborg:activate-page") {
    const tabId = sender.tab?.id;
    const fallbackOrigin = httpOrigin(message.fallbackUrl || message.url);
    if (!tabId || !message.nodeId || !fallbackOrigin) {
      sendResponse({ ok: false, reason: "无法记录当前网页" });
      return false;
    }
    setActiveTab(tabId, { nodeId: message.nodeId, origin: fallbackOrigin })
      .then(async () => {
        const history = await getPageHistory();
        if (!history[message.nodeId]) await saveLocation(message.nodeId, message.url, 0);
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "weborg:remember-location") {
    const tabId = sender.tab?.id;
    if (!tabId || !message.url) {
      sendResponse({ ok: true });
      return false;
    }
    rememberTabLocation(tabId, message.url, message.scrollY)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  if (message?.type === "weborg:get-restore-location") {
    const tabId = sender.tab?.id;
    Promise.all([getActiveTabs(), getPageHistory()])
      .then(([activeTabs, history]) => {
        const active = activeTabs[tabId];
        const location = active && httpOrigin(message.url) === active.origin ? history[active.nodeId] : null;
        sendResponse({ ok: true, location: location?.url === message.url ? location : null });
      })
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }

  return false;
});

function canInject(url = "") {
  return /^https?:\/\//i.test(url);
}

async function injectFloating(tabId, url) {
  if (!tabId || !canInject(url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/floating.js"]
    });
  } catch {
    // Chrome does not allow injection on restricted pages or pages without host permission.
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  injectFloating(tabId, tab.url);
  rememberTabLocation(tabId, tab.url).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  Promise.all([getActiveTabs(), getFloatingStates()])
    .then(([activeTabs, floatingStates]) => {
      let changed = false;
      if (tabId in activeTabs) {
        delete activeTabs[tabId];
        changed = true;
      }
      if (tabId in floatingStates) {
        delete floatingStates[tabId];
        changed = true;
      }
      if (!changed) return;
      return chrome.storage.session.set({
        [ACTIVE_TABS_KEY]: activeTabs,
        [FLOATING_STATE_KEY]: floatingStates
      });
    })
    .catch(() => {});
});
