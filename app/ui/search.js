// FlowHub 桌面启动器 - 渲染层逻辑
const q = document.getElementById("q");
const resultsEl = document.getElementById("results");
const pinBtn = document.getElementById("pinBtn");
const settingsBtn = document.getElementById("settingsBtn");
const clipboardKindRow = document.getElementById("clipboardKindRow");
const scopeRow = document.getElementById("scopeRow");
const keyboardHint = document.getElementById("keyboardHint");
const actionStatus = document.getElementById("actionStatus");
const versionBadge = document.getElementById("versionBadge");
let scopeOrder = ["all"];
const clipboardKinds = ["all", "text", "image", "file"];
const CLIPBOARD_PAGE_SIZE = 30;
const PLUGIN_PAGE_SIZE = 30;
const APP_PAGE_SIZE = 12;
const DEFAULT_SCOPE_SHORTCUTS = { all: "Shift+1", clipboard: "Shift+2", app: "Shift+3", web: "Shift+4", memo: "Shift+5" };

const state = { config: null, plugins: [], webResults: [], webHasMore: true, webLoading: false, query: "", index: 0, scope: "all", clipboardKind: "all", clipboardResults: [], clipboardHasMore: true, clipboardLoading: false, clipboardLoadedQuery: null, appResults: [], appHasMore: true, appLoading: false, appLoadedQuery: null, appLoadedLimit: 0, memoResults: [], memoHasMore: true, memoLoading: false, memoLoadedQuery: null, webLoadedQuery: null, usageSections: { frequent: [], recent: [] }, usageLoadedScope: null, emptyResults: { clipboard: [], app: [], web: [], memo: [] }, expandedClipboard: new Set(), usageColumn: 0, dnsResult: null, dnsIpResults: {}, cloudflareResult: null,  ipResult: null, proxyResult: null };
let clipboardSearchToken = 0;
let appSearchToken = 0;
let appIconSearchToken = 0;
let webSearchToken = 0;
let memoSearchToken = 0;
let usageSearchToken = 0;
let allScopeRefreshToken = 0;
let dnsSearchToken = 0;
const dnsIpCache = new Map();
let ipSearchToken = 0;
let proxySearchToken = 0;
let clipboardSearchTimer = null;
let scopeTabHeld = false;
let scopeTabUsedWithArrow = false;
let scopeTabTapOffset = 1;
let initialized = false;
let searchInputComposing = false;
let searchCompositionEndedAt = -Infinity;
let actionStatusTimer = null;
let dnsSearchTimer = null;
let ipSearchTimer = null;
let proxySearchTimer = null;
let inputRenderFrame = null;
let webInputSearchFrame = null;
let lastResultsHtml = "";
let webIconTimer = null;
let showUncachedWebIcons = false;
const loadedWebIcons = new Set();
const failedWebIcons = new Set();

function renderVersion(update) {
  if (!versionBadge) return;
  const version = String(update?.currentVersion || "").trim();
  const text = version ? `v${version}` : "浏览器预览";
  const hasUpdate = update?.status === "available" || update?.status === "downloaded";
  versionBadge.textContent = version ? `v${version.split("-")[0]}${version.includes("-local") ? " · 本地版" : ""}` : text;
  versionBadge.classList.toggle("update", hasUpdate);
  versionBadge.title = hasUpdate ? `发现正式版 v${update.availableVersion || "新版本"}` : `当前应用版本：${text}`;
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function normalizeUrl(url) {
  const v = String(url || "").trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(v)) return `https://${v}`;
  return "";
}

