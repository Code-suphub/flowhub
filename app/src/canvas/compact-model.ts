import { cardConfig, type Card, type Layout, type Source } from './model';
import { labels, rowStatus, keyMetric, type Row } from '../surfaces/status-model';

export type Favorite = { boardId: string; cardId: string };
export type Presentation = { enabled: boolean; collapsed: boolean; favorites: Favorite[]; revision: number };
export const initialPresentation = (): Presentation => ({ enabled: false, collapsed: false, favorites: [], revision: 0 });
export const favoriteKey = (favorite: Favorite) => JSON.stringify([favorite.boardId, favorite.cardId]);
export function presentationValue(value: unknown): Presentation | null {
  if (!value || typeof value !== 'object') return null;
  const next = value as Presentation;
  if (typeof next.enabled !== 'boolean' || typeof next.collapsed !== 'boolean' || !Number.isSafeInteger(next.revision) || next.revision < 0 || !Array.isArray(next.favorites)) return null;
  if (next.favorites.length > 384 || next.favorites.some(item => !item || typeof item.boardId !== 'string' || typeof item.cardId !== 'string')) return null;
  return { enabled: next.enabled, collapsed: next.enabled && next.collapsed, favorites: next.favorites, revision: next.revision };
}
export function favoriteCards(layout: Layout, favorites: Favorite[]) {
  return favorites.flatMap(favorite => {
    const board = layout.boards.find(board => board.id === favorite.boardId), card = board?.cards.find(card => card.id === favorite.cardId);
    return card ? [{ ...favorite, card, boardTitle: board!.title }] : [];
  });
}
export function compactStatus(card: Card, source?: Source): { status: string; label: string; metric: string } {
  const snapshot = source?.snapshot as { error?: unknown; rows?: unknown } | undefined;
  if (snapshot?.error) return { status: 'error', label: '读取异常', metric: '—' };
  if (!source) return { status: 'unknown', label: '插件不可用', metric: '—' };
  const rowId = cardConfig(card).row;
  const row = Array.isArray(snapshot?.rows) ? snapshot.rows.find(value => value && typeof value === 'object' && typeof rowId === 'string' && String(value.id) === rowId) as Row | undefined : undefined;
  if (!row) return { status: 'unknown', label: typeof rowId === 'string' ? '未采集' : '无状态', metric: '—' };
  const status = rowStatus(row.status);
  return { status, label: labels[status], metric: keyMetric(row) };
}
export function compactDemo() {
  const sources: Source[] = [{ id: 'demo-service', title: '运行状态', snapshot: { rows: [
    { id: 'api', name: '接口服务', status: 'healthy', values: { cpu: 18.5 } },
    { id: 'queue', name: '任务队列', status: 'error', values: { memory: 82.1 } },
  ] } }];
  const layout: Layout = { active: 'demo', pinned: false, boards: [{ id: 'demo', title: '演示布局', cards: [
    { id: 'api', plugin: 'demo-service', title: '接口服务', config: { row: 'api' }, size: 'small' },
    { id: 'queue', plugin: 'demo-service', title: '任务队列', config: { row: 'queue' }, size: 'small' },
    { id: 'note', plugin: 'demo-service', title: '工作备忘', config: {}, size: 'small' },
  ] }] };
  return { layout, sources, presentation: { enabled: true, collapsed: true, favorites: layout.boards[0].cards.map(card => ({ boardId: 'demo', cardId: card.id })), revision: 1 } };
}
