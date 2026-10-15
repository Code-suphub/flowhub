export type RowStatus = 'healthy' | 'error' | 'stale' | 'unknown';
export type Scope = 'overview' | 'all' | 'favorites';
export interface Row { id: string; name: string; status: string; at?: number; values?: { cpu?: number; memory?: number; disk?: number } }
export interface Preferences { tray: boolean; pinned: boolean; favorites: string[] }
export interface Status { snapshot?: { title?: string; error?: string; monitoring?: boolean; rows?: Row[] }; preferences: Preferences }
export type Orders = Record<Scope, string[]>;
export const labels: Record<RowStatus, string> = { healthy: '正常', error: '异常', stale: '过期', unknown: '未采集' };
export const rowStatus = (status: string): RowStatus => Object.hasOwn(labels, status) ? status as RowStatus : 'unknown';
export const statusVariant = (status: string) => status === 'healthy' ? 'healthy' : status === 'stale' ? 'stale' : status === 'error' ? 'destructive' : 'outline';
export const inScope = (row: Row, scope: Scope, favorites: string[]) => scope !== 'favorites' || favorites.includes(row.id);
export function initialOrder(rows: Row[], favorites: string[], scope: Scope): string[] {
  const priority = (row: Row) => ({ error: 0, stale: 1, unknown: 2, healthy: favorites.includes(row.id) ? 3 : 4 })[rowStatus(row.status)];
  return rows.filter(row => inScope(row, scope, favorites)).sort((a, b) => priority(a) - priority(b)).map(row => row.id);
}
export function refreshOrders(previous: Orders, rows: Row[], favorites: string[]): Orders {
  const result = { ...previous };
  for (const scope of ['overview', 'all', 'favorites'] as const) {
    const next = initialOrder(rows, favorites, scope), valid = new Set(next), kept = previous[scope].filter(id => valid.has(id));
    const existing = new Set(kept);
    result[scope] = [...kept, ...next.filter(id => !existing.has(id))];
  }
  return result;
}
export const metric = (value?: number) => Number.isFinite(value) ? value!.toFixed(1) + '%' : '—';
export function keyMetric(row: Row): string {
  for (const [key, label] of [['cpu', 'CPU'], ['memory', '内存'], ['disk', '磁盘']] as const) {
    if (Number.isFinite(row.values?.[key])) return `${label} ${metric(row.values![key])}`;
  }
  return '指标 —';
}
export function collectedAt(at?: number): Date | null {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function relativeTime(at: number | undefined, now: number): string {
  const date = collectedAt(at);
  if (!date) return '尚无有效采集时间';
  const seconds = Math.floor((now - date.getTime()) / 1000);
  if (seconds < 0 || date.getTime() > now) return '采集时间在未来';
  if (seconds < 60) return `更新于 ${seconds} 秒前`;
  if (seconds < 3600) return `更新于 ${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `更新于 ${Math.floor(seconds / 3600)} 小时前`;
  return `更新于 ${Math.floor(seconds / 86400)} 天前`;
}

// Explicit, local demonstration data; this fixture never provides native access.
export function demoStatus(now: number): Status {
  return {
    preferences: { tray: false, pinned: false, favorites: ['database', 'backup'] },
    snapshot: { title: '服务器状态', monitoring: false, rows: [
      { id: 'gateway', name: '网关 · 上海', status: 'error', at: now - 25000, values: { cpu: 92.4, memory: 68.1, disk: 72.3 } },
      { id: 'worker', name: '任务节点 · 深圳', status: 'error', at: now - 50000, values: { cpu: 81.2, memory: 89.4 } },
      { id: 'archive', name: '归档服务器', status: 'stale', at: now - 25 * 60000, values: { cpu: 13.8, memory: 42.7, disk: 91.2 } },
      { id: 'new-node', name: '新接入节点', status: 'unknown' },
      { id: 'database', name: '核心数据库', status: 'healthy', at: now - 18000, values: { cpu: 24.3, memory: 61.5, disk: 48.2 } },
      { id: 'backup', name: '备份服务器', status: 'healthy', at: now - 32000, values: { memory: 37.5, disk: 64.1 } },
      { id: 'web', name: '网站 · 北京', status: 'healthy', at: now - 21000, values: { cpu: 18.6, memory: 31.2, disk: 23.7 } },
      { id: 'edge', name: '边缘节点 · 杭州', status: 'healthy', at: now - 42000, values: { cpu: 7.1, memory: 22.8, disk: 19.4 } },
    ] },
  };
}