function calculateExpression(input) {
  const source = String(input || "").replace(/\s+/g, "");
  if (!source || !/[+\-*/%]/.test(source) || !/^[0-9+\-*/%().]+$/.test(source)) return null;
  let cursor = 0;
  const peek = () => source[cursor] || "";
  const consume = () => source[cursor++];
  const parsePrimary = () => {
    if (peek() === "(") {
      consume();
      const value = parseAddSub();
      if (consume() !== ")") throw new Error("括号不匹配");
      return value;
    }
    const start = cursor;
    while (/[0-9.]/.test(peek())) consume();
    if (start === cursor) throw new Error("缺少数字");
    const value = Number(source.slice(start, cursor));
    if (!Number.isFinite(value)) throw new Error("数字无效");
    return value;
  };
  const parseUnary = () => {
    if (peek() === "+") { consume(); return parseUnary(); }
    if (peek() === "-") { consume(); return -parseUnary(); }
    return parsePrimary();
  };
  const parseMulDiv = () => {
    let value = parseUnary();
    while (/[*/%]/.test(peek())) {
      const operator = consume();
      const right = parseUnary();
      if ((operator === "/" || operator === "%") && right === 0) throw new Error("不能除以零");
      value = operator === "*" ? value * right : operator === "/" ? value / right : value % right;
    }
    return value;
  };
  const parseAddSub = () => {
    let value = parseMulDiv();
    while (/[+\-]/.test(peek())) {
      const operator = consume();
      const right = parseMulDiv();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  try {
    const value = parseAddSub();
    if (cursor !== source.length || !Number.isFinite(value)) return null;
    const rounded = Number(value.toPrecision(12));
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  } catch {
    return null;
  }
}

function calculationSuggestion() {
  const expression = state.query.trim();
  const result = calculateExpression(expression);
  return result === null ? null : { type: "calculation", expression, result, id: `calculation:${expression}` };
}

function formatTimestamp(value, unit) {
  const raw = BigInt(value);
  const milliseconds = unit === "s" ? raw * 1000n : unit === "ms" ? raw : unit === "us" ? raw / 1000n : raw / 1000000n;
  const numericMilliseconds = Number(milliseconds);
  if (!Number.isFinite(numericMilliseconds)) return null;
  const date = new Date(numericMilliseconds);
  const year = date.getUTCFullYear();
  if (date.getTime() < Date.UTC(2000, 0, 1) || date.getTime() > Date.UTC(2100, 0, 1) || year < 2000 || year > 2100) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function timestampSuggestion() {
  const expression = state.query.trim();
  if (!/^(?:\d{10}|\d{13}|\d{16}|\d{19})$/.test(expression)) return null;
  const unit = expression.length === 10 ? "s" : expression.length === 13 ? "ms" : expression.length === 16 ? "us" : "ns";
  const result = formatTimestamp(expression, unit);
  return result ? { type: "timestamp", expression, result, unit, id: `timestamp:${expression}` } : null;
}

function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function jwtSuggestion() {
  const expression = state.query.trim();
  if (expression.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(expression)) return null;
  try {
    const header = JSON.parse(decodeBase64Url(expression.split(".")[0]));
    const payload = JSON.parse(decodeBase64Url(expression.split(".")[1]));
    if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return null;
    return { type: "jwt", expression, result: JSON.stringify({ header, payload }, null, 2), header, payload, id: `jwt:${expression}` };
  } catch {
    return null;
  }
}

function ipSuggestion() {
  const expression = state.query.trim();
  const address = expression.replace(/^ip\s+/i, "").trim();
  if (!address || /^ip$/i.test(expression)) return null;
  const ipv4 = address.split(".").length === 4
    && address.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  const ipv6Segments = address.split(":");
  const ipv6NonEmpty = ipv6Segments.filter(Boolean);
  const ipv6Compressed = address.includes("::");
  const ipv6 = address.includes(":")
    && /^[0-9a-f:]+$/i.test(address)
    && address.length <= 45
    && (address.match(/::/g) || []).length <= 1
    && ipv6NonEmpty.length <= 8
    && (ipv6Compressed ? ipv6NonEmpty.length < 8 : ipv6Segments.length === 8)
    && ipv6NonEmpty.every((segment) => segment.length <= 4);
  if (!ipv4 && !ipv6) return null;
  const details = state.ipResult?.address === address ? state.ipResult : null;
  return { type: "ip", expression, address, result: address, details, id: `ip:${address}` };
}

function isPrivateIp(address) {
  const value = String(address || "").toLowerCase();
  if (value === "::1" || value === "localhost" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:") || value.startsWith("ff")) return true;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || parts[0] >= 224;
}

function proxySuggestion() {
  const expression = state.query.trim();
  if (!/^(?:代理|代理信息|proxy|proxy\s+info)$/i.test(expression)) return null;
  return { type: "proxy", expression, details: state.proxyResult, result: "代理信息", id: "proxy-info" };
}

function dnsSuggestion() {
  const expression = state.query.trim();
  if (!/^dns\s+/i.test(expression)) return null;
  const input = expression.replace(/^dns\s+/i, "").trim();
  if (!input) return null;
  let hostname = input;
  try {
    hostname = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`).hostname;
  } catch {
    return null;
  }
  if (!hostname || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(hostname)) return null;
  const resolved = state.dnsResult?.hostname === hostname ? state.dnsResult : null;
  return { type: "dns", expression, hostname, result: hostname, answers: resolved?.answers || [], id: `dns:${hostname}` };
}

function dnsSuggestions() {
  const base = dnsSuggestion();
  if (!base) return [];
  const records = base.answers || [];
  return [
    ["IPv4", 1],
    ["IPv6", 28],
    ["CNAME", 5]
  ].map(([family, type]) => {
    const addresses = records.filter((answer) => Number(answer.type) === type);
    return {
      ...base,
      family,
      answers: addresses,
      id: `dns:${base.hostname}:${family}`
    };
  });
}

function dnsRecordType(value) {
  return ({ 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT", 28: "AAAA" })[Number(value)] || String(value || "?");
}

function dnsIpGeoEnabled() {
  return pluginEnabled("tools") && state.config?.plugins?.tools?.settings?.dnsIpGeo !== false;
}

function cloudflareSuggestion() {
  const base = dnsSuggestion();
  if (!base) return null;
  const records = state.dnsResult?.hostname === base.hostname ? state.dnsResult.answers || [] : [];
  const cnameEvidence = records
    .filter((answer) => Number(answer.type) === 5 && /cloudflare|cdnjs|workers.dev/i.test(String(answer.data || "")))
    .map((answer) => String(answer.data || ""));
  const details = state.cloudflareResult?.hostname === base.hostname ? state.cloudflareResult : null;
  return { ...base, type: "cloudflare", details, cnameEvidence, id: `cloudflare:${base.hostname}` };
}

function dnsPublicAddresses(answers) {
  return [...new Set((answers || [])
    .filter((answer) => [1, 28].includes(Number(answer.type)) && answer.data && !isPrivateIp(answer.data))
    .map((answer) => String(answer.data).trim()))].slice(0, 2);
}

async function enrichDnsIpResults(hostname, answers, token) {
  if (!dnsIpGeoEnabled() || typeof window.weborg?.lookupIp !== "function") return;
  const addresses = dnsPublicAddresses(answers);
  if (!addresses.length) return;
  const pending = [];
  const next = { ...state.dnsIpResults };
  for (const address of addresses) {
    const cached = dnsIpCache.get(address);
    if (cached && cached.expiresAt > Date.now()) {
      next[address] = cached.details;
      continue;
    }
    pending.push(window.weborg.lookupIp(address)
      .then((details) => {
        const value = details || { error: "查询失败" };
        dnsIpCache.set(address, { details: value, expiresAt: Date.now() + 10 * 60 * 1000 });
        return [address, value];
      })
      .catch(() => {
        const value = { error: "查询失败" };
        dnsIpCache.set(address, { details: value, expiresAt: Date.now() + 30 * 1000 });
        return [address, value];
      }));
  }
  if (!pending.length) {
    if (token === dnsSearchToken && state.dnsResult?.hostname === hostname) {
      state.dnsIpResults = next;
      render();
    }
    return;
  }
  const results = await Promise.all(pending);
  if (token !== dnsSearchToken || state.dnsResult?.hostname !== hostname) return;
  for (const [address, details] of results) next[address] = details;
  state.dnsIpResults = next;
  render();
}

function toolContext() {
  return {query:state.query, queryNow:()=>state.query, api:window.weborg,
    enabled:key=>pluginEnabled("tools") && !["clipboard","memo"].includes(state.scope) && state.config?.plugins?.tools?.settings?.[key] !== false,
    render:()=>render({preserveScroll:true}), copy:copyText, status:showActionStatus};
}
for (const [id, suggestions] of [
  ["dns",dnsSuggestions], ["cloudflare",()=>[cloudflareSuggestion()]],
  ["proxy",()=>[proxySuggestion()]],
  ["timestamp",()=>[timestampSuggestion()]], ["jwt",()=>[jwtSuggestion()]],
  ["ip",()=>[ipSuggestion()]], ["calculator",()=>[calculationSuggestion()]]
]) window.FlowHubTools.register({id,suggestions});
function toolSuggestions() {
  return window.FlowHubTools.suggestions(toolContext()).filter(Boolean);
}
function portableQueryCommand(item) {
  if (item.type === "dns") return `dig +time=2 +tries=1 '${item.hostname}' ${item.family === "IPv4" ? "A" : item.family === "IPv6" ? "AAAA" : "CNAME"}`;
  if (item.type === "ip") return `curl --fail --connect-timeout 3 --max-time 8 'https://ipapi.co/${item.address}/json/'`;
  return null;
}

async function copyText(text) {
  if (document.documentElement.dataset.weborgReadonly === "true") throw new Error("浏览器预览不能修改剪贴板");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(String(text));
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = String(text);
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("复制失败");
}

function showActionStatus(message) {
  if (!actionStatus) return;
  clearTimeout(actionStatusTimer);
  actionStatus.textContent = message;
  actionStatusTimer = setTimeout(() => { actionStatus.textContent = ""; }, 1200);
}
function webAddSuggestion(pages) {
  const url = normalizeUrl(state.query);
  if (!url || pages.some((page) => normalizeUrl(page.url) === url)) return null;
  return {
    type: "web-add",
    pluginId: "web",
    title: `添加网页：${url}`,
    url,
    id: `add-web:${url}`,
    usageKey: `add-web:${url}`
  };
}
const noteOf = (n) => String(n?.note || "").trim();

function iconHtml(n) {
  const raw = String(n?.icon || "").trim();
  const isImage = /^https?:\/\//i.test(raw)
    || /^data:image\//i.test(raw)
    || /^(?:\.\/|\/)?assets\/[^?#]+\.(?:png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(raw);
  if (isImage) {
    if (failedWebIcons.has(raw) || (!showUncachedWebIcons && !loadedWebIcons.has(raw))) return "⌁";
    return `<img src="${esc(raw)}" data-web-icon="${esc(raw)}" width="22" height="22" loading="lazy" decoding="async" alt="" />`;
  }
  return esc(raw || "⌁");
}

function deferUncachedWebIcons(delay = 260) {
  showUncachedWebIcons = false;
  clearTimeout(webIconTimer);
  webIconTimer = setTimeout(() => {
    showUncachedWebIcons = true;
    render({ preserveScroll: true });
  }, delay);
}
function setConfig(config) {
  state.config = config;
}

function eventMatchesShortcut(event, shortcut) {
  const parts = String(shortcut || "").replace(/\s+/g, "").toLowerCase().split("+").filter(Boolean);
  if (!parts.length) return false;
  const aliases = { option: "alt", control: "ctrl", cmd: "meta", command: "meta", commandorcontrol: "commandorcontrol", cmdorctrl: "commandorcontrol" };
  const normalized = parts.map((part) => aliases[part] || part);
  const key = normalized.find((part) => !["shift", "alt", "ctrl", "meta", "commandorcontrol"].includes(part));
  if (!key) return false;
  const commandOrControl = normalized.includes("commandorcontrol");
  const expectedCtrl = normalized.includes("ctrl");
  const expectedMeta = normalized.includes("meta");
  if (event.shiftKey !== normalized.includes("shift") || event.altKey !== normalized.includes("alt")) return false;
  if (commandOrControl) {
    if (!event.ctrlKey && !event.metaKey) return false;
  } else if (event.ctrlKey !== expectedCtrl || event.metaKey !== expectedMeta) return false;
  const codeKey = String(event.code || "").replace(/^Digit/, "").replace(/^Key/, "").toLowerCase();
  const eventKey = String(event.key || "").toLowerCase();
  const expectedKey = key === "space" ? " " : key;
  return eventKey === expectedKey || codeKey === key;
}

function scopeForShortcut(event) {
  const configured = { ...DEFAULT_SCOPE_SHORTCUTS, ...(state.config?.core?.scopeShortcuts || {}) };
  return Object.entries(configured).find(([scope, shortcut]) => scopeOrder.includes(scope) && eventMatchesShortcut(event, shortcut))?.[0] || "";
}
function pathText(page) {
  if (typeof page?.path === "string") return page.path;
  if (page?.breadcrumb) return String(page.breadcrumb);
  return (page?.path || []).map((x) => x.title).join(" / ");
}
function pageMatches() {
  return state.webResults;
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

function memoMatches() {
  return state.memoResults.map((memo) => ({ ...memo, type: "memo" }));
}

function memoPathHtml(item) {
  const segments = window.FlowHubMemoCatalog?.categorySegments?.(item?.category) || [item?.category || "其他"];
  return segments.map((segment, index) => `${index ? `<i aria-hidden="true">›</i>` : ""}<span>${esc(segment)}</span>`).join("");
}

function usageKey(item) {
  return `${item.type}:${item.usageKey || item.id || item.path || item.url || item.title}`;
}

function usageMatches() {
  if (state.query.trim() || state.scope === "clipboard") return [];
  const entries = [];
  for (const section of ["frequent", "recent"]) {
    for (const item of state.usageSections?.[section] || []) {
      if (item.type === "app" && !pluginEnabled("app")) continue;
      if (item.type === "page" && !pluginEnabled("web")) continue;
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

let allResultKeys = null;
let allInitialResults = [];
let allPaging = false;
const resultKey = (item) => `${item.type || item.kind}:${item.id || item.path || item.url || item.title}`;
function allCandidates() {
  return [
    ...(pluginEnabled("clipboard") ? clipboardMatches() : []),
    ...(pluginEnabled("app") ? appMatches() : []),
    ...(pluginEnabled("web") ? pageMatches().map(page => ({ ...page, type: "page" })) : []),
    ...(pluginEnabled("memo") ? memoMatches() : [])
  ];
}
function allHasMore() {
  const shown = new Set(allResultKeys || matches().map(resultKey));
  return allCandidates().some(item => !shown.has(resultKey(item)))
    || (pluginEnabled("clipboard") && state.clipboardHasMore)
    || (pluginEnabled("app") && state.appHasMore)
    || (pluginEnabled("web") && state.webHasMore)
    || (pluginEnabled("memo") && state.memoHasMore);
}
async function loadMoreAll() {
  if (allPaging || state.scope !== "all") return;
  // Do not page old-query data while the debounced first page is pending.
  if ((pluginEnabled("clipboard") && state.clipboardLoadedQuery !== state.query)
    || (pluginEnabled("app") && state.appLoadedQuery !== state.query)
    || (pluginEnabled("web") && state.webLoadedQuery !== state.query)
    || (pluginEnabled("memo") && state.memoLoadedQuery !== state.query)) return;
  if (!allResultKeys) { allInitialResults = matches(); allResultKeys = allInitialResults.map(resultKey); }
  const token = allScopeRefreshToken;
  const shown = new Set(allResultKeys);
  allPaging = true;
  try {
    let next = allCandidates().filter(item => !shown.has(resultKey(item)));
    if (!next.length) {
      await Promise.allSettled([
        state.clipboardHasMore ? refreshClipboard({ append: true, deferRender: true }) : null,
        state.appHasMore ? refreshApps({ append: true, deferRender: true }) : null,
        state.webHasMore ? refreshWeb({ append: true, deferRender: true }) : null,
        state.memoHasMore ? refreshMemos({ append: true, deferRender: true }) : null
      ]);
      if (token !== allScopeRefreshToken || state.scope !== "all") return;
      next = allCandidates().filter(item => !shown.has(resultKey(item)));
    }
    for (const item of next.slice(0, 12)) {
      const key = resultKey(item);
      if (!shown.has(key)) { allResultKeys.push(key); shown.add(key); }
    }
  } finally {
    allPaging = false;
    if (token === allScopeRefreshToken && state.scope === "all") render({ preserveScroll: true });
  }
}

function matches() {
  if (state.scope === "all" && allResultKeys) {
    const pool = new Map([...allInitialResults, ...usageMatches(), ...toolSuggestions(), ...allCandidates()].map(item => [resultKey(item), item]));
    return allResultKeys.map(key => pool.get(key)).filter(Boolean);
  }
  if (state.scope === "clipboard") return pluginEnabled("clipboard") ? clipboardMatches() : [];
  if (state.scope === "memo") return pluginEnabled("memo") ? memoMatches() : [];
  const tools = state.scope === "clipboard" ? [] : toolSuggestions();
  const pages = pluginEnabled("web") ? pageMatches().map((page) => ({ ...page, type: "page" })) : [];
  const addWeb = pluginEnabled("web") && state.query.trim() ? webAddSuggestion(pages) : null;
  const clips = state.scope === "all" && pluginEnabled("clipboard") ? clipboardMatches() : [];
  const apps = pluginEnabled("app") ? appMatches() : [];
  const memos = pluginEnabled("memo") ? memoMatches() : [];
  const usages = usageMatches();
  if (state.scope === "web") {
    if (!state.query.trim()) return [...usages, ...withoutUsageDuplicates(pages, usages)];
    return tools.length ? [...tools, ...(addWeb ? [addWeb] : []), ...pages] : (addWeb ? [addWeb, ...pages] : pages);
  }
  if (state.scope === "clipboard") return clips;
  if (state.scope === "app") {
    if (!state.query.trim()) return [...usages, ...withoutUsageDuplicates(apps, usages)];
    return tools.length ? [...tools, ...apps] : apps;
  }
  if (state.scope === "memo") return memos;
  if (!state.query.trim()) {
    const regularLimit = usages.length ? 4 : 6;
    return [...usages.slice(0, usages.length ? 8 : 0), ...clips.slice(0, regularLimit), ...withoutUsageDuplicates(pages, usages).slice(0, regularLimit)].slice(0, 12);
  }
  const appResults = state.query.trim() ? apps.slice(0, 3) : [];
  const memoResults = state.query.trim() ? memos.slice(0, 4) : [];
  const regularLimit = appResults.length || memoResults.length ? 3 : 6;
  return [...tools, ...(addWeb ? [addWeb] : []), ...memoResults, ...clips.slice(0, regularLimit), ...appResults, ...pages.slice(0, regularLimit)].slice(0, 12);
}

function usageIndices(items, section) {
  return items.reduce((indices, item, index) => {
    if (item.usageSection === section) indices.push(index);
    return indices;
  }, []);
}

function usagePosition(items, index = state.index) {
  const section = items[index]?.usageSection;
  if (!section) return null;
  const indices = usageIndices(items, section);
  return { section, indices, column: Math.max(0, indices.indexOf(index)) };
}

function moveUsageHorizontal(items, offset) {
  const position = usagePosition(items);
  if (!position) return false;
  const column = Math.max(0, Math.min(position.indices.length - 1, position.column + offset));
  state.usageColumn = column;
  state.index = position.indices[column];
  return true;
}

function moveVertical(items, offset) {
  if (!items.length) return;
  const sections = ["frequent", "recent"].filter((section) => usageIndices(items, section).length);
  const position = usagePosition(items);
  const firstRegular = items.findIndex((item) => !item.usageSection);
  if (position) {
    state.usageColumn = position.column;
    const sectionIndex = sections.indexOf(position.section);
    const targetSection = sections[sectionIndex + offset];
    if (targetSection) {
      const targetIndices = usageIndices(items, targetSection);
      state.index = targetIndices[Math.min(state.usageColumn, targetIndices.length - 1)];
    } else if (offset > 0 && firstRegular >= 0) {
      state.index = firstRegular;
    }
    return;
  }
  if (offset < 0 && state.index === firstRegular && sections.length) {
    const targetIndices = usageIndices(items, sections.at(-1));
    state.index = targetIndices[Math.min(state.usageColumn, targetIndices.length - 1)];
    return;
  }
  state.index = Math.max(0, Math.min(items.length - 1, state.index + offset));
}

function clipboardTextHtml(text) {
  // Render frequent status symbols as lightweight inline vectors. The original
  // clipboard string remains untouched for copy/paste and expanded content.
  return esc(text).replace(/[❌✅]/gu, symbol => symbol === "❌"
    ? '<svg role="img" aria-label="❌" width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;color:#ec6767"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>'
    : '<svg role="img" aria-label="✅" width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px"><rect width="16" height="16" rx="3" fill="#4eaa75"/><path d="m3 8 3 3 7-7" stroke="white" fill="none" stroke-width="2"/></svg>');
}

function clipboardPreviewHtml(content, expanded) {
  const preview = expanded ? content : content.slice(0, 300).split("\n").slice(0, 5).join("\n");
  const text = preview + (!expanded && preview.length < content.length ? "…" : "");
  return (expanded ? esc : clipboardTextHtml)(text || "空文本");
}

function toggleClipboardPreview(button) {
  const id = Number(button.dataset.clipboardToggle);
  const item = state.clipboardResults.find(record => Number(record.id) === id);
  const row = button.closest(".clipboard-result");
  const title = row?.querySelector(".clipboard-title");
  if (!item || !title) return;
  const expanded = !state.expandedClipboard.has(id);
  if (expanded) state.expandedClipboard.add(id);
  else state.expandedClipboard.delete(id);
  // Keep the row and button alive: rebuilding results loses scroll and focus.
  title.innerHTML = clipboardPreviewHtml(String(item.content || ""), expanded);
  title.classList.toggle("is-expanded", expanded);
  title.scrollTop = 0;
  button.setAttribute("aria-expanded", String(expanded));
  button.textContent = expanded ? "⌃ 收起" : "⌄ 展开";
  const style = getComputedStyle(row);
  resultWindow.heights.set(resultKey({...item,type:"clipboard"}),
    row.getBoundingClientRect().height + parseFloat(style.marginTop || 0) + parseFloat(style.marginBottom || 0));
  lastResultsHtml = "";
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
  const appIcon = item.type === "app"
    ? (item.iconUrl || state.appResults.find((application) => application.path === item.path)?.iconUrl || "")
    : "";
  const icon = item.type === "app"
    ? (appIcon ? `<img src="${esc(appIcon)}" loading="lazy" decoding="async" alt="" />` : "▣")
    : iconHtml(item);
  return `
    <div class="result usage-tile ${item.type === "app" ? "app" : "web"} ${index === state.index ? "active" : ""}" data-i="${index}" title="${esc(item.title || "")}">
      <span class="usage-tile-icon">${icon}</span>
      <span class="usage-tile-name">${esc(item.title || "未命名")}</span>
    </div>
  `;
}

function renderResults(items, from = 0, to = items.length) {
  let html = "";
  for (let index = from; index < to;) {
    const item = items[index];
    if (item.usageSection) {
      const start = index;
      const section = item.usageSection;
      while (index < to && items[index].usageSection === section) index += 1;
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
  const registered = window.FlowHubTools.render(item, {esc,index,active:index===state.index});
  if (registered) return registered;
  const html = renderResultBody(item,index,items);
  if (!portableQueryCommand(item)) return html;
  const end = html.lastIndexOf("</div>");
  return html.slice(0,end)+`<button type="button" class="tool-action query-copy" data-copy-query title="适用于 macOS / Linux；需要 curl 或 dig">复制查询命令</button>`+html.slice(end);
}
function renderResultBody(item, index, items) {
  const usageSection = renderUsageSection(item, index, items);
  if (item.type === "calculation") {
    return `${usageSection}
      <div class="result calculation-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon calculation">＝</span>
        <span class="r-body">
          <span class="r-title calculation-value">${esc(item.result)}</span>
          <span class="r-meta calculation-expression">计算 · ${esc(item.expression)}</span>
        </span>
        <span class="r-kind calculation">结果</span>
      </div>
    `;
  }
  if (item.type === "timestamp") {
    return `${usageSection}
      <div class="result calculation-result tool-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon calculation">◷</span>
        <span class="r-body">
          <span class="r-title calculation-value">${esc(item.result)}</span>
          <span class="r-meta calculation-expression">时间戳 · ${esc(item.expression)}（${esc(item.unit)}）</span>
        </span>
        <span class="r-kind calculation">转换</span>
      </div>
    `;
  }
  if (item.type === "jwt") {
    const subject = item.payload?.sub || item.payload?.iss || "header + payload";
    return `${usageSection}
      <div class="result calculation-result tool-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon calculation">◇</span>
        <span class="r-body">
          <span class="r-title calculation-value">JWT 解析</span>
          <span class="r-meta calculation-expression">${esc(subject)} · 回车复制 JSON</span>
        </span>
        <span class="r-kind calculation">工具</span>
      </div>
    `;
  }
  if (item.type === "ip") {
    const details = item.details;
    const location = [details?.city, details?.region, details?.country_name].filter(Boolean).join(" · ");
    const detailsBody = details?.private
      ? `<span class="ip-empty">私有地址 · 无公网归属地</span>`
      : details?.error
        ? `<span class="ip-empty">查询失败 · 请检查网络</span>`
        : details
          ? `<span class="ip-details">${[
              location && ["位置", location],
              details.org && ["组织", details.org],
              details.asn && ["ASN", details.asn],
              details.timezone && ["时区", details.timezone]
            ].filter(Boolean).map(([label, value]) => `<span class="ip-line"><span class="ip-label">${esc(label)}</span><span class="ip-value" title="${esc(value)}">${esc(value)}</span></span>`).join("") || `<span class="ip-empty">归属地未知</span>`}</span>`
          : `<span class="ip-empty">正在查询 IP 归属地…</span>`;
    return `${usageSection}
      <div class="result calculation-result ip-result tool-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon calculation">⌁</span>
        <span class="r-body">
          <span class="r-title calculation-value">${esc(item.result)}</span>
          ${detailsBody}
          <span class="r-meta calculation-expression">回车复制详情</span>
        </span>
        <span class="r-kind calculation">IP 归属地</span>
      </div>
    `;
  }
  if (item.type === "dns") {
    const dnsResolved = state.dnsResult?.hostname === item.hostname;
    const answerRows = item.answers?.length
      ? item.answers.slice(0, 8).map((answer) => {
          const address = String(answer.data || "");
          const geo = [1, 28].includes(Number(answer.type)) && dnsIpGeoEnabled() ? state.dnsIpResults[address] : null;
          const geoText = geo?.error
            ? "归属地查询失败"
            : geo
              ? [geo.city, geo.region, geo.country_name].filter(Boolean).join(" · ") || "归属地未知"
              : [1, 28].includes(Number(answer.type)) && dnsIpGeoEnabled() ? "正在查询归属地…" : "";
          return `<span class="dns-line"><span class="dns-label">${esc(dnsRecordType(answer.type))}</span><span class="dns-value" title="${esc(address)}"><span>${esc(address)}</span>${geoText ? `<small class="dns-geo">${esc(geoText)}</small>` : ""}</span></span>`;
        }).join("")
      : "";
    const answerBody = answerRows
      ? `<span class="dns-details">${answerRows}</span>`
      : `<span class="dns-empty">${dnsResolved ? "无 DNS 记录" : "正在查询 DNS…"}</span>`;
    return `${usageSection}
      <div class="result calculation-result tool-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon calculation">⌁</span>
        <span class="r-body">
          <span class="r-title calculation-value">DNS · ${esc(item.hostname)} · ${esc(item.family || "记录")}</span>
          ${answerBody}
          <span class="r-meta calculation-expression">${item.answers?.length > 8 ? `还有 ${item.answers.length - 8} 条记录 · ` : ""}回车复制完整记录</span>
        </span>
        <span class="r-kind calculation">工具</span>
      </div>
    `;
  }
  if (item.type === "cloudflare") {
    const details = item.details;
    const status = details?.challenge
      ? "检测到 Cloudflare 挑战或拦截"
      : details?.cloudflare
        ? `检测到 Cloudflare · HTTP ${details.status || "?"}`
        : details
          ? `未发现 Cloudflare 特征 · HTTP ${details.status || "?"}`
          : item.cnameEvidence?.length
            ? "DNS 记录疑似经过 Cloudflare · 回车确认"
            : "回车检测 Cloudflare 与拦截状态";
    const evidence = details?.evidence?.length
      ? details.evidence.join("、")
      : item.cnameEvidence?.length
        ? `CNAME: ${item.cnameEvidence.join("、")}`
        : details
          ? "未发现响应头特征"
          : "不会自动发起 HTTP 请求";
    return `${usageSection}
      <div class="result calculation-result cloudflare-result tool-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon calculation">⌁</span>
        <span class="r-body">
          <span class="r-title calculation-value">Cloudflare · ${esc(item.hostname)}</span>
          <span class="r-meta calculation-expression">${esc(status)}</span>
          <span class="cloudflare-evidence">${esc(evidence)}</span>
        </span>
        <span class="r-kind calculation">检测</span>
      </div>
    `;
  }
  if (item.type === "proxy") {
    const details = item.details;
    const formatEndpoint = (entry) => entry?.enabled && entry.host ? `${entry.host}:${entry.port || ""}` : "未启用";
    const rows = details ? [
      ["HTTP", formatEndpoint(details.http)],
      ["HTTPS", formatEndpoint(details.https)],
      ["SOCKS", formatEndpoint(details.socks)],
      details.egressIp ? ["出口 IP", details.egressIp] : null,
      details.node?.remoteAddress ? ["当前节点", `${details.node.nodeName || "当前连接"} · ${details.node.remoteAddress}`] : null
    ].filter(Boolean) : [];
    const body = details?.error
      ? `<span class="proxy-line"><span class="proxy-value">${esc(details.error)}</span></span>`
      : details
        ? `<div class="proxy-details">${rows.map(([label, value]) => `<span class="proxy-line"><span class="proxy-label">${esc(label)}</span><span class="proxy-value" title="${esc(value)}">${esc(value)}</span></span>`).join("")}</div>`
        : `<span class="proxy-line"><span class="proxy-value">正在读取系统代理…</span></span>`;
    return `${usageSection}
      <div class="result calculation-result proxy-result tool-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon calculation">⇄</span>
        <span class="r-body">
          <span class="r-title calculation-value">代理信息</span>
          ${body}
          <span class="r-meta calculation-expression proxy-hint">回车复制详情</span>
        </span>
        <span class="r-kind calculation">工具</span>
      </div>
    `;
  }
  if (item.type === "web-add") {
    return `
      <div class="result web-add-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon web-add">＋</span>
        <span class="r-body">
          <span class="r-title">添加到网页配置</span>
          <span class="r-meta"><span class="path">未找到匹配网页</span> · ${esc(item.url)}</span>
        </span>
        <span class="r-kind">添加</span>
      </div>
    `;
  }
  if (item.type === "memo") {
    const command = String(item.content || "").split("\n").slice(0, 2).join("\n");
    return `${usageSection}
      <div class="result memo-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="memo-terminal" aria-hidden="true">›_</span>
        <span class="r-body">
          <span class="memo-path">${memoPathHtml(item)}</span>
          <span class="memo-heading"><span class="r-title">${esc(item.title || "未命名备忘")}</span></span>
          <code class="memo-command">${esc(command)}</code>
          ${item.description ? `<span class="r-meta memo-description">${esc(item.description)}</span>` : ""}
        </span>
        <span class="r-kind memo">命令</span>
      </div>
    `;
  }
  if (item.type === "app") {
    const icon = item.iconUrl
      ? `<img src="${esc(item.iconUrl)}" loading="lazy" decoding="async" alt="" />`
      : "▣";
    const packageName = String(item.fileName || "").replace(/\.app$/i, "");
    const alias = packageName && packageName !== item.title ? ` · ${esc(packageName)}` : "";
    return `${usageSection}
      <div class="result app-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon app">${icon}</span>
        <span class="r-body">
          <span class="r-title">${esc(item.title || "未命名应用")}</span>
          <span class="r-meta"><span class="path">应用</span>${alias} · ${esc(item.path)}</span>
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
      : isFile ? esc(fileLabel) : clipboardPreviewHtml(preview, expanded);
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

const resultWindow = new window.FlowHubResultWindow();
let windowedResults = false;
let windowRenderFrame = 0;
function render(options = {}) {
  return window.flowhubSearchTiming ? window.flowhubSearchTiming.render(() => renderMeasured(options)) : renderMeasured(options);
}

function renderMeasured({ preserveScroll = false, targetIndex = null } = {}) {
  const phase = window.flowhubSearchTiming?.phases?.();
  const currentScrollTop = resultsEl.scrollTop;
  const previousScrollTop = preserveScroll ? currentScrollTop : 0;
  // Reset before DOM mutation. Reassigning the same scrollTop afterwards forces
  // WebKit to lay out the newly inserted rows synchronously, even at zero.
  if (!preserveScroll && currentScrollTop !== 0) resultsEl.scrollTop = 0;
  if (!state.config) {
    const html = `<div class="empty">配置加载中…</div>`;
    if (html !== lastResultsHtml) {
      resultsEl.innerHTML = html;
      lastResultsHtml = html;
    }
    return;
  }
  const m = matches();
  phase?.("matches");
  const paging = state.scope === "all"
    ? { loading: allPaging, hasMore: allHasMore() }
    : state.scope === "clipboard"
    ? { loading: state.clipboardLoading, hasMore: state.clipboardHasMore }
    : state.scope === "app"
      ? { loading: state.appLoading, hasMore: state.appHasMore }
      : state.scope === "web"
        ? { loading: state.webLoading, hasMore: state.webHasMore }
        : state.scope === "memo"
          ? { loading: state.memoLoading, hasMore: state.memoHasMore }
          : null;
  windowedResults = m.length > 80;
  let plan = null;
  if (windowedResults) plan = resultWindow.plan(m, resultKey, previousScrollTop, resultsEl.clientHeight, targetIndex);
  const resultHtml = plan
    ? `<div aria-hidden="true" style="height:${plan.before}px"></div>${renderResults(m, plan.from, plan.to)}<div aria-hidden="true" style="height:${plan.after}px"></div>`
    : renderResults(m);
  const html = !m.length
    ? `<div class="empty">${paging?.loading ? "正在加载…" : "没有匹配项"}</div>`
    : `${resultHtml}${paging && (paging.loading || !paging.hasMore) ? `<div class="plugin-load-status">${paging.loading ? "正在加载更多…" : "已经到底了"}</div>` : ""}`;
  phase?.("markup");
  if (html !== lastResultsHtml) {
    resultsEl.innerHTML = html;
    lastResultsHtml = html;
  }
  phase?.("dom");
  if (plan) {
    for (const group of plan.groups) {
      const row = resultsEl.querySelector(`.result[data-i="${group.start}"]`);
      if (!row) continue;
      const element = m[group.start].usageSection ? row.parentElement : row;
      const style = getComputedStyle(element);
      const height = element.getBoundingClientRect().height + parseFloat(style.marginTop || 0) + parseFloat(style.marginBottom || 0);
      const heading = m[group.start].usageSection ? element.previousElementSibling?.getBoundingClientRect().height || 0 : 0;
      resultWindow.heights.set(group.id, height + heading);
    }
  }
  phase?.("layout");
  if (!m.length) return;
  if (targetIndex != null && plan) resultsEl.scrollTop = plan.targetTop;
  phase?.("scroll");
}

function revealActiveResult() {
  resultsEl.querySelector(".result.active")?.classList.remove("active");
  if (windowedResults && !resultsEl.querySelector(`.result[data-i="${state.index}"]`)) render({ preserveScroll: true, targetIndex: state.index });
  const active = resultsEl.querySelector(`.result[data-i="${state.index}"]`);
  if (!active) return;
  active.classList.add("active");
  active.scrollIntoView({ block: "nearest" });
}

function choose(page) {
  if (page?.toolId) { Promise.resolve(window.FlowHubTools.choose(page,toolContext())).catch(error=>showActionStatus(error.message||"操作失败")); return; }
  if (["calculation", "timestamp", "jwt"].includes(page?.type)) {
    void copyText(page.result)
      .then(() => showActionStatus("已复制"))
      .catch(() => showActionStatus("复制失败"));
    return;
  }
  if (page?.type === "ip") {
    const lookupIp = window.weborg?.lookupIp;
    const formatDetails = (details) => {
      if (details?.private) return `${page.address}\n私有地址，无法查询公网归属地`;
      if (details?.error) return `${page.address}\nIP 归属地查询失败`;
      return [
        `IP: ${page.address}`,
        details?.version && `版本: ${details.version}`,
        [details?.city, details?.region, details?.country_name].filter(Boolean).length ? `位置: ${[details.city, details.region, details.country_name].filter(Boolean).join(" · ")}` : null,
        details?.org && `组织: ${details.org}`,
        details?.asn && `ASN: ${details.asn}`,
        details?.timezone && `时区: ${details.timezone}`
      ].filter(Boolean).join("\n");
    };
    if (isPrivateIp(page.address)) {
      void copyText(formatDetails({ private: true })).then(() => showActionStatus("私有 IP 信息已复制")).catch(() => showActionStatus("复制失败"));
      return;
    }
    if (page.details && !page.details.error) {
      void copyText(formatDetails(page.details)).then(() => showActionStatus("IP 归属地已复制")).catch(() => showActionStatus("复制失败"));
      return;
    }
    if (typeof lookupIp !== "function") {
      void copyText(page.address).then(() => showActionStatus("IP 地址已复制")).catch(() => showActionStatus("复制失败"));
      return;
    }
    void lookupIp(page.address)
      .then((details) => copyText(formatDetails(details)))
      .then(() => showActionStatus("IP 归属地已复制"))
      .catch(() => showActionStatus("IP 查询失败"));
    return;
  }
  if (page?.type === "cloudflare") {
    const inspectCloudflare = window.weborg?.inspectCloudflare;
    if (typeof inspectCloudflare !== "function") {
      showActionStatus("Cloudflare 检测不可用");
      return;
    }
    void inspectCloudflare(page.hostname)
      .then((details) => {
        if (state.query.trim() === page.expression) {
          state.cloudflareResult = { hostname: page.hostname, ...details };
          render();
        }
        showActionStatus(details?.challenge ? "检测到 Cloudflare 拦截或挑战" : "Cloudflare 检测完成");
      })
      .catch(() => showActionStatus("Cloudflare 检测失败"));
    return;
  }
  if (page?.type === "proxy") {
    const lookupProxy = window.weborg?.lookupProxy;
    if (typeof lookupProxy !== "function") {
      showActionStatus("代理检测不可用");
      return;
    }
    void lookupProxy().then((details) => {
      const endpoint = (name, entry) => `${name}: ${entry?.enabled && entry.host ? `${entry.host}:${entry.port || ""}` : "未启用"}`;
      const text = [endpoint("HTTP", details?.http), endpoint("HTTPS", details?.https), endpoint("SOCKS", details?.socks), details?.egressIp && `出口 IP: ${details.egressIp}`, details?.node?.remoteAddress && `当前连接节点: ${details.node.nodeName || "未知"} (${details.node.remoteAddress})`].filter(Boolean).join("\n");
      return copyText(text);
    }).then(() => showActionStatus("代理信息已复制")).catch(() => showActionStatus("代理检测失败"));
    return;
  }
  if (page?.type === "dns") {
    const lookupDns = window.weborg?.lookupDns;
    if (typeof lookupDns !== "function") {
      showActionStatus("DNS 查询不可用");
      return;
    }
    void lookupDns(page.hostname)
      .then((response) => {
        const allAnswers = Array.isArray(response?.Answer) ? response.Answer : [];
        const familyType = page.family === "CNAME" ? 5 : page.family === "IPv6" ? 28 : page.family === "IPv4" ? 1 : null;
        const familyAnswers = familyType
          ? allAnswers.filter((answer) => Number(answer.type) === familyType)
          : allAnswers;
        const text = familyAnswers.length
          ? familyAnswers.map((answer) => `${answer.name || page.hostname} ${dnsRecordType(answer.type)} ${answer.data || ""}`.trim()).join("\n")
          : `${page.hostname} · ${page.family || "DNS"}\n无 DNS 记录`;
        return copyText(text);
      })
      .then(() => showActionStatus("DNS 结果已复制"))
      .catch(() => showActionStatus("DNS 查询失败"));
    return;
  }
  if (page?.type === "web-add") {
    void window.weborg?.openSettings({ initialUrl: normalizeUrl(page.url) });
    return;
  }
  const pluginId = page?.pluginId || (page?.type === "clipboard" ? "clipboard" : page?.type === "app" ? "app" : page?.type === "memo" ? "memo" : "web");
  if (["clipboard", "memo"].includes(pluginId) && document.documentElement.dataset.weborgReadonly === "true") return;
  const usage = pluginId === "app"
    ? { type: "app", title: page.title, path: page.path }
    : { type: "page", id: page.id || page.usageKey, title: page.title, breadcrumb: pathText(page), icon: page.icon || "" };
  void window.weborg?.pluginAction(pluginId, "activate", {
    id: page.id,
    path: page.path,
    url: normalizeUrl(page.url),
    content: page.content,
    usage
  });
}

function queueDnsLookup() {
  clearTimeout(dnsSearchTimer);
  const token = ++dnsSearchToken;
  state.dnsResult = null;
  state.dnsIpResults = {};
  state.cloudflareResult = null;
  const suggestion = dnsSuggestion();
  if (!suggestion || typeof window.weborg?.lookupDns !== "function") return;
  dnsSearchTimer = setTimeout(async () => {
    try {
      const response = await window.weborg.lookupDns(suggestion.hostname);
      if (token !== dnsSearchToken || state.query.trim() !== suggestion.expression) return;
      state.dnsResult = {
        hostname: suggestion.hostname,
        answers: Array.isArray(response?.Answer) ? response.Answer : []
      };
      render();
      void enrichDnsIpResults(suggestion.hostname, state.dnsResult.answers, token);
    } catch {
      if (token === dnsSearchToken) {
        state.dnsResult = { hostname: suggestion.hostname, answers: [] };
        render();
      }
    }
  }, 220);
}

function queueIpLookup() {
  clearTimeout(ipSearchTimer);
  const token = ++ipSearchToken;
  state.ipResult = null;
  const suggestion = ipSuggestion();
  if (!suggestion || isPrivateIp(suggestion.address) || typeof window.weborg?.lookupIp !== "function") {
    if (suggestion && isPrivateIp(suggestion.address)) {
      state.ipResult = { address: suggestion.address, private: true };
    }
    return;
  }
  ipSearchTimer = setTimeout(async () => {
    try {
      const details = await window.weborg.lookupIp(suggestion.address);
      if (token !== ipSearchToken || state.query.trim() !== suggestion.expression) return;
      state.ipResult = { address: suggestion.address, ...details };
      render();
    } catch {
      if (token === ipSearchToken) {
        state.ipResult = { address: suggestion.address, error: "查询失败" };
        render();
      }
    }
  }, 260);
}

function queueProxyLookup() {
  clearTimeout(proxySearchTimer);
  const token = ++proxySearchToken;
  state.proxyResult = null;
  const suggestion = proxySuggestion();
  if (!suggestion || typeof window.weborg?.lookupProxy !== "function") return;
  proxySearchTimer = setTimeout(async () => {
    try {
      const details = await window.weborg.lookupProxy();
      if (token !== proxySearchToken || state.query.trim() !== suggestion.expression) return;
      state.proxyResult = details || { error: "检测失败" };
      render();
    } catch {
      if (token === proxySearchToken) {
        state.proxyResult = { error: "检测失败" };
        render();
      }
    }
  }, 220);
}

function renderPluginScopes(plugins) {
  state.plugins = (plugins || []).filter((plugin) => plugin.enabled && plugin.available).sort((a, b) => a.order - b.order);
  const scopes = [{ id: "all", name: "全部" }, ...state.plugins.filter((plugin) => plugin.searchable)];
  scopeOrder = scopes.map(plugin => plugin.id);
  if (!scopeOrder.includes(state.scope)) state.scope = "all";
  // Preserve pressed/focused nodes across config refreshes. Replacing a button
  // between mousedown and mouseup prevents the browser from delivering click.
  const existing = new Map(Array.from(scopeRow.querySelectorAll("[data-scope]"), button => [button.dataset.scope, button]));
  let previous = null;
  for (const scope of scopes) {
    let button = existing.get(scope.id);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "scope-button";
      button.dataset.scope = scope.id;
    }
    if (button.textContent !== scope.name) button.textContent = scope.name;
    button.classList.toggle("active", state.scope === scope.id);
    const anchor = previous ? previous.nextElementSibling : scopeRow.querySelector("[data-scope]");
    if (anchor !== button) scopeRow.insertBefore(button, anchor);
    existing.delete(scope.id);
    previous = button;
  }
  for (const button of existing.values()) button.remove();
}

function pluginEnabled(id) {
  return state.plugins.some((plugin) => plugin.id === id && plugin.enabled && plugin.available);
}

function invalidateClipboardPaging({ resetPaging = true } = {}) {
  clipboardSearchToken += 1;
  state.clipboardLoading = false;
  if (resetPaging) state.clipboardHasMore = false;
}

function invalidatePluginPaging({ resetPaging = true } = {}) {
  appSearchToken += 1;
  webSearchToken += 1;
  memoSearchToken += 1;
  appIconSearchToken += 1;
  state.appLoading = false;
  state.webLoading = false;
  state.memoLoading = false;
  if (resetPaging) {
    state.appHasMore = false;
    state.webHasMore = false;
    state.memoHasMore = false;
  }
}

function setScope(scope) {
  window.flowhubSearchTiming?.begin("scope");
  allResultKeys = null;
  allScopeRefreshToken += 1;
  invalidateClipboardPaging({ resetPaging: false });
  invalidatePluginPaging({ resetPaging: false });
  state.scope = scope;
  window.FlowHubTools.queryChanged(toolContext());
  state.index = 0;
  document.querySelectorAll("[data-scope]").forEach((item) => item.classList.toggle("active", item.dataset.scope === scope));
  clipboardKindRow?.classList.toggle("visible", scope === "clipboard");
  renderKeyboardHint();
  render();
  // Scope switches should be instant when the current query is already cached.
  // Only refresh the active scope when its data is stale; this avoids spawning
  // several IPC calls (and native icon scans) for every Tab press.
  if (scope === "all") {
    const stale = (pluginEnabled("clipboard") && state.clipboardLoadedQuery !== state.query)
      || (pluginEnabled("app") && state.appLoadedQuery !== state.query)
      || (pluginEnabled("web") && state.webLoadedQuery !== state.query)
      || (pluginEnabled("memo") && state.memoLoadedQuery !== state.query);
    if (stale) void refreshAllScopes();
  } else if (scope === "clipboard") {
    if (state.clipboardLoadedQuery !== state.query && !state.clipboardLoading) void refreshClipboard();
  }
  if (scope === "app") {
    if (!state.appLoading && (state.appLoadedQuery !== state.query || (scope === "app" && state.appLoadedLimit < APP_PAGE_SIZE))) void refreshApps();
  }
  if (scope === "web") {
    if (state.webLoadedQuery !== state.query) void refreshWeb();
  }
  if (scope === "memo") {
    if (state.memoLoadedQuery !== state.query) void refreshMemos();
  }
  q?.focus({ preventScroll: true });
}

function moveScope(offset) {
  const current = Math.max(0, scopeOrder.indexOf(state.scope));
  setScope(scopeOrder[(current + offset + scopeOrder.length) % scopeOrder.length]);
}

function renderKeyboardHint() {
  if (!keyboardHint) return;
  if (state.scope === "clipboard") {
    keyboardHint.innerHTML = `↑↓ 记录 · 点击切换类型 · <code>Tab</code> 范围 · <code>⏎</code> 粘贴`;
  } else if (state.scope === "all") {
    keyboardHint.innerHTML = `←→ 常用/最近 · ↑↓ 区块与结果 · <code>Tab</code> 范围 · <code>⏎</code> 打开`;
  } else if (state.scope === "memo") {
    keyboardHint.innerHTML = `↑↓ 选择 · <code>Tab</code> 范围 · <code>⏎</code> 粘贴命令`;
  } else {
    keyboardHint.innerHTML = `↑↓ 结果 · <code>Tab</code> 范围 · <code>⏎</code> 打开`;
  }
}

function setClipboardKind(kind) {
  if (!clipboardKinds.includes(kind)) return;
  invalidateClipboardPaging();
  state.clipboardKind = kind;
  state.index = 0;
  document.querySelectorAll("[data-clipboard-kind]").forEach((item) => {
    const active = item.dataset.clipboardKind === kind;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  render();
  void refreshClipboard();
  q?.focus({ preventScroll: true });
}

// 更新配置（主进程每次呼出都会推送）
window.weborg.onConfig(async (cfg) => {
  setConfig(cfg);
  window.FlowHubTools.queryChanged(toolContext());
  renderPluginScopes(await window.weborg.listPlugins());
  if (!scopeOrder.includes(state.scope)) state.scope = "all";
  renderKeyboardHint();
  render();
  // The initial page load already starts one coordinated Promise.all for the
  // first pages. A config event can arrive while that work is still pending
  // (the first hotkey reveal); wait for initialize() to finish so we do not
  // issue a second set of identical IPC/database requests.
  if (!initialized) return;
  // The native side sends the current config every time the launcher is
  // shown. Do not invalidate already loaded empty-query pages on every
  // show: doing so made the first scope switch after a restart compete with
  // four duplicate IPC/database requests. Refresh only stale scopes and let
  // the clipboard/usage update events handle data changes independently.
  if (state.scope === "all") {
    const stale = (pluginEnabled("clipboard") && state.clipboardLoadedQuery !== state.query)
      || (pluginEnabled("app") && state.appLoadedQuery !== state.query)
      || (pluginEnabled("web") && state.webLoadedQuery !== state.query)
      || (pluginEnabled("memo") && state.memoLoadedQuery !== state.query);
    if (stale) void refreshAllScopes();
  } else {
    if (state.clipboardLoadedQuery !== state.query && !state.clipboardLoading) void refreshClipboard();
    if (state.appLoadedQuery !== state.query && !state.appLoading) void refreshApps();
    if (state.webLoadedQuery !== state.query && !state.webLoading) void refreshWeb();
    if (state.memoLoadedQuery !== state.query && !state.memoLoading) void refreshMemos();
  }
});

function returnToSearch() {
  scopeTabHeld = false;
  scopeTabUsedWithArrow = false;
  q.focus({ preventScroll: true });
  q.select();
}
document.getElementById("returnSearchBtn")?.addEventListener("click", returnToSearch);

document.addEventListener("keydown", (e) => {
  if (e.key === "F6") { e.preventDefault(); (resultsEl.querySelector(".result.active .tool-action") || resultsEl.querySelector(".tool-action") || q)?.focus(); return; }
  if (e.target.closest?.(".tool-action") && ["Enter"," ","Tab"].includes(e.key)) return;
  const justCommittedComposition = e.key === "Enter" && performance.now() - searchCompositionEndedAt < 80;
  if (searchInputComposing || e.isComposing || e.keyCode === 229 || e.key === "Process" || justCommittedComposition) return;
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === "KeyK" || e.key.toLowerCase() === "k")) {
    e.preventDefault();
    returnToSearch();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (window.weborg?.hideMain) void window.weborg.hideMain();
    else window.close();
    return;
  }
  const shortcutScope = scopeForShortcut(e);
  if (shortcutScope) {
    setScope(shortcutScope);
    e.preventDefault();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    if (!scopeTabHeld) {
      scopeTabHeld = true;
      scopeTabUsedWithArrow = false;
      scopeTabTapOffset = e.shiftKey ? -1 : 1;
    }
    q?.focus({ preventScroll: true });
    return;
  }
  if (scopeTabHeld && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    scopeTabUsedWithArrow = true;
    moveScope(e.key === "ArrowRight" ? 1 : -1);
    e.preventDefault();
    return;
  }
  if (document.activeElement !== q) return;
  const m = matches();
  if (e.altKey && ["Backspace", "Delete"].includes(e.key)) {
    const selected = m[state.index];
    if (selected?.type === "clipboard" && document.documentElement.dataset.weborgReadonly !== "true") {
      window.weborg?.pluginAction("clipboard", "menu", { id: selected.id });
      e.preventDefault();
      return;
    }
  }
  if (e.key === "ArrowDown") { moveVertical(m, 1); revealActiveResult(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { moveVertical(m, -1); revealActiveResult(); e.preventDefault(); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const offset = e.key === "ArrowRight" ? 1 : -1;
    if (state.scope === "all" && moveUsageHorizontal(m, offset)) {
      revealActiveResult();
      e.preventDefault();
    }
  }
  else if (e.key === "Enter") { const p = m[state.index]; if (p) choose(p); }
});

document.addEventListener("keyup", (e) => {
  if (e.key !== "Tab" || !scopeTabHeld) return;
  e.preventDefault();
  if (!scopeTabUsedWithArrow) moveScope(scopeTabTapOffset);
  scopeTabHeld = false;
  scopeTabUsedWithArrow = false;
  q?.focus({ preventScroll: true });
});

window.addEventListener("blur", () => {
  scopeTabHeld = false;
  scopeTabUsedWithArrow = false;
});

async function refreshClipboard({ append = false, deferRender = false } = {}) {
  if (!pluginEnabled("clipboard") || !["all", "clipboard"].includes(state.scope)) return;
  if (append && (!["all", "clipboard"].includes(state.scope) || state.clipboardLoading || !state.clipboardHasMore)) return;
  const token = ++clipboardSearchToken;
  const offset = append ? state.clipboardResults.length : 0;
  state.clipboardLoading = true;
  if (!append) state.clipboardHasMore = true;
  if (append && !deferRender) render({ preserveScroll: true });
  try {
    const records = await (window.flowhubSearchTiming ? window.flowhubSearchTiming.query("clipboard", () => window.weborg?.pluginSearch("clipboard", { query: state.query, kind: state.scope === "clipboard" ? state.clipboardKind : "all", limit: CLIPBOARD_PAGE_SIZE, offset })) : window.weborg?.pluginSearch("clipboard", { query: state.query, kind: state.scope === "clipboard" ? state.clipboardKind : "all", limit: CLIPBOARD_PAGE_SIZE, offset }));
    if (token !== clipboardSearchToken) return;
    window.flowhubSearchTiming?.applied();
    const nextRecords = records || [];
    state.clipboardResults = append
      ? [...state.clipboardResults, ...nextRecords.filter((record) => !state.clipboardResults.some((current) => current.id === record.id))]
      : nextRecords;
    if (!state.query.trim() && !append) state.emptyResults.clipboard = nextRecords.slice();
    state.clipboardLoadedQuery = state.query;
    state.clipboardHasMore = nextRecords.length === CLIPBOARD_PAGE_SIZE;
    void hydrateClipboardAssets(nextRecords, token);
  } catch {
    if (token === clipboardSearchToken && !append) state.clipboardResults = [];
  } finally {
    if (token === clipboardSearchToken) {
      state.clipboardLoading = false;
      if (!deferRender) render({ preserveScroll: true });
    }
  }
}

async function hydrateClipboardAssets(records, token) {
  if (!window.weborg?.loadClipboardAssets) return;
  const imageRecords = (records || []).filter((record) => record.kind === "image").slice(0, 6);
  const fileRecords = (records || []).filter((record) => record.kind === "file");
  const ids = [...imageRecords, ...fileRecords]
    .map((record) => Number(record.id))
    .filter(Number.isFinite);
  if (!ids.length) return;
  const assets = await window.weborg.loadClipboardAssets(ids).catch(() => ({}));
  if (token !== clipboardSearchToken) return;
  let changed = false;
  state.clipboardResults = state.clipboardResults.map((record) => {
    const asset = assets?.[String(record.id)];
    if (!asset || (!asset.imageUrl && !asset.fileIconUrl)) return record;
    changed = true;
    return { ...record, ...asset };
  });
  // Assets can arrive after the user scrolls or switches scopes. Never reset
  // their position for a background thumbnail/icon update.
  if (changed) render({ preserveScroll: true });
}

async function refreshApps({ append = false, deferRender = false } = {}) {
  if (!pluginEnabled("app") || !["all", "app"].includes(state.scope)) return;
  if (append && (state.appLoading || !state.appHasMore)) return;
  const token = ++appSearchToken;
  if (!append) appIconSearchToken += 1;
  const iconToken = appIconSearchToken;
  // Native app results include PNG data URLs; keep the first transfer small and
  // let the existing scroll pagination fetch the rest on demand.
  const limit = state.scope === "app" ? APP_PAGE_SIZE : 3;
  const offset = append ? state.appResults.length : 0;
  // Keep pagination responsive: metadata arrives first, native icons are filled in
  // asynchronously for the visible page.
  const includeIcons = false;
  state.appLoading = true;
  if (!append) state.appHasMore = true;
  if (append && !deferRender) render({ preserveScroll: true });
  try {
    const applications = await (window.flowhubSearchTiming ? window.flowhubSearchTiming.query("app", () => window.weborg?.pluginSearch("app", { query: state.query, limit, offset, includeIcons })) : window.weborg?.pluginSearch("app", { query: state.query, limit, offset, includeIcons }));
    if (token !== appSearchToken) return;
    window.flowhubSearchTiming?.applied();
    const next = applications || [];
    const existing = new Set(state.appResults.map((item) => item.path || item.id));
    state.appResults = append ? [...state.appResults, ...next.filter((item) => !existing.has(item.path || item.id))] : next;
    if (!state.query.trim() && !append) state.emptyResults.app = next.slice();
    const sameLoadedQuery = state.appLoadedQuery === state.query;
    state.appLoadedQuery = state.query;
    state.appLoadedLimit = append && sameLoadedQuery ? Math.max(state.appLoadedLimit, offset + limit) : limit;
    state.appHasMore = next.length === limit;
    void hydrateAppIcons(next, iconToken);
  } catch {
    if (!append) state.appResults = [];
  } finally {
    if (token === appSearchToken) {
      state.appLoading = false;
      if (!deferRender) render({ preserveScroll: append });
    }
  }
}

async function hydrateAppIcons(applications, token) {
  await new Promise((resolve) => setTimeout(resolve, 90));
  if (token !== appIconSearchToken) return;
  const paths = (applications || []).map((application) => application.path).filter(Boolean);
  if (!paths.length || !window.weborg?.loadAppIcons) return;
  try {
    const icons = await window.weborg.loadAppIcons(paths);
    if (token !== appIconSearchToken) return;
    const update = (application) => {
      const iconUrl = icons?.[application.path];
      return iconUrl ? { ...application, iconUrl } : application;
    };
    state.appResults = state.appResults.map(update);
    state.emptyResults.app = state.emptyResults.app.map(update);
    render({ preserveScroll: true });
  } catch {}
}

async function refreshWeb({ append = false, deferRender = false } = {}) {
  if (!pluginEnabled("web") || !["all", "web"].includes(state.scope)) return;
  if (append && (!["all", "web"].includes(state.scope) || state.webLoading || !state.webHasMore)) return;
  const token = ++webSearchToken;
  const limit = state.scope === "web" ? PLUGIN_PAGE_SIZE : 12;
  const offset = append ? state.webResults.length : 0;
  state.webLoading = true;
  if (!append) state.webHasMore = true;
  if (append && !deferRender) render({ preserveScroll: true });
  try {
    const pages = await (window.flowhubSearchTiming ? window.flowhubSearchTiming.query("web", () => window.weborg?.pluginSearch("web", { query: state.query, limit, offset })) : window.weborg?.pluginSearch("web", { query: state.query, limit, offset }));
    if (token !== webSearchToken) return;
    window.flowhubSearchTiming?.applied();
    const next = pages || [];
    const existing = new Set(state.webResults.map((item) => item.id || item.url));
    state.webResults = append ? [...state.webResults, ...next.filter((item) => !existing.has(item.id || item.url))] : next;
    if (!state.query.trim() && !append) state.emptyResults.web = next.slice();
    state.webLoadedQuery = state.query;
    state.webHasMore = next.length === limit;
  } catch {
    if (!append) state.webResults = [];
  } finally {
    if (token === webSearchToken) {
      state.webLoading = false;
      if (!deferRender) render({ preserveScroll: append });
    }
  }
}

async function refreshMemos({ append = false, deferRender = false } = {}) {
  if (!pluginEnabled("memo") || !["all", "memo"].includes(state.scope)) return;
  if (append && (!["all", "memo"].includes(state.scope) || state.memoLoading || !state.memoHasMore)) return;
  const token = ++memoSearchToken;
  const limit = state.scope === "memo" ? PLUGIN_PAGE_SIZE : 12;
  const offset = append ? state.memoResults.length : 0;
  state.memoLoading = true;
  if (!append) state.memoHasMore = true;
  if (append && !deferRender) render({ preserveScroll: true });
  try {
    const memos = await (window.flowhubSearchTiming ? window.flowhubSearchTiming.query("memo", () => window.weborg?.pluginSearch("memo", { query: state.query, limit, offset })) : window.weborg?.pluginSearch("memo", { query: state.query, limit, offset }));
    if (token !== memoSearchToken) return;
    window.flowhubSearchTiming?.applied();
    const next = memos || [];
    const existing = new Set(state.memoResults.map((item) => item.id));
    state.memoResults = append ? [...state.memoResults, ...next.filter((item) => !existing.has(item.id))] : next;
    if (!state.query.trim() && !append) state.emptyResults.memo = next.slice();
    state.memoLoadedQuery = state.query;
    state.memoHasMore = next.length === limit;
  } catch {
    if (!append) state.memoResults = [];
  } finally {
    if (token === memoSearchToken) {
      state.memoLoading = false;
      if (!deferRender) render({ preserveScroll: append });
    }
  }
}

async function refreshUsage() {
  if (state.scope === "clipboard" || state.query.trim()) return;
  const token = ++usageSearchToken;
  try {
    // Keep one complete usage snapshot and filter it client-side per scope.
    // This prevents a database/icon lookup on every Tab-based scope switch.
    const sections = await window.weborg?.searchUsage("all");
    if (token !== usageSearchToken) return;
    state.usageSections = sections || { frequent: [], recent: [] };
    state.usageLoadedScope = "all";
    render();
  } catch {}
}

async function refreshAllScopes() {
  if (state.scope !== "all") return;
  const token = ++allScopeRefreshToken;
  const query = state.query;
  let queued = false;
  const publish = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (token === allScopeRefreshToken && state.scope === "all" && state.query === query) render({ preserveScroll: true });
    });
  };
  await Promise.allSettled([
    refreshClipboard({ deferRender: true }),
    refreshApps({ deferRender: true }),
    refreshWeb({ deferRender: true }),
    refreshMemos({ deferRender: true })
  ].map(task => task.finally(publish)));
  if (token !== allScopeRefreshToken || state.scope !== "all" || state.query !== query) return;
  render({ preserveScroll: true });
}

function queueClipboardRefresh(delay = 180, refreshEmpty = false) {
  clearTimeout(clipboardSearchTimer);
  const timingRun = window.flowhubSearchTiming?.capture();
  clipboardSearchTimer = setTimeout(() => {
    window.flowhubSearchTiming?.dispatch(timingRun);
    if (!state.query.trim() && !refreshEmpty) {
      void refreshUsage();
      return;
    }
    if (!state.query.trim() && refreshEmpty) {
      void refreshClipboard();
      void refreshUsage();
      return;
    }
    if (state.scope === "all") void refreshAllScopes();
    else {
      void refreshClipboard();
      void refreshApps();
      void refreshWeb();
      void refreshMemos();
    }
    // Nonempty searches do not display usage cards; usage events refresh their cache.
  }, delay);
}

function queueWebInputSearch() {
  if (webInputSearchFrame) return;
  webInputSearchFrame = requestAnimationFrame(() => {
    webInputSearchFrame = null;
    window.flowhubSearchTiming?.dispatch(window.flowhubSearchTiming.capture());
    void refreshWeb();
  });
}

q.addEventListener("compositionstart", () => {
  searchInputComposing = true;
});
q.addEventListener("compositionend", () => {
  searchInputComposing = false;
  searchCompositionEndedAt = performance.now();
});
q.addEventListener("input", () => {
  window.flowhubSearchTiming?.begin("input");
  allResultKeys = null;
  allScopeRefreshToken += 1;
  invalidateClipboardPaging();
  invalidatePluginPaging();
  state.query = q.value;
  window.FlowHubTools.queryChanged(toolContext());
  queueDnsLookup();
  queueIpLookup();
  queueProxyLookup();
  if (!state.query.trim()) {
    state.clipboardResults = state.emptyResults.clipboard.slice();
    state.appResults = state.emptyResults.app.slice();
    state.webResults = state.emptyResults.web.slice();
    state.memoResults = state.emptyResults.memo.slice();
    state.clipboardHasMore = state.clipboardResults.length === CLIPBOARD_PAGE_SIZE;
    state.appHasMore = state.appResults.length === APP_PAGE_SIZE;
    state.webHasMore = state.webResults.length === 12;
    state.memoHasMore = state.memoResults.length === 12;
  }
  state.index = 0;
  const dedicatedWebSearch = state.scope === "web";
  if ((!dedicatedWebSearch || !state.query.trim()) && !inputRenderFrame) {
    inputRenderFrame = requestAnimationFrame(() => {
      inputRenderFrame = null;
      render();
    });
  }
  deferUncachedWebIcons();
  if (dedicatedWebSearch && state.query.trim()) {
    clearTimeout(clipboardSearchTimer);
    queueWebInputSearch();
  } else {
    queueClipboardRefresh();
  }
});
resultsEl.addEventListener("load", (event) => {
  const icon = event.target.closest?.("img[data-web-icon]");
  if (icon?.dataset.webIcon) loadedWebIcons.add(icon.dataset.webIcon);
}, true);
resultsEl.addEventListener("error", (event) => {
  const icon = event.target.closest?.("img[data-web-icon]");
  if (icon?.dataset.webIcon) failedWebIcons.add(icon.dataset.webIcon);
}, true);
resultsEl.addEventListener("scroll", () => {
  if (windowedResults && !windowRenderFrame) windowRenderFrame = requestAnimationFrame(() => { windowRenderFrame = 0; render({ preserveScroll: true }); });
  if (resultsEl.scrollHeight - resultsEl.scrollTop - resultsEl.clientHeight >= 160) return;
  if (state.scope === "all") void loadMoreAll();
  else if (state.scope === "clipboard") void refreshClipboard({ append: true });
  else if (state.scope === "app") void refreshApps({ append: true });
  else if (state.scope === "web") void refreshWeb({ append: true });
  else if (state.scope === "memo") void refreshMemos({ append: true });
});
settingsBtn?.addEventListener("click", () => window.weborg?.openSettings());
// A captured cold WKWebView sequence was mouseup -> mousedown, with no click.
// Navigation is reversible: activate on primary press instead of waiting for
// synthesized click. Keep click for keyboard/assistive activation; dedupe it.
function activateScopeControl(button) {
  if (button.dataset.scope) {
    if (state.scope !== button.dataset.scope) setScope(button.dataset.scope);
    else q?.focus({ preventScroll: true });
  } else if (button.dataset.clipboardKind) {
    if (state.clipboardKind !== button.dataset.clipboardKind) setClipboardKind(button.dataset.clipboardKind);
    else q?.focus({ preventScroll: true });
  }
}
function preserveSearchFocus(event) {
  const button = event.target.closest("[data-scope], [data-clipboard-kind]");
  if (event.button !== 0 || !button) return;
  event.preventDefault();
  activateScopeControl(button);
}
scopeRow?.addEventListener("mousedown", preserveSearchFocus);
clipboardKindRow?.addEventListener("mousedown", preserveSearchFocus);
scopeRow?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-scope]");
  if (button) activateScopeControl(button);
});
document.querySelectorAll("[data-clipboard-kind]").forEach((button) => button.addEventListener("click", () => activateScopeControl(button)));
window.weborg.onClipboardUpdated(() => {
  invalidateClipboardPaging();
  state.clipboardLoadedQuery = null;
  allResultKeys = null;
  allInitialResults = [];
  allScopeRefreshToken += 1;
  queueClipboardRefresh(80, true);
});
window.weborg.onUsageUpdated(() => { void refreshUsage(); });
resultsEl.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".result");
  if (!row) return;
  const item = matches()[+row.dataset.i];
  if (item?.type !== "clipboard") return;
  e.preventDefault();
  if (document.documentElement.dataset.weborgReadonly === "true") return;
  void window.weborg?.pluginAction("clipboard", "menu", { id: item.id });
});
resultsEl.addEventListener("click", (e) => {
  const command = e.target.closest("[data-copy-query]");
  if (command) {
    e.preventDefault(); e.stopPropagation();
    const item=matches()[Number(command.closest(".result")?.dataset.i)];
    const text=item&&portableQueryCommand(item);
    if (text) void copyText(text).then(()=>showActionStatus("查询命令已复制")).catch(()=>showActionStatus("复制失败"));
    return;
  }
  const action=e.target.closest("[data-tool-action]");
  if (action) {
    e.preventDefault();e.stopPropagation();
    Promise.resolve(window.FlowHubTools.action(action.dataset.toolId,action.dataset.toolAction,action,toolContext())).catch(error=>showActionStatus(error.message||"操作失败"));
    return;
  }
  const toggle = e.target.closest("[data-clipboard-toggle]");
  if (toggle) {
    e.preventDefault();
    e.stopPropagation();
    toggleClipboardPreview(toggle);
    return;
  }
  const row = e.target.closest(".result");
  if (row) { const p = matches()[+row.dataset.i]; if (p) choose(p); }
});
resultsEl.addEventListener("mousemove", (e) => {
  const row = e.target.closest(".result");
  if (!row) return;
  const i = Number(row.dataset.i);
  if (!Number.isFinite(i) || i === state.index) return;
  const position = usagePosition(matches(), i);
  if (position) state.usageColumn = position.column;
  resultsEl.querySelector(".result.active")?.classList.remove("active");
  row.classList.add("active");
  state.index = i;
});

