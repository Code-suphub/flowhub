// FlowHub 桌面启动器 - 渲染层逻辑
const q = document.getElementById("q");
const resultsEl = document.getElementById("results");
const pinBtn = document.getElementById("pinBtn");
const settingsBtn = document.getElementById("settingsBtn");
const clipboardKindRow = document.getElementById("clipboardKindRow");
const scopeRow = document.getElementById("scopeRow");
const keyboardHint = document.getElementById("keyboardHint");
const actionStatus = document.getElementById("actionStatus");
let scopeOrder = ["all"];
const clipboardKinds = ["all", "text", "image", "file"];
const CLIPBOARD_PAGE_SIZE = 30;
const PLUGIN_PAGE_SIZE = 30;
const APP_PAGE_SIZE = 12;
const DEFAULT_SCOPE_SHORTCUTS = { all: "Shift+1", clipboard: "Shift+2", app: "Shift+3", web: "Shift+4", memo: "Shift+5" };

const state = { config: null, plugins: [], webResults: [], webHasMore: true, webLoading: false, query: "", index: 0, scope: "all", clipboardKind: "all", clipboardResults: [], clipboardHasMore: true, clipboardLoading: false, clipboardLoadedQuery: null, appResults: [], appHasMore: true, appLoading: false, appLoadedQuery: null, memoResults: [], memoHasMore: true, memoLoading: false, memoLoadedQuery: null, webLoadedQuery: null, usageSections: { frequent: [], recent: [] }, usageLoadedScope: null, emptyResults: { clipboard: [], app: [], web: [], memo: [] }, expandedClipboard: new Set(), usageColumn: 0, dnsResult: null, localIpResult: null, proxyResult: null };
let clipboardSearchToken = 0;
let appSearchToken = 0;
let appIconSearchToken = 0;
let webSearchToken = 0;
let memoSearchToken = 0;
let usageSearchToken = 0;
let dnsSearchToken = 0;
let localIpSearchToken = 0;
let proxySearchToken = 0;
let clipboardSearchTimer = null;
let scopeTabHeld = false;
let scopeTabUsedWithArrow = false;
let scopeTabTapOffset = 1;
let searchInputComposing = false;
let searchCompositionEndedAt = -Infinity;
let actionStatusTimer = null;
let dnsSearchTimer = null;
let localIpSearchTimer = null;
let proxySearchTimer = null;

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
  const ipv4 = expression.split(".").length === 4
    && expression.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  const ipv6Segments = expression.split(":");
  const ipv6NonEmpty = ipv6Segments.filter(Boolean);
  const ipv6Compressed = expression.includes("::");
  const ipv6 = expression.includes(":")
    && /^[0-9a-f:]+$/i.test(expression)
    && expression.length <= 45
    && (expression.match(/::/g) || []).length <= 1
    && ipv6NonEmpty.length <= 8
    && (ipv6Compressed ? ipv6NonEmpty.length < 8 : ipv6Segments.length === 8)
    && ipv6NonEmpty.every((segment) => segment.length <= 4);
  if (!ipv4 && !ipv6) return null;
  return { type: "ip", expression, result: expression, id: `ip:${expression}` };
}

function isLocalIpQuery(expression = state.query) {
  return /^(?:本机\s*ip|我的\s*ip|my\s*ip|local\s*ip)$/i.test(String(expression).trim());
}

