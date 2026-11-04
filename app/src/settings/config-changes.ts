import { clone, entries, normalize, same, tools, type Bag, type Config, type Memo, type WebNode } from './model';
import type { PageId } from './navigation';

export interface ConfigChange {
  path: string[];
  before: unknown;
  after: unknown;
  kind: 'add' | 'remove' | 'change';
}
const record = (value: unknown): value is Bag => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Arrays stay atomic. A catalog edit must not expand into thousands of JSON
// rows, and comparing changes is deferred until the user opens a review.
export function configChanges(before: unknown, after: unknown): ConfigChange[] {
  const changes: ConfigChange[] = [];
  function visit(left: unknown, right: unknown, path: string[]) {
    if (Object.is(left, right)) return;
    if (record(left) && record(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) visit(left[key], right[key], [...path, key]);
    } else if (!same(left, right)) changes.push({ path, before: left, after: right, kind: left === undefined ? 'add' : right === undefined ? 'remove' : 'change' });
  }
  visit(before, after, []);
  return changes;
}

const labels: Record<string, string> = {
  hotkey: '唤出快捷键', launchAtLogin: '开机自动启动', configPath: '配置文件位置', storagePath: '数据库与剪贴板目录',
  reuseBrowserTabs: '优先复用浏览器标签页', searchResultOrder: '搜索来源顺序', webBeforeClipboard: '网页优先于剪贴板',
  autoUpdateCheck: '自动检查正式版', autoUpdateInstall: '自动下载并重启安装',
  notifications: '通知', menuBar: '菜单栏', enabled: '启用状态', updates: '更新通知',
  showOpenLauncher: '显示启动器入口', showOpenSettings: '显示设置入口', showVersion: '显示版本', showQuit: '显示退出入口',
  organizerEnabled: '菜单栏整理', collapseOnLaunch: '启动时收起菜单栏',
  capturePaused: '暂停剪贴板采集', protectSensitive: '敏感标记保护', retentionDays: '留存天数', maxRecords: '最多记录条数', maxBytes: '逻辑内容容量（字节）',
  proxyAdapter: '代理检测适配器', excludedApps: '旧来源应用排除列表', excludedBundleIds: '旧来源应用标识排除列表',
  catalogStorage: '目录存储方式', ...tools,
};
const pages: Record<string, string> = { core:'通用设置', data:'数据与诊断', search:'搜索', menubar:'菜单栏', updates:'版本与更新', web:'网页目录', memo:'备忘录', clipboard:'剪贴板', app:'应用', tools:'工具' };
const sources: Record<string, string> = { all:'全部', app:'应用', web:'网页目录', clipboard:'剪贴板', memo:'备忘录', twofa:'验证码' };
export function changeGroup(path: string[]): { page: PageId | null; label: string } {
  let page: string | undefined;
  if (path[0] === 'core') page = path[1] === 'configPath' ? 'data' : path[1] === 'menuBar' ? 'menubar' : ['scopeShortcuts','searchResultOrder','webBeforeClipboard','reuseBrowserTabs'].includes(path[1]) ? 'search' : ['autoUpdateCheck','autoUpdateInstall'].includes(path[1]) ? 'updates' : 'core';
  else if (path[0] === 'plugins') page = path[2] === 'settings' && path[3] === 'storagePath' ? 'data' : path[1] === 'tools' && path[3] === 'proxyAdapter' ? 'core' : path[1];
  return { page: page && pages[page] ? page as PageId : null, label: page ? pages[page] || `插件 ${page}` : '其他配置' };
}
export function changeLabel(path: string[]) {
  if (path[0] === 'plugins' && path[3] === 'items') return path[1] === 'web' ? '目录结构与网页内容' : path[1] === 'memo' ? '备忘录内容与分类' : '列表内容';
  if (path[1] === 'scopeShortcuts') return `${sources[path[2]] || path[2]}范围键`;
  const name = labels[path.at(-1) || ''] || path.at(-1) || '完整配置';
  return path[1] === 'notifications' && path[2] === 'enabled' ? '允许通知' : name;
}
const sensitive = (path: string[]) => path.some(part => /password|secret|token|credential|private.?key|api.?key|authorization|cookie/i.test(part));
const defaults: Record<string,string> = {
  'core.hotkey':'默认（Alt+Space）', 'core.launchAtLogin':'关闭（默认）', 'core.reuseBrowserTabs':'关闭（默认）',
  'core.autoUpdateCheck':'开启（默认）', 'core.autoUpdateInstall':'关闭（默认）', 'core.searchResultOrder':'默认顺序',
  'core.configPath':'默认位置', 'plugins.clipboard.settings.storagePath':'默认位置',
  'plugins.clipboard.settings.capturePaused':'关闭（默认）', 'plugins.clipboard.settings.protectSensitive':'开启（默认）',
  'plugins.clipboard.settings.retentionDays':'30（默认）', 'plugins.clipboard.settings.maxRecords':'不限制（默认）', 'plugins.clipboard.settings.maxBytes':'不限制（默认）',
  'plugins.memo.settings.items':'内置命令库（默认）',
};
export function changeValue(value: unknown, path: string[]): string {
  if (value === undefined || value === null || value === '') return defaults[path.join('.')] || (path[0]==='plugins' && path.at(-1)==='enabled'?'开启（默认）':'未设置');
  if (sensitive(path)) return '已设置（内容隐藏）';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (Array.isArray(value)) {
    if (path[1] === 'web' && path[3] === 'items') return `${entries(value as WebNode[]).length} 个节点`;
    if (path[1] === 'memo' && path[3] === 'items') return `${value.length} 条备忘`;
    if (path[1] === 'searchResultOrder') return value.map(id => sources[String(id)] || String(id)).join(' → ') || '默认顺序';
    return `${value.length} 项`;
  }
  if (record(value)) return `${Object.keys(value).length} 个配置字段`;
  const text = String(value);
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}
export function collectionChangeSummary(change: ConfigChange): string {
  const { path, before, after } = change;
  if (path[0] !== 'plugins' || path[3] !== 'items' || !['web','memo'].includes(path[1]) || !Array.isArray(before) || !Array.isArray(after)) return '';
  const flatten = (value: Bag[]) => path[1] === 'web' ? entries(value as WebNode[]).map(entry => entry.node) : value as Memo[];
  const left = flatten(before), right = flatten(after), old = new Map(left.map(item => [item.id,item])), next = new Map(right.map(item => [item.id,item]));
  const added = right.filter(item => !old.has(item.id)), removed = left.filter(item => !next.has(item.id));
  const content = (item: Bag) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'children'));
  const updated = right.filter(item => old.has(item.id) && !same(content(old.get(item.id)!), content(item)));
  const describe = (label: string, items: Bag[]) => items.length ? `${label} ${items.length}（${items.slice(0,3).map(item=>item.title || item.id).join('、')}${items.length>3?'…':''}）` : '';
  return [describe('新增',added), describe('移除',removed), describe('修改',updated)].filter(Boolean).join('；') || '顺序或层级已调整';
}

// Configuration history restores preferences, not the active SQLite catalog.
// Keep the live catalog in comparisons just as getConfig() hydrates it later.
export function historyConfiguration(current: Config, incoming: unknown): Config {
  if (!record(incoming) || !record(incoming.core) || !record(incoming.plugins)) throw new Error('历史配置缺少有效的 core / plugins 对象');
  const next = clone(incoming) as Config;
  next.plugins.web ||= { settings:{} }; next.plugins.web.settings ||= {};
  next.plugins.web.settings.items = clone(current.plugins.web.settings.items);
  return normalize(next);
}