function focusSearch() { q?.focus(); q?.select(); }
function prepareForShow() {
  void window.refreshSearchTiming?.();
  window.flowhubSearchTiming?.reset();
  allResultKeys = null;
  allInitialResults = [];
  allScopeRefreshToken += 1;
  clearTimeout(clipboardSearchTimer);
  for (const id of ["clipboard", "app", "web", "memo"]) {
    state[id + "Results"] = state.emptyResults[id].slice();
    state[id + "LoadedQuery"] = "";
  }
  if (q) q.value = "";
  state.query = "";
  window.FlowHubTools.queryChanged(toolContext());
  state.index = 0;
  clearTimeout(dnsSearchTimer);
  clearTimeout(proxySearchTimer);
  dnsSearchToken += 1;
  proxySearchToken += 1;
  state.dnsResult = null;
  state.proxyResult = null;
  clearTimeout(dnsSearchTimer);
  dnsSearchToken += 1;
  state.dnsResult = null;
  invalidateClipboardPaging({ resetPaging: false });
  invalidatePluginPaging({ resetPaging: false });
  state.clipboardHasMore = state.clipboardResults.length === CLIPBOARD_PAGE_SIZE;
  state.appHasMore = state.appResults.length >= 3;
  state.appLoadedLimit = state.appResults.length;
  state.webHasMore = state.webResults.length >= 12;
  state.memoHasMore = state.memoResults.length >= 12;
  resultsEl.scrollTop = 0;
  render();
  focusSearch();
  // Events can arrive while another scope is active, or just before this show
  // cancels its debounce. Paint the cache first, then reconcile with storage.
  state.clipboardLoadedQuery = null;
  void refreshClipboard();
}
window.focusSearch = focusSearch;
window.prepareForShow = prepareForShow;
window.weborg.onUpdateState?.((update) => renderVersion(update));

