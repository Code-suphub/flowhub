// The legacy native/browser adapters return extensible plugin records. Keep this
// boundary local; no global Window declarations are shared with other entries.
export type Data = Record<string, any>;
export interface SearchItem extends Data {
  type: string; id?: string | number; title?: string; toolId?: string;
  usageSection?: string; content?: string; path?: string; url?: string;
}
export interface SearchSnapshot {
  state: Data; items: SearchItem[];
  plan: null | { from: number; to: number; before: number; after: number; groups: {id:string;start:number}[] };
  paging: {loading: boolean; hasMore: boolean}; statusText: string;
  updateState: Data | null; launcherPinned: boolean; showUncachedWebIcons: boolean;
  loadedWebIcons: Set<string>; failedWebIcons: Set<string>;
  timing?: {run: unknown; startedAt:number};
}
export interface SearchController {
  ready: Promise<void>; handlers: Record<string, (event?: any) => void>;
  state: Data; resultWindow: {heights: Map<string,number>};
  render(options?: {preserveScroll?: boolean}): void;
  returnToSearch(): void; setScope(scope:string): void; setClipboardKind(kind:string): void;
  preserveSearchFocus(event: any): void; activateScopeControl(button: HTMLElement): void;
  togglePin(): Promise<void>; dispose(): void;
  confirmClipboardDelete(): Promise<void>; cancelClipboardDelete():void;
}
export type SearchHost = Window & {
  createFlowHubSearchController(root: HTMLElement, publish: (snapshot: SearchSnapshot) => void): SearchController;
  weborg: Data; FlowHubCommandStore?: Data;
  flowhubSearchTiming?: {commit(run:unknown, startedAt:number):void};
  FlowHubMemoCatalog?: {categorySegments(category:string): string[]};
  FlowHubPortCommands: {formatStartedAt(value:string):string;formatElapsed(value:string):string};
};
export const host = window as unknown as SearchHost;
