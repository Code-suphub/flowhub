// Search business controller. React owns markup and element events.
window.createFlowHubSearchController = function(root, publish) {
let disposed = false;
const cleanups = [], handlers = {};
const q = root.querySelector('#q'), resultsEl = root.querySelector('#results');
const bind = (target, name, callback) => {
  if (target === document || target === window) {
    target.addEventListener(name, callback);
    cleanups.push(() => target.removeEventListener(name, callback));
  } else handlers[target === q ? 'input:' + name : 'results:' + name] = callback;
};
const subscribe = (method, callback) => {
  const off = window.weborg[method]?.((...args) => { if (!disposed) return callback(...args); });
  if (typeof off === 'function') cleanups.push(off);
};
let updateState = null, statusText = '', launcherPinned = false;


let scopeOrder = ["all"];
const clipboardKinds = ["all", "text", "image", "file"];
const CLIPBOARD_PAGE_SIZE = 30;
const PLUGIN_PAGE_SIZE = 30;
const APP_PAGE_SIZE = 12;
const DEFAULT_SCOPE_SHORTCUTS = { all: "Shift+1", clipboard: "Shift+2", app: "Shift+3", web: "Shift+4", memo: "Shift+5" };

const state = { config: null, plugins: [], webResults: [], webHasMore: true, webLoading: false, query: "", index: 0, scope: "all", clipboardKind: "all", clipboardResults: [], clipboardHasMore: true, clipboardLoading: false, clipboardLoadedQuery: null, appResults: [], appHasMore: true, appLoading: false, appLoadedQuery: null, appLoadedLimit: 0, memoResults: [], memoHasMore: true, memoLoading: false, memoLoadedQuery: null, twofaResults: [], twofaHasMore: true, twofaLoading: false, twofaLoadedQuery: null, webLoadedQuery: null, usageSections: { frequent: [], recent: [] }, usageLoadedScope: null, emptyResults: { clipboard: [], app: [], web: [], memo: [], twofa: [] }, expandedClipboard: new Set(), editingClipboard: null, usageColumn: 0, dnsResult: null, dnsIpResults: {}, cloudflareResult: null,  ipResult: null, proxyResult: null };
let clipboardSearchToken = 0;
let appSearchToken = 0;
let appIconSearchToken = 0;
let webSearchToken = 0;
let memoSearchToken = 0;
let twofaSearchToken = 0;
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
let webIconTimer = null;
let showUncachedWebIcons = false;
const loadedWebIcons = new Set();
const failedWebIcons = new Set();

function renderVersion(update) { updateState = update; render({preserveScroll:true}); }



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

const toolEnabled = key => pluginEnabled("tools") && !["clipboard","memo"].includes(state.scope)
  && !(key === 'commandHistory' && document.documentElement.dataset.weborgReadonly === 'true')
  && state.config?.plugins?.tools?.settings?.[key] !== false;
// 参数模板与命令历史要点回搜索框重新执行，走和输入框一样的事件路径。
function applyQuery(text) {
  const value = String(text ?? "");
  if (!q || q.value === value) return;
  q.value = value;
  handlers['input:input']();
}
function toolContext() {
  return {query:state.query, queryNow:()=>state.query, api:window.weborg,
    enabled:toolEnabled, setQuery:applyQuery,
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
  if (typeof window.weborg?.copyText === "function") {
    await window.weborg.copyText(String(text));
    return;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(String(text));
      return;
    } catch {}
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
  clearTimeout(actionStatusTimer); statusText = String(message || ''); render({preserveScroll:true});
  actionStatusTimer = setTimeout(() => {statusText = ''; render({preserveScroll:true});}, 2400);
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



function deferUncachedWebIcons(delay = 260) {
  showUncachedWebIcons = false;
  clearTimeout(webIconTimer);
  webIconTimer = setTimeout(() => {
    showUncachedWebIcons = true;
    render({ preserveScroll: true });
  }, delay);
}
function setConfig(config) {
  if (configuredSearchOrder(state.config).join() !== configuredSearchOrder(config).join()) {
    allResultKeys = null;
    allInitialResults = [];
    state.index = 0;
  }
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

function twofaMatches() {
  return (state.twofaResults || []).map((entry) => ({ ...entry, type: "twofa", pluginId: "twofa" }));
}



function usageKey(item) {
  return `${item.type}:${item.usageKey || item.id || item.path || item.url || item.title}`;
}

function usageMatches() {
  if (state.query.trim() || state.scope === "clipboard") return [];
  const entries = [];
  for (const section of ["frequent", "recent"]) {
    const sectionItems = [...(state.usageSections?.[section] || [])];
    for (const item of sectionItems) {
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
function configuredSearchOrder(config) {
  const hasTwofa = Boolean(config?.plugins?.twofa)
    || (Array.isArray(state.plugins) && state.plugins.some((plugin) => plugin.id === "twofa"));
  const defaults = config?.core?.webBeforeClipboard === false
    ? ["app", "clipboard", "web", "memo"] : ["app", "web", "clipboard", "memo"];
  if (hasTwofa) defaults.push("twofa");
  const saved = config?.core?.searchResultOrder;
  return [...new Set([...(Array.isArray(saved) ? saved : []), ...defaults])]
    .filter(id => defaults.includes(id));
}
function orderedSources(groups) {
  return configuredSearchOrder(state.config).flatMap(id => groups[id] || []);
}
function orderedAllSources(groups) {
  const order = ["clipboard", "app", "web", "memo", "twofa"];
  return order.flatMap(id => groups[id] || []);
}
function allCandidates() {
  const groups = {
    app: pluginEnabled("app") ? appMatches() : [],
    web: pluginEnabled("web") ? pageMatches().map(page => ({ ...page, type: "page" })) : [],
    clipboard: pluginEnabled("clipboard") ? clipboardMatches() : [],
    memo: pluginEnabled("memo") ? memoMatches() : [],
    twofa: pluginEnabled("twofa") && typeof twofaMatches === "function" ? twofaMatches() : []
  };
  return state.query.trim() ? orderedSources(groups) : orderedAllSources(groups);
}
function allHasMore() {
  const shown = new Set(allResultKeys || matches().map(resultKey));
  return allCandidates().some(item => !shown.has(resultKey(item)))
    || (pluginEnabled("clipboard") && state.clipboardHasMore)
    || (pluginEnabled("app") && state.appHasMore)
    || (pluginEnabled("web") && state.webHasMore)
    || (pluginEnabled("memo") && state.memoHasMore)
    || (pluginEnabled("twofa") && state.twofaHasMore);
}
async function loadMoreAll() {
  if (allPaging || state.scope !== "all") return;
  // Do not page old-query data while the debounced first page is pending.
  if ((pluginEnabled("clipboard") && state.clipboardLoadedQuery !== state.query)
    || (pluginEnabled("app") && state.appLoadedQuery !== state.query)
    || (pluginEnabled("web") && state.webLoadedQuery !== state.query)
    || (pluginEnabled("memo") && state.memoLoadedQuery !== state.query)
    || (pluginEnabled("twofa") && state.twofaLoadedQuery !== state.query)) return;
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
        state.memoHasMore ? refreshMemos({ append: true, deferRender: true }) : null,
        state.twofaHasMore ? refreshTwofa({ append: true, deferRender: true }) : null
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
  if (state.scope === "twofa") return typeof twofaMatches === "function" ? twofaMatches() : [];
  if (!state.query.trim()) {
    const regularLimit = usages.length ? 4 : 6;
    const visibleUsages = usages.slice(0, 8);
    return [...visibleUsages, ...orderedAllSources({
      app: withoutUsageDuplicates(apps, visibleUsages).slice(0, 3),
      web: withoutUsageDuplicates(pages, visibleUsages).slice(0, regularLimit),
      clipboard: clips.slice(0, regularLimit), memo: memos.slice(0, 4), twofa: typeof twofaMatches === "function" ? twofaMatches().slice(0, 4) : []
    })].slice(0, 12);
  }
  const appResults = state.query.trim() ? apps.slice(0, 3) : [];
  const memoResults = state.query.trim() ? memos.slice(0, 4) : [];
  const twofaResults = state.query.trim() && typeof twofaMatches === "function" ? twofaMatches().slice(0, 4) : [];
  const regularLimit = appResults.length || memoResults.length ? 3 : 6;
  return [...tools, ...(addWeb ? [addWeb] : []), ...orderedSources({
    app: appResults, web: pages.slice(0, regularLimit), clipboard: clips.slice(0, regularLimit), memo: memoResults, twofa: twofaResults
  })].slice(0, 12);
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

function toggleClipboardPreview(button) {
  const id = Number(button.dataset.clipboardToggle);
  if (state.expandedClipboard.has(id)) state.expandedClipboard.delete(id); else state.expandedClipboard.add(id);
  render({preserveScroll:true});
}

function isExpandableClipboard(item) {
  if (item.kind !== "text") return false;
  const content = String(item.content || "");
  return content.length > 120 || content.split("\n").length > 3;
}

// 剪贴板高频操作：粘贴（原格式）、纯文本粘贴、置顶、编辑副本。
// 置顶与编辑都改数据库，完成后重新取第一页；粘贴会隐藏窗口，不再刷新。
function clipboardAction(action, item, extra = {}) {
  if (document.documentElement.dataset.weborgReadonly === "true") {
    const reason = "浏览器预览不能修改剪贴板";
    showActionStatus(reason);
    return Promise.resolve({ ok: false, reason });
  }
  return Promise.resolve(window.weborg?.pluginAction("clipboard", action, { id: Number(item.id ?? item), ...extra }))
    .then((result) => {
      if (result?.ok === false && !result.cancelled) showActionStatus(result.reason || "操作失败");
      return result;
    })
    .catch((error) => {
      showActionStatus(error?.message || String(error || "操作失败"));
      return { ok: false };
    });
}

function pasteClipboardPlain(item) {
  if (!["text", "file"].includes(item.kind)) return showActionStatus("图片记录没有可粘贴的文本");
  return clipboardAction("plain", item);
}

function requestClipboardDelete(item) {
  if (document.documentElement.dataset.weborgReadonly === 'true') return showActionStatus('浏览器预览不能删除剪贴板记录');
  if (state.deletingClipboard?.busy) return;
  state.deletingClipboard = {id:Number(item.id),busy:false,error:''};
  render({preserveScroll:true});
}
function cancelClipboardDelete() {
  if (state.deletingClipboard?.busy) return;
  state.deletingClipboard = null;
  render({preserveScroll:true});
}
async function confirmClipboardDelete() {
  const pending = state.deletingClipboard;
  if (!pending || pending.busy) return;
  pending.busy = true; pending.error = ''; render({preserveScroll:true});
  const result = await clipboardAction('delete',pending.id,{confirmed:true});
  if (result?.ok === false) {
    pending.busy = false; pending.error = result.reason || '删除失败，请重试';
    render({preserveScroll:true}); return;
  }
  state.deletingClipboard = null;
  showActionStatus('已删除剪贴板历史记录');
  await refreshClipboard();
}

function toggleClipboardPin(item) {
  const pinned = !item.pinnedAt;
  return clipboardAction("pin", item, { pinned }).then((result) => {
    if (result?.ok === false) return result;
    showActionStatus(pinned ? "已置顶，过期清理不会删除" : "已取消置顶");
    return refreshClipboard();
  });
}

function startClipboardEdit(item) {
  if (item.kind !== "text") return showActionStatus("只有文本记录可以编辑副本");
  state.editingClipboard = { id: Number(item.id), text: String(item.content || "") };
  render({ preserveScroll: true });
  requestAnimationFrame(() => resultsEl.querySelector(".clipboard-editor")?.focus());
  return undefined;
}

function cancelClipboardEdit() {
  if (!state.editingClipboard) return;
  state.editingClipboard = null;
  render({ preserveScroll: true });
  returnToSearch();
}

function saveClipboardEdit() {
  const editing = state.editingClipboard;
  if (!editing) return Promise.resolve();
  const editor = resultsEl.querySelector(".clipboard-editor");
  const text = editor ? editor.value : editing.text;
  if (!text.trim()) {
    showActionStatus("编辑后的内容不能为空");
    editor?.focus();
    return Promise.resolve();
  }
  return clipboardAction("edit", editing.id, { content: text }).then((result) => {
    if (result?.ok === false) return result;
    state.editingClipboard = null;
    showActionStatus("已保存为新的文本记录，原记录保留");
    return refreshClipboard();
  });
}



function runResultAction(action, item) {
  if (action === "open") return choose(item);
  if (action === "copy-query") {
    const text = portableQueryCommand(item);
    if (!text) return showActionStatus("这条结果没有可复制的命令");
    return copyText(text).then(() => showActionStatus("查询命令已复制")).catch(() => showActionStatus("复制失败"));
  }
  if (action !== "copy") return undefined;
  if (item.type === "twofa") return choose(item);
  const text = item.type === "page" || item.type === "web" || item.type === "web-add"
    ? normalizeUrl(item.url)
    : item.type === "app" ? String(item.path || "")
    : item.type === "memo" ? String(item.content || "")
    : String(item.result || "");
  if (!text) return showActionStatus("没有可复制的内容");
  const message = item.type === "app" ? "路径已复制" : item.type === "web" ? "链接已复制" : "已复制";
  return copyText(text).then(() => showActionStatus(message)).catch(() => showActionStatus("复制失败"));
}

const resultWindow = new window.FlowHubResultWindow();
let windowedResults = false;
let windowRenderFrame = 0;
function render(options = {}) {
  if (window.flowhubSearchTiming) return window.flowhubSearchTiming.render(() => renderSnapshot(options), {deferCommit:true});
  return renderSnapshot(options);
}
function renderSnapshot(options = {}) {
  if (disposed) return;
  const timing = {run:window.flowhubSearchTiming?.capture(),startedAt:performance.now()};
  if (!options.preserveScroll && resultsEl.scrollTop) resultsEl.scrollTop = 0;
  const items = state.config ? matches() : [];
  state.index = Math.max(0, Math.min(state.index, items.length - 1));
  windowedResults = items.length > 80;
  const plan = windowedResults ? resultWindow.plan(items, resultKey, resultsEl.scrollTop, resultsEl.clientHeight, options.targetIndex) : null;
  const paging = state.scope === 'all' ? {loading:allPaging,hasMore:state.config && allHasMore()} : {loading:state[state.scope+'Loading'],hasMore:state[state.scope+'HasMore']};
  publish({state:{...state,expandedClipboard:new Set(state.expandedClipboard)},items,plan,paging,statusText,updateState,launcherPinned,showUncachedWebIcons,loadedWebIcons,failedWebIcons,timing});
  if (options.targetIndex != null) requestAnimationFrame(() => {
    if (disposed) return;
    if (plan) resultsEl.scrollTop = plan.targetTop;
    resultsEl.querySelector('.result[data-i="'+state.index+'"]')?.scrollIntoView({block:'nearest'});
  });
}


// 结果操作焦点顺序：F6 进入当前结果的第一个操作按钮，再按 F6 在按钮之间前进，
// 走过最后一个回到搜索框；⇧F6 反向进入。按钮之间也可以直接用 Tab。
function focusResultAction(direction = 1) {
  const actions = [...resultsEl.querySelectorAll(".result.active .tool-action")].filter((button) => !button.disabled);
  const current = typeof document.activeElement === "undefined" ? null : document.activeElement;
  if (!actions.length) { returnToSearch(); return; }
  const index = actions.indexOf(current);
  if (index < 0) {
    (direction > 0 ? actions[0] : actions[actions.length - 1]).focus();
    return;
  }
  const next = index + direction;
  if (next < 0 || next >= actions.length) { returnToSearch(); return; }
  actions[next].focus();
}

// 底部快捷键说明只列当前真的能用的操作：范围、选中结果类型和剪贴板插件状态
// 都会改变可用项，避免显示未实现或当前不可用的快捷键。
function updateKeyboardHint() {}
function revealActiveResult() { render({preserveScroll:true,targetIndex:state.index}); }


function choose(page) {
  if (page?.toolId) { Promise.resolve(window.FlowHubTools.choose(page,toolContext())).catch(error=>showActionStatus(error.message||"操作失败")); return; }
  if (page?.type === "twofa") {
    Promise.resolve(window.weborg.pluginAction("twofa", "activate", { id: page.id, title: page.title }))
      .then((result) => {
        if (!result?.code) throw new Error("获取验证码失败");
        return copyText(result.code).then(() => showActionStatus(`已复制 ${result.name || page.title} 的验证码`));
      })
      .catch((error) => showActionStatus(error.message || "获取验证码失败"));
    return;
  }
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
  const payload = {
    id: page.id,
    path: page.path,
    url: normalizeUrl(page.url),
    content: page.content,
    usage
  };
  return Promise.resolve().then(() => {
    if (typeof window.weborg?.pluginAction !== "function") throw new Error("当前环境无法执行打开操作");
    return window.weborg.pluginAction(pluginId, "activate", payload);
  }).then(result => {
    if (result?.ok === false && !result.cancelled) showActionStatus(result.reason || "操作失败");
    return result;
  }).catch(error => {
    showActionStatus(error?.message || String(error || "操作失败"));
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
 state.plugins = (plugins || []).filter(p => p.enabled && p.available).sort((a,b)=>a.order-b.order);
 scopeOrder = ['all',...state.plugins.filter(p=>p.searchable).map(p=>p.id)];
 if (!scopeOrder.includes(state.scope)) state.scope = 'all';
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
  twofaSearchToken += 1;
  appIconSearchToken += 1;
  state.appLoading = false;
  state.webLoading = false;
  state.memoLoading = false;
  state.twofaLoading = false;
  if (resetPaging) {
    state.appHasMore = false;
    state.webHasMore = false;
    state.memoHasMore = false;
    state.twofaHasMore = false;
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
  renderKeyboardHint();
  render();
  // Scope switches should be instant when the current query is already cached.
  // Only refresh the active scope when its data is stale; this avoids spawning
  // several IPC calls (and native icon scans) for every Tab press.
  if (scope === "all") {
    const stale = (pluginEnabled("clipboard") && state.clipboardLoadedQuery !== state.query)
      || (pluginEnabled("app") && state.appLoadedQuery !== state.query)
      || (pluginEnabled("web") && state.webLoadedQuery !== state.query)
      || (pluginEnabled("memo") && state.memoLoadedQuery !== state.query)
      || (pluginEnabled("twofa") && state.twofaLoadedQuery !== state.query);
    if (stale) void refreshAllScopes();
  } else if (scope === "clipboard") {
    if (state.clipboardLoadedQuery !== state.query && !state.clipboardLoading) void refreshClipboard();
  }
  if (scope === "app") {
    if (!state.appLoading && (state.appLoadedQuery !== state.query || (scope === "app" && state.appLoadedLimit < APP_PAGE_SIZE))) void refreshApps();
    else if (state.appResults.some(item => !item.iconUrl)) void hydrateAppIcons(state.appResults, appIconSearchToken);
  }
  if (scope === "web") {
    if (state.webLoadedQuery !== state.query) void refreshWeb();
  }
  if (scope === "memo") {
    if (state.memoLoadedQuery !== state.query) void refreshMemos();
  }
  if (scope === "twofa") {
    if (state.twofaLoadedQuery !== state.query) void refreshTwofa();
  }
  q?.focus({ preventScroll: true });
}

function moveScope(offset) {
  const current = Math.max(0, scopeOrder.indexOf(state.scope));
  setScope(scopeOrder[(current + offset + scopeOrder.length) % scopeOrder.length]);
}

function renderKeyboardHint() {}

function setClipboardKind(kind) {
  if (!clipboardKinds.includes(kind)) return;
  invalidateClipboardPaging();
  state.clipboardKind = kind;
  state.index = 0;
  render();
  void refreshClipboard();
  q?.focus({ preventScroll: true });
}

// 更新配置（主进程每次呼出都会推送）
subscribe("onConfig", async (cfg) => {
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


bind(document, "keydown", (e) => {
  // The shared Dialog owns Escape, Enter and its focus trap while confirming.
  if (state.deletingClipboard) return;
  // 编辑副本时键盘归编辑框：Esc 取消、⌘↩ 保存，其余按键交给当前聚焦的控件，
  // 不再触发搜索导航、范围快捷键或隐藏窗口。
  if (state.editingClipboard) {
    if (e.key === "Escape") { e.preventDefault(); cancelClipboardEdit(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveClipboardEdit(); return; }
    return;
  }
  // 组合输入期间不抢焦点：IME 的按键交给输入法，F6 也在之后才处理。
  const justCommittedComposition = e.key === "Enter" && performance.now() - searchCompositionEndedAt < 80;
  if (searchInputComposing || e.isComposing || e.keyCode === 229 || e.key === "Process" || justCommittedComposition) return;
  if (e.key === "F6") { e.preventDefault(); focusResultAction(e.shiftKey ? -1 : 1); return; }
  if (e.target.closest?.(".tool-action") && ["Enter"," ","Tab"].includes(e.key)) return;
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === "KeyK" || e.key.toLowerCase() === "k")) {
    e.preventDefault();
    returnToSearch();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    // 焦点在结果操作栏里时先回到搜索框，再按一次才隐藏窗口。
    if (resultsEl.contains(document.activeElement)) { returnToSearch(); return; }
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
    // 焦点已经在结果操作栏里：交给浏览器的顺序，Tab 不再切换范围。
    if (resultsEl.contains(document.activeElement)) return;
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
  // 剪贴板高频操作的快捷键：⌘D 置顶/取消置顶、⌘E 编辑副本、⇧↩ 纯文本粘贴。
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === "KeyD" || e.key.toLowerCase() === "d")) {
    const selected = m[state.index];
    if (selected?.type === "clipboard") { e.preventDefault(); void toggleClipboardPin(selected); }
    return;
  }
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === "KeyE" || e.key.toLowerCase() === "e")) {
    const selected = m[state.index];
    if (selected?.type === "clipboard") { e.preventDefault(); startClipboardEdit(selected); }
    return;
  }
  if (e.altKey && ["Backspace", "Delete"].includes(e.key)) {
    const selected = m[state.index];
    if (selected?.type === "clipboard" && document.documentElement.dataset.weborgReadonly !== "true") {
      requestClipboardDelete(selected);
      e.preventDefault();
      return;
    }
  }
  if (e.key === "ArrowDown") { moveVertical(m, 1); revealActiveResult(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { moveVertical(m, -1); revealActiveResult(); e.preventDefault(); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const offset = e.key === "ArrowRight" ? 1 : -1;
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && moveUsageHorizontal(m, offset)) {
      revealActiveResult();
      e.preventDefault();
    }
  }
  else if (e.key === "Enter") {
    const p = m[state.index];
    if (p) {
      if (e.shiftKey && p.type === "clipboard") { e.preventDefault(); void pasteClipboardPlain(p); }
      else choose(p);
    }
  }
});

bind(document, "keyup", (e) => {
  if (e.key !== "Tab" || !scopeTabHeld) return;
  e.preventDefault();
  if (!scopeTabUsedWithArrow) moveScope(scopeTabTapOffset);
  scopeTabHeld = false;
  scopeTabUsedWithArrow = false;
  q?.focus({ preventScroll: true });
});

bind(window, "blur", () => {
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
    if (token === appSearchToken && !append) state.appResults = [];
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
  const paths = (applications || []).filter(application => !application.iconUrl).map((application) => application.path).filter(Boolean);
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
    if (token === webSearchToken && !append) state.webResults = [];
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
    if (token === memoSearchToken && !append) state.memoResults = [];
  } finally {
    if (token === memoSearchToken) {
      state.memoLoading = false;
      if (!deferRender) render({ preserveScroll: append });
    }
  }
}

async function refreshTwofa({ append = false, deferRender = false } = {}) {
  if (!pluginEnabled("twofa") || !["all", "twofa"].includes(state.scope)) return;
  if (append && (!['all', 'twofa'].includes(state.scope) || state.twofaLoading || !state.twofaHasMore)) return;
  const token = ++twofaSearchToken;
  const limit = state.scope === "twofa" ? PLUGIN_PAGE_SIZE : 12;
  const offset = append ? state.twofaResults.length : 0;
  state.twofaLoading = true;
  if (!append) state.twofaHasMore = true;
  if (append && !deferRender) render({ preserveScroll: true });
  try {
    const records = await window.weborg.pluginSearch("twofa", { query: state.query, limit, offset });
    if (token !== twofaSearchToken) return;
    const next = records || [];
    const existing = new Set(state.twofaResults.map((item) => item.id));
    state.twofaResults = append ? [...state.twofaResults, ...next.filter((item) => !existing.has(item.id))] : next;
    state.twofaLoadedQuery = state.query;
    state.twofaHasMore = next.length === limit;
  } catch {
    if (token === twofaSearchToken && !append) state.twofaResults = [];
  } finally {
    if (token === twofaSearchToken) {
      state.twofaLoading = false;
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
    refreshMemos({ deferRender: true }),
    refreshTwofa({ deferRender: true })
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
      void refreshTwofa();
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

bind(q, "compositionstart", () => {
  searchInputComposing = true;
});
bind(q, "compositionend", () => {
  searchInputComposing = false;
  searchCompositionEndedAt = performance.now();
});
bind(q, "input", () => {
  window.flowhubSearchTiming?.begin("input");
  state.editingClipboard = null;
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
    state.twofaResults = (state.emptyResults.twofa || []).slice();
    state.clipboardHasMore = state.clipboardResults.length === CLIPBOARD_PAGE_SIZE;
    state.appHasMore = state.appResults.length === APP_PAGE_SIZE;
    state.webHasMore = state.webResults.length === 12;
    state.memoHasMore = state.memoResults.length === 12;
    state.twofaHasMore = state.twofaResults.length === 12;
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
bind(resultsEl, "load", (event) => {
  const icon = event.target.closest?.("img[data-web-icon]");
  if (icon?.dataset.webIcon) loadedWebIcons.add(icon.dataset.webIcon);
}, true);
bind(resultsEl, "error", (event) => {
  const icon = event.target.closest?.("img[data-web-icon]");
  if (icon?.dataset.webIcon) failedWebIcons.add(icon.dataset.webIcon);
}, true);
bind(resultsEl, "scroll", () => {
  if (windowedResults && !windowRenderFrame) windowRenderFrame = requestAnimationFrame(() => { windowRenderFrame = 0; render({ preserveScroll: true }); });
  if (resultsEl.scrollHeight - resultsEl.scrollTop - resultsEl.clientHeight >= 160) return;
  if (state.scope === "all") void loadMoreAll();
  else if (state.scope === "clipboard") void refreshClipboard({ append: true });
  else if (state.scope === "app") void refreshApps({ append: true });
  else if (state.scope === "twofa") void refreshTwofa({ append: true });
  else if (state.scope === "web") void refreshWeb({ append: true });
  else if (state.scope === "memo") void refreshMemos({ append: true });
});

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


subscribe("onClipboardUpdated", () => {
  invalidateClipboardPaging();
  state.clipboardLoadedQuery = null;
  allResultKeys = null;
  allInitialResults = [];
  allScopeRefreshToken += 1;
  queueClipboardRefresh(80, true);
});
subscribe("onUsageUpdated", () => { void refreshUsage(); });
// Keep keyboard navigation available after an application click, including a
// WebKit release-before-press sequence. Launch only after a matching release;
// ordinary presses still wait for click. Never apply this to paste/delete.
let releasedAppPress = null;
let recoveredAppClick = null;
bind(resultsEl, "mouseup", (e) => {
  const row = e.target.closest(".result");
  const item = row && matches()[Number(row.dataset.i)];
  releasedAppPress = e.button === 0 && item?.type === "app"
    ? { row, path:item.path, stamp:e.timeStamp, received:performance.now() } : null;
});
bind(resultsEl, "mousedown", (e) => {
  const released = releasedAppPress;
  releasedAppPress = null;
  recoveredAppClick = null;
  const row = e.target.closest(".result");
  const item = row && matches()[Number(row.dataset.i)];
  if (e.button !== 0 || item?.type !== "app") return;
  e.preventDefault();
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (released?.row === row && released.path === item.path
    && e.timeStamp < released.stamp && released.stamp-e.timeStamp < 1000
    && performance.now()-released.received < 100) {
    recoveredAppClick = {row,down:e.timeStamp,up:released.stamp};
    choose(item);
  }
});
bind(resultsEl, "contextmenu", (e) => {
  const row = e.target.closest(".result");
  if (!row) return;
  const item = matches()[+row.dataset.i];
  if (item?.type === "page" || item?.type === "web-add") {
    e.preventDefault();
    const url = normalizeUrl(item.url);
    if (!url || typeof window.weborg?.openSettings !== "function") return;
    void window.weborg.openSettings({ initialUrl: url });
    return;
  }
  if (item?.type !== "clipboard") return;
  e.preventDefault();
  if (document.documentElement.dataset.weborgReadonly === "true") return;
  requestClipboardDelete(item);
});
bind(resultsEl, "click", (e) => {
  const resultAction = e.target.closest("[data-result-action]");
  if (resultAction) {
    e.preventDefault(); e.stopPropagation();
    const item = matches()[Number(resultAction.dataset.resultIndex)];
    if (item) void Promise.resolve(runResultAction(resultAction.dataset.resultAction, item));
    return;
  }
  const clipAction = e.target.closest("[data-clipboard-action]");
  if (clipAction) {
    e.preventDefault();e.stopPropagation();
    const id = Number(clipAction.dataset.clipboardId);
    const item = state.clipboardResults.find(record => Number(record.id) === id);
    if (!item) return;
    if (clipAction.dataset.clipboardAction === "pin") void toggleClipboardPin(item);
    if (clipAction.dataset.clipboardAction === "plain") void pasteClipboardPlain(item);
    if (clipAction.dataset.clipboardAction === "edit") startClipboardEdit(item);
    if (clipAction.dataset.clipboardAction === "edit-save") void saveClipboardEdit();
    if (clipAction.dataset.clipboardAction === "edit-cancel") cancelClipboardEdit();
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
  if (recoveredAppClick?.row === row && e.detail !== 0
    && e.timeStamp >= recoveredAppClick.down && e.timeStamp <= recoveredAppClick.up) {
    recoveredAppClick = null;
    return;
  }
  if (row) { const p = matches()[+row.dataset.i]; if (p) choose(p); }
});
bind(resultsEl, "mousemove", (e) => {
  const row = e.target.closest(".result");
  if (!row) return;
  const i = Number(row.dataset.i);
  if (!Number.isFinite(i) || i === state.index) return;
  const position = usagePosition(matches(), i);
  if (position) state.usageColumn = position.column;
  state.index = i;
  render({preserveScroll:true});
});

function focusSearch() { if (state.deletingClipboard || state.editingClipboard) return; q?.focus(); q?.select(); }
function focusSearchAfterWindowActivation() {
  // A non-activating macOS panel becomes key before WebView focus is settled.
  // Wait two paints so the first keystroke cannot leak to the previous app.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!document.hidden) focusSearch();
  }));
}
function prepareForShow() {
  void window.refreshSearchTiming?.();
  window.flowhubSearchTiming?.reset();
  allResultKeys = null;
  allInitialResults = [];
  allScopeRefreshToken += 1;
  clearTimeout(clipboardSearchTimer);
  for (const id of ["clipboard", "app", "web", "memo", "twofa"]) {
    state[id + "Results"] = (state.emptyResults[id] || []).slice();
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
  state.twofaHasMore = state.twofaResults.length >= 12;
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
bind(window, "focus", focusSearchAfterWindowActivation);
bind(document, "visibilitychange", () => {
  if (!document.hidden) focusSearchAfterWindowActivation();
});
subscribe("onUpdateState", renderVersion);

// 初始加载
async function initialize() {
  const plugins = await window.weborg.listPlugins();
  if (disposed) return;
  renderPluginScopes(plugins);
  const enabled = (id) => plugins.some((plugin) => plugin.id === id && plugin.enabled && plugin.available);
  const [cfg, records, applications, pages, memos, twofa, usageSections, update] = await Promise.all([
    window.weborg.getConfig(),
    enabled("clipboard") ? window.weborg.pluginSearch("clipboard", { query: "", kind: "all", limit: CLIPBOARD_PAGE_SIZE, offset: 0 }) : [],
    // Prime the same page size used by the dedicated 应用 scope. The all-scope
    // view only renders usage entries, so loading these extra lightweight
    // metadata rows here avoids a cold IPC/index request on the first switch
    // to 应用 after a restart.
    enabled("app") ? window.weborg.pluginSearch("app", { query: "", limit: APP_PAGE_SIZE, includeIcons: false }) : [],
    enabled("web") ? window.weborg.pluginSearch("web", { query: "", limit: 12 }) : [],
    enabled("memo") ? window.weborg.pluginSearch("memo", { query: "", limit: 12 }) : [],
    enabled("twofa") ? window.weborg.pluginSearch("twofa", { query: "", limit: 12 }) : [],
    window.weborg.searchUsage("all"),
    window.weborg.getUpdateState()
  ]);
  if (disposed) return;
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
  state.twofaResults = twofa || [];
  state.twofaLoadedQuery = "";
  state.emptyResults.twofa = state.twofaResults.slice();
  state.twofaHasMore = state.twofaResults.length === 12;
  state.usageSections = usageSections || { frequent: [], recent: [] };
  state.usageLoadedScope = "all";
  initialized = true;
  render();
  deferUncachedWebIcons(320);
  focusSearch();
  if (state.query.trim()) queueClipboardRefresh(0);
}

const ready = initialize().catch(error => showActionStatus(error.message || '初始化失败'));

// Explicit native-only QA bridge. Reports contain counts/lengths, never values,
// URLs, commands, clipboard content or native process identities.
const diagnosticBridge = {
  ready,
  checkpoint() {
    const query = q.value, scope = state.scope;
    return () => { if (!disposed) { applyQuery(query); setScope(scope); } };
  },
  setQuery: applyQuery, setScope, refreshAll: refreshAllScopes, loadMore: loadMoreAll,
  hasTool: id => matches().some(item => item.toolId === id),
  resultsElement: () => resultsEl,
  inspect({details = false} = {}) {
    const sources = ['clipboard','app','web','memo','twofa'];
    const items = matches();
    return {
      initialized: initialized && !disposed,
      loading: sources.some(id => state[id+'Loading']), paging: allPaging,
      loaded: items.length, hasMore: initialized && allHasMore(),
      rows: resultsEl.querySelectorAll('.result').length,
      htmlChars: details ? resultsEl.outerHTML.length : undefined,
      sizes: details ? items.slice(0,120).map(item => ({type:item.type,content:String(item.content||'').length,
        preview:String(item.content||'').split('\n').slice(0,2).join('\n').length,
        description:String(item.description||'').length,title:String(item.title||'').length,
        icon:String(item.iconUrl||item.imageUrl||'').length})) : undefined,
      queriesCurrent: sources.map(id => ({source:id,current:state[id+'LoadedQuery']===state.query,
        hasMore:state[id+'HasMore'],count:state[id+'Results'].length}))
    };
  }
};
if (window.__TAURI__?.core?.invoke) window.FlowHubSearchDiagnostics = diagnosticBridge;

// Synthetic harness only: fixture owns the adapter and native access is absent.
// No state, records, keys, or native diagnostic bridge cross this boundary.
const fixture = !window.__TAURI__ && window.FlowHubSearchFixture?.api === window.weborg
  ? window.FlowHubSearchFixture : null;
if (fixture) {
  const refreshers = {clipboard:refreshClipboard,app:refreshApps,web:refreshWeb,memo:refreshMemos,twofa:refreshTwofa};
  const fixtureBridge = Object.freeze({
    ready,
    async reset() {
      await ready;
      if (disposed || !initialized) throw new Error('fixture-not-ready');
      clearTimeout(clipboardSearchTimer);
      invalidateClipboardPaging(); invalidatePluginPaging(); ++allScopeRefreshToken;
      allResultKeys = null; allInitialResults = []; allPaging = false;
      state.query = ''; q.value = ''; state.scope = 'all'; state.index = 0;
      state.editingClipboard = null; state.expandedClipboard.clear();
      for (const id of Object.keys(refreshers)) {
        state[id+'Results'] = []; state.emptyResults[id] = [];
        state[id+'LoadedQuery'] = null; state[id+'HasMore'] = true;
      }
      window.FlowHubTools.queryChanged(toolContext());
      await refreshAllScopes();
    },
    select(index) {
      state.index = Math.max(0, Math.min(matches().length-1, Number(index) || 0));
      revealActiveResult();
    },
    reopen: prepareForShow,
    async loadMore() {
      if (state.scope === 'all') await loadMoreAll();
      else await refreshers[state.scope]?.({append:true});
    },
    inspect() {
      const items = matches();
      return {initialized:initialized && !disposed,scope:state.scope,
        loading:Object.keys(refreshers).some(id=>state[id+'Loading']) || allPaging,
        loaded:items.length,unique:new Set(items.map(resultKey)).size,
        hasMore:state.scope==='all'?allHasMore():Boolean(state[state.scope+'HasMore'])};
    }
  });
  fixture.connect(fixtureBridge);
  cleanups.push(() => fixture.disconnect(fixtureBridge));
}


if (window.weborg.getLauncherPinned) window.weborg.getLauncherPinned().then(value => {launcherPinned=value;render({preserveScroll:true});}).catch(()=>{});
return { ready, handlers, state, resultWindow, render, returnToSearch, setScope, setClipboardKind, preserveSearchFocus, activateScopeControl, confirmClipboardDelete, cancelClipboardDelete,
  togglePin: async () => {try {launcherPinned=await window.weborg.setLauncherPinned(!launcherPinned);render({preserveScroll:true});} catch(error){showActionStatus(error.message);}},
  dispose() {
    disposed=true; cleanups.forEach(fn=>fn());
    invalidateClipboardPaging(); invalidatePluginPaging(); ++allScopeRefreshToken; ++usageSearchToken; ++dnsSearchToken; ++ipSearchToken; ++proxySearchToken;
    [clipboardSearchTimer,dnsSearchTimer,ipSearchTimer,proxySearchTimer,actionStatusTimer,webIconTimer].forEach(clearTimeout);
    [inputRenderFrame,webInputSearchFrame,windowRenderFrame].forEach(cancelAnimationFrame);
    window.FlowHubTools.queryChanged({...toolContext(),enabled:()=>false,query:''});
    for (const id of ['dns','cloudflare','proxy','timestamp','jwt','ip','calculator']) window.FlowHubTools.unregister(id);
    if(window.focusSearch===focusSearch) delete window.focusSearch;
    if(window.prepareForShow===prepareForShow) delete window.prepareForShow;
    if(window.FlowHubSearchDiagnostics===diagnosticBridge) delete window.FlowHubSearchDiagnostics;
  }
};
};