// 初始加载
async function initialize() {
  const plugins = await window.weborg.listPlugins();
  renderPluginScopes(plugins);
  const enabled = (id) => plugins.some((plugin) => plugin.id === id && plugin.enabled && plugin.available);
  const [cfg, records, applications, pages, memos, usageSections, update] = await Promise.all([
    window.weborg.getConfig(),
    enabled("clipboard") ? window.weborg.pluginSearch("clipboard", { query: "", kind: "all", limit: CLIPBOARD_PAGE_SIZE, offset: 0 }) : [],
    // Prime the same page size used by the dedicated 应用 scope. The all-scope
    // view only renders usage entries, so loading these extra lightweight
    // metadata rows here avoids a cold IPC/index request on the first switch
    // to 应用 after a restart.
    enabled("app") ? window.weborg.pluginSearch("app", { query: "", limit: APP_PAGE_SIZE, includeIcons: false }) : [],
    enabled("web") ? window.weborg.pluginSearch("web", { query: "", limit: 12 }) : [],
    enabled("memo") ? window.weborg.pluginSearch("memo", { query: "", limit: 12 }) : [],
    window.weborg.searchUsage("all"),
    window.weborg.getUpdateState()
  ]);
  setConfig(cfg);
  renderVersion(update);
  state.clipboardResults = records || [];
  state.clipboardLoadedQuery = "";
  state.emptyResults.clipboard = state.clipboardResults.slice();
  state.clipboardHasMore = state.clipboardResults.length === CLIPBOARD_PAGE_SIZE;
  state.appResults = applications || [];
  state.appLoadedQuery = "";
  state.appLoadedLimit = APP_PAGE_SIZE;
  state.emptyResults.app = state.appResults.slice();
  state.appHasMore = state.appResults.length === APP_PAGE_SIZE;
  // The startup prefetch now uses the dedicated app-page size to avoid a cold
  // query when switching scopes. Resolve those same rows' native icons in the
  // background so the app list does not remain on placeholder glyphs merely
  // because its metadata was already cached.
  void hydrateAppIcons(state.appResults, ++appIconSearchToken);
  state.webResults = pages || [];
  state.webLoadedQuery = "";
  state.emptyResults.web = state.webResults.slice();
  state.webHasMore = state.webResults.length === 12;
  state.memoResults = memos || [];
  state.memoLoadedQuery = "";
  state.emptyResults.memo = state.memoResults.slice();
  state.memoHasMore = state.memoResults.length === 12;
  state.usageSections = usageSections || { frequent: [], recent: [] };
  state.usageLoadedScope = "all";
  initialized = true;
  render();
  deferUncachedWebIcons(320);
  focusSearch();
}