function localIpSuggestions() {
  const expression = state.query.trim();
  if (!isLocalIpQuery(expression)) return [];
  const details = state.localIpResult;
  return ["IPv4", "IPv6"].map((family) => ({
    type: "local-ip",
    family,
    expression,
    result: details?.[family.toLowerCase()] || `${family} 不可用`,
    details,
    id: `local-ip:${family}`
  }));
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

function dnsRecordType(value) {
  return ({ 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT", 28: "AAAA" })[Number(value)] || String(value || "?");
}

function toolSuggestions() {
  if (!pluginEnabled("tools")) return [];
  return [dnsSuggestion(), ...localIpSuggestions(), proxySuggestion(), timestampSuggestion(), jwtSuggestion(), ipSuggestion(), calculationSuggestion()].filter(Boolean);
}

async function copyText(text) {
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
  if (isImage) return `<img src="${esc(raw)}" alt="" />`;
  return esc(raw || "⌁");
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

function matches() {
  const tools = state.scope === "clipboard" ? [] : toolSuggestions();
  const pages = pluginEnabled("web") ? pageMatches().map((page) => ({ ...page, type: "page" })) : [];
  const addWeb = pluginEnabled("web") && state.query.trim() ? webAddSuggestion(pages) : null;
  const clips = pluginEnabled("clipboard") ? clipboardMatches() : [];
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
    return `${usageSection}
      <div class="result calculation-result tool-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon calculation">⌁</span>
        <span class="r-body">
          <span class="r-title calculation-value">${esc(item.result)}</span>
          <span class="r-meta calculation-expression">IP 地址 · 回车复制</span>
        </span>
        <span class="r-kind calculation">识别</span>
      </div>
    `;
  }
  if (item.type === "local-ip") {
    const details = item.details;
    const location = [details?.city, details?.region, details?.country_name].filter(Boolean).join(" · ");
    const address = details?.[item.family.toLowerCase()];
    const infoText = details?.error
      ? "查询失败 · 请检查网络"
      : address
        ? `${location || "公网地址"} · 回车复制详情`
        : details ? `当前网络未提供 ${item.family} 地址` : "正在查询本机 IP…";
    return `${usageSection}
      <div class="result calculation-result tool-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon calculation">⌁</span>
        <span class="r-body">
          <span class="r-title calculation-value">${esc(item.family)} · ${esc(address || item.result)}</span>
          <span class="r-meta calculation-expression">${esc(infoText)}</span>
        </span>
        <span class="r-kind calculation">本机 IP</span>
      </div>
    `;
  }
  if (item.type === "dns") {
    const dnsResolved = state.dnsResult?.hostname === item.hostname;
    const answerText = item.answers?.length
      ? item.answers.slice(0, 3).map((answer) => `${dnsRecordType(answer.type)} ${answer.data || ""}`.trim()).join(" · ")
      : dnsResolved ? "无 DNS 记录" : "正在查询 DNS…";
    return `${usageSection}
      <div class="result calculation-result tool-result ${index === state.index ? "active" : ""}" data-i="${index}">
        <span class="r-icon calculation">⌁</span>
        <span class="r-body">
          <span class="r-title calculation-value">DNS · ${esc(item.hostname)}</span>
          <span class="r-meta calculation-expression">${esc(answerText)} · 回车复制完整记录</span>
        </span>
        <span class="r-kind calculation">工具</span>
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

function render({ preserveScroll = false } = {}) {
  const previousScrollTop = preserveScroll ? resultsEl.scrollTop : 0;
  if (!state.config) { resultsEl.innerHTML = `<div class="empty">配置加载中…</div>`; return; }
  const m = matches();
  const paging = state.scope === "clipboard"
    ? { loading: state.clipboardLoading, hasMore: state.clipboardHasMore }
    : state.scope === "app"
      ? { loading: state.appLoading, hasMore: state.appHasMore }
      : state.scope === "web"
        ? { loading: state.webLoading, hasMore: state.webHasMore }
        : state.scope === "memo"
          ? { loading: state.memoLoading, hasMore: state.memoHasMore }
          : null;
  if (!m.length) { resultsEl.innerHTML = `<div class="empty">${paging?.loading ? "正在加载…" : "没有匹配项"}</div>`; return; }
  resultsEl.innerHTML = renderResults(m);
  if (paging && (paging.loading || !paging.hasMore)) {
    resultsEl.insertAdjacentHTML("beforeend", `<div class="plugin-load-status">${paging.loading ? "正在加载更多…" : "已经到底了"}</div>`);
  }
  if (preserveScroll) {
    resultsEl.scrollTop = previousScrollTop;
    return;
  }
  const a = resultsEl.querySelector(".result.active");
  if (a) a.scrollIntoView({ block: "nearest" });
}

function choose(page) {
  if (["calculation", "timestamp", "jwt", "ip"].includes(page?.type)) {
    void copyText(page.result)
      .then(() => showActionStatus("已复制"))
      .catch(() => showActionStatus("复制失败"));
    return;
  }
  if (page?.type === "local-ip") {
    const lookupLocalIp = window.weborg?.lookupLocalIp;
    if (typeof lookupLocalIp !== "function") {
      showActionStatus("本机 IP 查询不可用");
      return;
    }
    const copyResult = (details) => {
      const text = details?.ipv4 || details?.ipv6 || details?.ip
        ? [`IPv4: ${details.ipv4 || "无"}`, `IPv6: ${details.ipv6 || "无"}`, details.city && `城市: ${details.city}`, details.region && `区域: ${details.region}`, details.country_name && `国家/地区: ${details.country_name}`, details.org && `运营商: ${details.org}`].filter(Boolean).join("\n")
        : "本机 IP 查询失败";
      return copyText(text);
    };
    void lookupLocalIp().then(copyResult).then(() => showActionStatus("本机 IP 已复制")).catch(() => showActionStatus("本机 IP 查询失败"));
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
        const answers = Array.isArray(response?.Answer) ? response.Answer : [];
        const text = answers.length
          ? answers.map((answer) => `${answer.name || page.hostname} ${dnsRecordType(answer.type)} ${answer.data || ""}`.trim()).join("\n")
          : `${page.hostname}\n无 DNS 记录`;
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
    } catch {
      if (token === dnsSearchToken) {
        state.dnsResult = { hostname: suggestion.hostname, answers: [] };
        render();
      }
    }
  }, 220);
}

function queueLocalIpLookup() {
  clearTimeout(localIpSearchTimer);
  const token = ++localIpSearchToken;
  state.localIpResult = null;
  const expression = state.query.trim();
  if (!isLocalIpQuery(expression) || typeof window.weborg?.lookupLocalIp !== "function") return;
  localIpSearchTimer = setTimeout(async () => {
    try {
      const result = await window.weborg.lookupLocalIp();
      if (token !== localIpSearchToken || state.query.trim() !== expression) return;
      state.localIpResult = result?.ipv4 || result?.ipv6 || result?.ip ? result : { error: "查询失败" };
      render();
    } catch {
      if (token === localIpSearchToken) {
        state.localIpResult = { error: "查询失败" };
        render();
      }
    }
  }, 220);
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
  scopeOrder = ["all", ...state.plugins.filter((plugin) => plugin.searchable).map((plugin) => plugin.id)];
  scopeRow.querySelectorAll("[data-scope]").forEach((button) => button.remove());
  scopeRow.insertAdjacentHTML("beforeend", [
    `<button class="scope-button active" data-scope="all">全部</button>`,
    ...state.plugins.filter((plugin) => plugin.searchable).map((plugin) => `<button class="scope-button" data-scope="${esc(plugin.id)}">${esc(plugin.name)}</button>`)
  ].join(""));
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
  invalidateClipboardPaging({ resetPaging: false });
  invalidatePluginPaging({ resetPaging: false });
  state.scope = scope;
  state.index = 0;
  document.querySelectorAll("[data-scope]").forEach((item) => item.classList.toggle("active", item.dataset.scope === scope));
  clipboardKindRow?.classList.toggle("visible", scope === "clipboard");
  renderKeyboardHint();
  render();
  // Scope switches should be instant when the current query is already cached.
  // Only refresh the active scope when its data is stale; this avoids spawning
  // several IPC calls (and native icon scans) for every Tab press.
  if (scope === "all" || scope === "clipboard") {
    if (state.clipboardLoadedQuery !== state.query) void refreshClipboard();
  }
  if (scope === "all" || scope === "app") {
    if (state.appLoadedQuery !== state.query || (scope === "app" && state.appResults.length < APP_PAGE_SIZE && state.appHasMore === false)) void refreshApps();
  }
  if (scope === "all" || scope === "web") {
    if (state.webLoadedQuery !== state.query) void refreshWeb();
  }
  if (scope === "all" || scope === "memo") {
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
    keyboardHint.innerHTML = `←→ 类型 · ↑↓ 记录 · <code>Tab</code> 范围 · <code>⏎</code> 粘贴`;
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

function moveClipboardKind(offset) {
  if (state.scope !== "clipboard") return false;
  const current = Math.max(0, clipboardKinds.indexOf(state.clipboardKind));
  setClipboardKind(clipboardKinds[(current + offset + clipboardKinds.length) % clipboardKinds.length]);
  return true;
}

// 更新配置（主进程每次呼出都会推送）
window.weborg.onConfig(async (cfg) => {
  setConfig(cfg);
  renderPluginScopes(await window.weborg.listPlugins());
  if (!scopeOrder.includes(state.scope)) state.scope = "all";
  renderKeyboardHint();
  render();
  void refreshClipboard();
  void refreshApps();
  void refreshWeb();
  void refreshMemos();
});

document.addEventListener("keydown", (e) => {
  const justCommittedComposition = e.key === "Enter" && performance.now() - searchCompositionEndedAt < 80;
  if (searchInputComposing || e.isComposing || e.keyCode === 229 || e.key === "Process" || justCommittedComposition) return;
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
  if (e.key === "ArrowDown") { moveVertical(m, 1); render(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { moveVertical(m, -1); render(); e.preventDefault(); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const offset = e.key === "ArrowRight" ? 1 : -1;
    if (moveClipboardKind(offset)) {
      e.preventDefault();
    } else if (state.scope === "all" && moveUsageHorizontal(m, offset)) {
      render();
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

async function refreshClipboard({ append = false } = {}) {
  if (!pluginEnabled("clipboard") || !["all", "clipboard"].includes(state.scope)) return;
  if (append && (state.scope !== "clipboard" || state.clipboardLoading || !state.clipboardHasMore)) return;
  const token = ++clipboardSearchToken;
  const offset = append ? state.clipboardResults.length : 0;
  state.clipboardLoading = true;
  if (!append) state.clipboardHasMore = true;
  if (append) render({ preserveScroll: true });
  try {
    const records = await window.weborg?.pluginSearch("clipboard", { query: state.query, kind: state.scope === "clipboard" ? state.clipboardKind : "all", limit: CLIPBOARD_PAGE_SIZE, offset });
    if (token !== clipboardSearchToken) return;
    const nextRecords = records || [];
    state.clipboardResults = append
      ? [...state.clipboardResults, ...nextRecords.filter((record) => !state.clipboardResults.some((current) => current.id === record.id))]
      : nextRecords;
    if (!state.query.trim() && !append) state.emptyResults.clipboard = nextRecords.slice();
    state.clipboardLoadedQuery = state.query;
    state.clipboardHasMore = nextRecords.length === CLIPBOARD_PAGE_SIZE;
    render({ preserveScroll: append });
  } catch {
    if (!append) state.clipboardResults = [];
  } finally {
    if (token === clipboardSearchToken) {
      state.clipboardLoading = false;
      render({ preserveScroll: append });
    }
  }
}

async function refreshApps({ append = false } = {}) {
  if (!pluginEnabled("app") || !["all", "app"].includes(state.scope)) return;
  if (append && (state.scope !== "app" || state.appLoading || !state.appHasMore)) return;
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
  if (append) render({ preserveScroll: true });
  try {
    const applications = await window.weborg?.pluginSearch("app", { query: state.query, limit, offset, includeIcons });
    if (token !== appSearchToken) return;
    const next = applications || [];
    const existing = new Set(state.appResults.map((item) => item.path || item.id));
    state.appResults = append ? [...state.appResults, ...next.filter((item) => !existing.has(item.path || item.id))] : next;
    if (!state.query.trim() && !append) state.emptyResults.app = next.slice();
    state.appLoadedQuery = state.query;
    state.appHasMore = state.scope === "app" && next.length === limit;
    render({ preserveScroll: append });
    void hydrateAppIcons(next, iconToken);
  } catch {
    if (!append) state.appResults = [];
  } finally {
    if (token === appSearchToken) {
      state.appLoading = false;
      render({ preserveScroll: append });
    }
  }
}

async function hydrateAppIcons(applications, token) {
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

async function refreshWeb({ append = false } = {}) {
  if (!pluginEnabled("web") || !["all", "web"].includes(state.scope)) return;
  if (append && (state.scope !== "web" || state.webLoading || !state.webHasMore)) return;
  const token = ++webSearchToken;
  const limit = state.scope === "web" ? PLUGIN_PAGE_SIZE : 12;
  const offset = append ? state.webResults.length : 0;
  state.webLoading = true;
  if (!append) state.webHasMore = true;
  if (append) render({ preserveScroll: true });
  try {
    const pages = await window.weborg?.pluginSearch("web", { query: state.query, limit, offset });
    if (token !== webSearchToken) return;
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
      render({ preserveScroll: append });
    }
  }
}

async function refreshMemos({ append = false } = {}) {
  if (!pluginEnabled("memo") || !["all", "memo"].includes(state.scope)) return;
  if (append && (state.scope !== "memo" || state.memoLoading || !state.memoHasMore)) return;
  const token = ++memoSearchToken;
  const limit = state.scope === "memo" ? PLUGIN_PAGE_SIZE : 12;
  const offset = append ? state.memoResults.length : 0;
  state.memoLoading = true;
  if (!append) state.memoHasMore = true;
  if (append) render({ preserveScroll: true });
  try {
    const memos = await window.weborg?.pluginSearch("memo", { query: state.query, limit, offset });
    if (token !== memoSearchToken) return;
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
      render({ preserveScroll: append });
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

function queueClipboardRefresh(delay = 180, refreshEmpty = false) {
  clearTimeout(clipboardSearchTimer);
  clipboardSearchTimer = setTimeout(() => {
    if (!state.query.trim() && !refreshEmpty) {
      void refreshUsage();
      return;
    }
    if (!state.query.trim() && refreshEmpty) {
      void refreshClipboard();
      void refreshUsage();
      return;
    }
    void refreshClipboard();
    void refreshApps();
    void refreshWeb();
    void refreshMemos();
    void refreshUsage();
  }, delay);
}

q.addEventListener("compositionstart", () => {
  searchInputComposing = true;
});
q.addEventListener("compositionend", () => {
  searchInputComposing = false;
  searchCompositionEndedAt = performance.now();
});
q.addEventListener("input", () => {
  invalidateClipboardPaging();
  invalidatePluginPaging();
  state.query = q.value;
  queueDnsLookup();
  queueLocalIpLookup();
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
  render();
  queueClipboardRefresh();
});
resultsEl.addEventListener("scroll", () => {
  if (resultsEl.scrollHeight - resultsEl.scrollTop - resultsEl.clientHeight >= 160) return;
  if (state.scope === "clipboard") void refreshClipboard({ append: true });
  else if (state.scope === "app") void refreshApps({ append: true });
  else if (state.scope === "web") void refreshWeb({ append: true });
  else if (state.scope === "memo") void refreshMemos({ append: true });
});
settingsBtn?.addEventListener("click", () => window.weborg?.openSettings());
scopeRow?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-scope]");
  if (button) setScope(button.dataset.scope);
});
document.querySelectorAll("[data-clipboard-kind]").forEach((button) => button.addEventListener("click", () => setClipboardKind(button.dataset.clipboardKind)));
window.weborg.onClipboardUpdated(() => { invalidateClipboardPaging(); queueClipboardRefresh(80, true); });
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
resultsEl.addEventListener("mousemove", (e) => { const row = e.target.closest(".result"); if (row) { const i = +row.dataset.i; if (i !== state.index) { const position = usagePosition(matches(), i); if (position) state.usageColumn = position.column; state.index = i; render(); } } });

function focusSearch() { q?.focus(); q?.select(); }
function prepareForShow() {
  if (q) q.value = "";
  state.query = "";
  state.index = 0;
  clearTimeout(dnsSearchTimer);
  clearTimeout(localIpSearchTimer);
  clearTimeout(proxySearchTimer);
  dnsSearchToken += 1;
  localIpSearchToken += 1;
  proxySearchToken += 1;
  state.dnsResult = null;
  state.localIpResult = null;
  state.proxyResult = null;
  clearTimeout(dnsSearchTimer);
  dnsSearchToken += 1;
  state.dnsResult = null;
  invalidateClipboardPaging();
  invalidatePluginPaging();
  render();
  focusSearch();
}
window.focusSearch = focusSearch;
window.prepareForShow = prepareForShow;

// 初始加载
async function initialize() {
  const plugins = await window.weborg.listPlugins();
  renderPluginScopes(plugins);
  const enabled = (id) => plugins.some((plugin) => plugin.id === id && plugin.enabled && plugin.available);
  const [cfg, records, applications, pages, memos, usageSections] = await Promise.all([
    window.weborg.getConfig(),
    enabled("clipboard") ? window.weborg.pluginSearch("clipboard", { query: "", kind: "all", limit: CLIPBOARD_PAGE_SIZE, offset: 0 }) : [],
    enabled("app") ? window.weborg.pluginSearch("app", { query: "", limit: 3, includeIcons: false }) : [],
    enabled("web") ? window.weborg.pluginSearch("web", { query: "", limit: 12 }) : [],
    enabled("memo") ? window.weborg.pluginSearch("memo", { query: "", limit: 12 }) : [],
    window.weborg.searchUsage("all")
  ]);
  setConfig(cfg);
  state.clipboardResults = records || [];
  state.clipboardLoadedQuery = "";
  state.emptyResults.clipboard = state.clipboardResults.slice();
  state.clipboardHasMore = state.clipboardResults.length === CLIPBOARD_PAGE_SIZE;
  state.appResults = applications || [];
  state.appLoadedQuery = "";
  state.emptyResults.app = state.appResults.slice();
  state.appHasMore = false;
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
  render();
  focusSearch();
}

void initialize();
