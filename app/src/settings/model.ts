// Configuration preserves unknown plugin fields; the native adapter owns their schema.
export type Bag = Record<string, any>;
export interface WebNode extends Bag { id: string; title?: string; url?: string; children?: WebNode[] }
export interface Memo extends Bag { id: string; title: string; category?: string; content?: string; tags?: string[] }
export interface Config extends Bag { core: Bag; plugins: Record<string, { enabled?: boolean; settings: Bag }> }
export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function clipboardLimit(value: unknown, key: string) { const number = Number(value); return Number.isFinite(number) ? Math.min(key === 'retentionDays' ? 3650 : Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(number))) : 0; }
export function hasExclusions(config: Config | null) { const value = config?.plugins.clipboard?.settings?.excludedApps; return Array.isArray(value) ? value.some(v => typeof v !== 'string' || v.trim()) : value != null; }
export const tools = { ping: 'Ping 连通性', curl: 'HTTP 请求', port: '端口与进程', calculator: '计算表达式', timestamp: '时间戳转换', jwt: 'JWT 解析', json: 'JSON 格式化', url: 'URL 解析与编解码', dns: 'DNS 解析', dnsIpGeo: 'DNS 自动查询 IP 归属地', cloudflare: 'Cloudflare 检测', localIp: '本机 IP 查询', proxy: '代理信息检测', ip: 'IP 识别与归属地', commandHistory: '命令历史' };
export const shortcuts: Record<string, string> = { all: 'Shift+1', clipboard: 'Shift+2', app: 'Shift+3', web: 'Shift+4', memo: 'Shift+5' };
export const canonical = (text: string) => text.toLowerCase().replace(/\s/g, '').split('+').map(p => ({ option: 'alt', control: 'ctrl', cmd: 'meta', command: 'meta', cmdorctrl: 'commandorcontrol' }[p] || p)).sort().join('+');
export function normalize(value: unknown): Config {
  const c = clone(value) as Config;
  if (!c || typeof c !== 'object' || Array.isArray(c) || !c.core || !c.plugins) throw new Error('配置必须包含 core 和 plugins 对象');
  if (Array.isArray(c.core) || Array.isArray(c.plugins) || typeof c.core !== 'object' || typeof c.plugins !== 'object') throw new Error('core 和 plugins 必须是对象');
  if (c.core.configPath !== undefined && typeof c.core.configPath !== 'string') throw new Error('配置位置必须是字符串');
  for (const key of ['menuBar', 'notifications', 'scopeShortcuts']) if (c.core[key] !== undefined && (!c.core[key] || typeof c.core[key] !== 'object' || Array.isArray(c.core[key]))) throw new Error(`${key} 必须是对象`);
  c.core.menuBar = { enabled: true, showOpenLauncher: true, showOpenSettings: true, showVersion: true, showQuit: true, organizerEnabled: false, collapseOnLaunch: false, ...c.core.menuBar };
  c.core.notifications = { enabled: true, updates: true, ...c.core.notifications };
  c.core.scopeShortcuts = { ...shortcuts, ...c.core.scopeShortcuts };
  const used = new Set<string>();
  for (const [id, raw] of Object.entries(c.core.scopeShortcuts)) {
    if (typeof raw !== 'string') throw new Error('范围快捷键必须是字符串');
    if (!raw) continue;
    const parts = canonical(raw).split('+'), keys = parts.filter(p => !['shift', 'alt', 'ctrl', 'meta', 'commandorcontrol'].includes(p));
    if (keys.length !== 1 || (parts.length === 1 && !/^\d$|^f([1-9]|1\d|2[0-4])$/.test(keys[0]))) throw new Error(`无效快捷键：${raw}`);
    if (used.has(canonical(raw))) c.core.scopeShortcuts[id] = ''; else used.add(canonical(raw));
  }
  for (const id of ['memo', 'tools', 'clipboard', 'app']) { c.plugins[id] ||= { enabled: true, settings: {} }; c.plugins[id].settings ||= {}; }
  const settings = c.plugins.tools.settings;
  if (!['auto', 'mihomo', 'clash-rest', 'system'].includes(settings.proxyAdapter)) settings.proxyAdapter = 'auto';
  for (const key of Object.keys(tools)) if (typeof settings[key] !== 'boolean') settings[key] = true;
  if (!Array.isArray(c.plugins.web?.settings?.items)) throw new Error('网页配置缺少 items 数组');
  const ids = new Set<string>();
  const visit = (nodes: WebNode[]) => nodes.forEach(n => {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id.trim() || ids.has(n.id)) throw new Error(`目录 ID 缺失或重复：${n?.id || ''}`);
    ids.add(n.id);
    if (n.children !== undefined && !Array.isArray(n.children)) throw new Error(`节点 ${n.id} 的 children 必须是数组`);
    visit(n.children || []);
  }); visit(c.plugins.web.settings.items);
  return c;
}
export function entries(nodes: WebNode[], parent: WebNode | null = null, depth = 0): { node: WebNode; parent: WebNode | null; depth: number }[] {
  return nodes.flatMap(node => [{ node, parent, depth }, ...entries(node.children || [], node, depth + 1)]);
}
export function moveNodes(nodes: WebNode[], ids: string[], targetId: string, position: 'before' | 'after' | 'inside' = 'inside'): WebNode[] {
  const next = clone(nodes), all = entries(next), selected = new Set(ids);
  const roots = all.filter(e => selected.has(e.node.id) && !all.some(a => selected.has(a.node.id) && a.node.id !== e.node.id && entries(a.node.children || []).some(c => c.node.id === e.node.id)));
  if (!roots.length || roots.some(e => e.node.id === targetId || entries(e.node.children || []).some(c => c.node.id === targetId))) return nodes;
  const target = all.find(e => e.node.id === targetId);
  if (targetId && !target) return nodes;
  for (const e of roots) { const siblings = e.parent?.children || next; siblings.splice(siblings.indexOf(e.node), 1); }
  const destination = !target ? next : position === 'inside' ? (target.node.children ||= []) : target.parent?.children || next;
  const index = !target || position === 'inside' ? destination.length : destination.indexOf(target.node) + (position === 'after' ? 1 : 0);
  destination.splice(index, 0, ...roots.map(e => e.node)); return next;
}
export function removeNodes(nodes: WebNode[], ids: string[]): WebNode[] { return nodes.filter(n => !ids.includes(n.id)).map(n => ({ ...n, ...(n.children ? { children: removeNodes(n.children, ids) } : {}) })); }
export function merge(base: Bag, incoming: Bag): Bag {
  const result = clone(base);
  for (const [key, value] of Object.entries(incoming)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) ? merge(result[key], value) : clone(value);
  } return result;
}
export function imported(current: Config, pending: Bag, mode: 'merge' | 'replace'): Config {
  let next = clone(current); const incoming = pending.config, scope = pending.scope || 'all';
  if (scope === 'all') next = mode === 'merge' ? merge(next, incoming) as Config : clone(incoming);
  else if (scope === 'core') next.core = mode === 'merge' ? merge(next.core, incoming.core || {}) : clone(incoming.core || {});
  else next.plugins[scope] = mode === 'merge' ? merge(next.plugins[scope] || {}, incoming.plugins?.[scope] || {}) as Config['plugins'][string] : clone(incoming.plugins?.[scope] || { settings: {} });
  next.plugins ||= {}; next.plugins.web ||= { settings: {} }; next.plugins.web.settings ||= {};
  next.plugins.web.settings.items = clone(current.plugins.web.settings.items);
  next.plugins.web.settings.catalogStorage = 'sqlite';
  return normalize(next);
}
export function diff(before: any, after: any, prefix = ''): string[] {
  if (same(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(k => diff(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  return [prefix || '(根)'];
}
export function importWeb(current: WebNode[], incoming: WebNode[], overwrite: boolean) {
  const nodes = clone(current), byId = new Map(entries(nodes).map(e => [e.node.id, e.node])), urls = new Set(entries(nodes).map(e => e.node.url).filter(Boolean)), seen = new Set<string>();
  const changes: string[] = [];
  function visit(node: WebNode, list: WebNode[]) {
    if (!node || !node.id || seen.has(node.id)) { changes.push(`跳过重复/无效 ID：${node?.id}`); return; }
    seen.add(node.id); const existing = byId.get(node.id);
    if (existing) {
      if (!overwrite) { changes.push(`跳过已有 ID：${node.id}`); return; }
      for (const [key, value] of Object.entries(node)) if (key !== 'children' && key !== 'id') existing[key] = clone(value);
      changes.push(`覆盖：${node.id}`); for (const child of node.children || []) visit(child, existing.children ||= []); return;
    }
    if (!node.children?.length && node.url && urls.has(node.url)) { changes.push(`跳过已有网址：${node.url}`); return; }
    const added = { ...clone(node), children: [] as WebNode[] }; list.push(added); byId.set(node.id, added); if (node.url) urls.add(node.url);
    changes.push(`新增：${node.id}`); for (const child of node.children || []) visit(child, added.children);
  } for (const node of incoming) visit(node, nodes);
  return { nodes, changes };
}
export function origin(configPath: Bag, storage: Bag) { return { configPath: String(configPath.activePath || configPath.resolvedPath || configPath.defaultPath || 'default'), storagePath: String(storage.activePath || storage.resolvedPath || storage.defaultPath || 'default') }; }
export const draftKey = (source: ReturnType<typeof origin>) => `flowhub:settings-draft:v2:${JSON.stringify([source.configPath, source.storagePath])}`;
export function signature(value: unknown) { let hash = 2166136261; const text = JSON.stringify(value || null); for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, '0'); }
export function renameCategory(items: Memo[], before: string, after: string, exceptId: string) {
  const segments = (v: string) => v.split(/\s*(?:\/|›|>)\s*/).map(s => s.trim()).filter(Boolean), from = segments(before), to = segments(after);
  if (!from.length) return;
  for (const item of items) { const path = segments(item.category || ''); if (item.id !== exceptId && path.length > from.length && from.every((part, i) => part === path[i])) item.category = [...to, ...path.slice(from.length)].join(' / '); }
}
export interface MemoBranch { name: string; path: string; count: number; children: MemoBranch[]; items: Memo[] }
export function memoTree(items: Memo[]): MemoBranch {
  const root: MemoBranch = { name: '', path: '', count: 0, children: [], items: [] };
  for (const item of items) {
    let branch = root; branch.count++;
    const parts = String(item.category || '其他').split(/\s*(?:\/|›|>)\s*/).map(v => v.trim()).filter(Boolean);
    for (const name of parts) { let child = branch.children.find(c => c.name === name); if (!child) { child = { name, path: branch.path ? `${branch.path} / ${name}` : name, count: 0, children: [], items: [] }; branch.children.push(child); } child.count++; branch = child; }
    branch.items.push(item);
  } return root;
}