void initialize();


// Pinning applies for this app session; explicit Escape/open actions still close it.
let launcherPinned = false;
function renderPinState(pinned) {
  launcherPinned = pinned;
  pinBtn.setAttribute("aria-pressed", String(pinned));
  const label = pinned
    ? "取消固定：切换到其他应用时自动收起"
    : "固定窗口：切换到其他应用时不自动收起";
  pinBtn.title = label;
  pinBtn.setAttribute("aria-label", label);
  pinBtn.dataset.tooltip = label;
}
if (pinBtn) {
  pinBtn.innerHTML = window.flowhubIcon("pin");
  renderPinState(false);
  pinBtn.disabled = !window.weborg?.setLauncherPinned;
  if (pinBtn.disabled) {
    pinBtn.title = pinBtn.dataset.tooltip = "固定窗口仅在桌面应用中可用";
  } else {
    window.weborg.getLauncherPinned().then(renderPinState).catch(() => {});
    pinBtn.addEventListener("click", async () => {
      pinBtn.disabled = true;
      try {
        renderPinState(await window.weborg.setLauncherPinned(!launcherPinned));
      } catch (error) {
        pinBtn.title = pinBtn.dataset.tooltip = `固定窗口失败：${error.message || error}`;
      } finally {
        pinBtn.disabled = false;
      }
    });
  }
}
settingsBtn.innerHTML = window.flowhubIcon("settings");
settingsBtn.title = "打开 FlowHub 设置";
settingsBtn.setAttribute("aria-label", settingsBtn.title);
settingsBtn.dataset.tooltip = settingsBtn.title;
