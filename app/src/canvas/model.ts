export type Config = Record<string, unknown>;
export type Card = { id: string; plugin: string; title?: string; config?: Config; view?: string; row?: unknown; metrics?: unknown; size?: 'small' | 'medium' | 'large'; width?: number; height?: number; x?: number; y?: number; break_before?: boolean };
export type Board = { id: string; title: string; cards: Card[] };
export type Layout = { boards: Board[]; active: string; pinned: boolean };
export type Source = { id: string; title: string; snapshot?: unknown; lastLoadedAt?: unknown; widget?: { card: string; editor: string; interactive?: boolean; minWidth?: number; minHeight?: number } };
export type Point = { x: number; y: number };
export type Position = Point & { id: string; w: number; h: number };
export type FrameContext = { config: Config; title: string; snapshot?: unknown; preview: boolean };
export type FrameHandle = { updateContext(context: FrameContext): void; save(): Promise<Config>; dispose(): void };
export type Invoke = <T = unknown>(command: string, args: Record<string, unknown>) => Promise<T>;
export type CanvasHost = Window & {
  __TAURI__?: { core?: { invoke?: Invoke } };
  FlowHubWidgetFrame: { mount(frame: HTMLIFrameElement, options: { url: string; context: FrameContext; rpc: ((params: Config) => Promise<unknown>) | null; navigate: ((action: string, selection?: Config) => void) | null }): FrameHandle };
  WidgetLayout: { arrange(cards: Card[], moving?: string | null, wanted?: Point | null, target?: string | null): Position[]; swapTarget(cards: Card[], moving: string, point: Point): string | null };
};
export const host = () => window as unknown as CanvasHost;
export const initialLayout = (): Layout => ({ boards: [{ id: 'default', title: '默认布局', cards: [] }], active: 'default', pinned: false });
export const cardConfig = (card?: Card): Config => card?.config || { view: card?.view, row: card?.row, metrics: card?.metrics };
export function minimum(card: Card, sources: Source[]) {
  const widget = sources.find(source => source.id === card.plugin)?.widget;
  return { width: Math.max(widget?.interactive ? 320 : 160, Math.min(1600, Number(widget?.minWidth) || 0)), height: Math.max(widget?.interactive ? 280 : 120, Math.min(1200, Number(widget?.minHeight) || 0)) };
}
export function normalize(layout: Layout, sources: Source[], moving?: string, wanted?: Point, target?: string | null): Layout {
  const next = structuredClone(layout);
  if (!next.boards.some(board => board.id === next.active)) next.active = next.boards[0].id;
  const board = next.boards.find(board => board.id === next.active)!;
  for (const card of board.cards) {
    const min = minimum(card, sources), interactive = sources.find(source => source.id === card.plugin)?.widget?.interactive;
    card.width = Math.max(min.width, Math.min(1600, card.width || (card.size === 'small' ? 184 : card.size ? 384 : 184)));
    card.height = Math.max(min.height, Math.min(1200, card.height || (interactive ? 360 : card.size === 'large' ? 384 : 184)));
  }
  for (const position of host().WidgetLayout.arrange(board.cards, moving, wanted, target)) {
    Object.assign(board.cards.find(card => card.id === position.id)!, { x: position.x, y: position.y, break_before: false });
  }
  return next;
}
export function isLayout(value: unknown): value is Layout {
  if (!value || typeof value !== 'object') return false;
  const layout = value as Layout;
  return Array.isArray(layout.boards) && layout.boards.length > 0 && layout.boards.every(board => typeof board.id === 'string' && typeof board.title === 'string' && Array.isArray(board.cards));
}
export function surfaceUrl(source: Source, kind: 'card' | 'editor', native: boolean, preview: string | null) {
  return native ? `flowhub-plugin://${source.id}/${source.widget![kind]}?v=${Date.now()}` : new URL(source.widget![kind], preview || location.href).href;
}
