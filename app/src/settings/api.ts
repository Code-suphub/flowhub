import type { Bag } from './model';
export interface InstalledPlugin { enabled: boolean; manifest: { id: string; name: string; ui: string } }
export type SettingsHost = Window & {
  weborg: Record<string, (...args: any[]) => any>;
  FlowHubMemoCatalog?: { cloneDefaults: () => import('./model').Memo[] };
  FlowHubCommandStore?: { counts: () => Bag; clearAll: () => void };
  flowhubPerformance?: { enable: (enabled: boolean) => void; report: () => unknown; reset: () => void };
  FlowHubPluginIntegration?: { refresh: () => Promise<void>; subscribe: (fn: () => void) => () => void; getSnapshot: () => InstalledPlugin[]; attach: (frame: HTMLIFrameElement) => () => void; show: (module: string) => void };
  runMenuUpdate?: () => Promise<void>;
  prepareAddWebUrl?: (value: string) => void;
  switchModule?: (value: string) => void;
  FlowHubTheme?: { get: () => string; set: (value: string) => void };
};
export const host = () => window as unknown as SettingsHost;
export const readonly = () => document.documentElement.dataset.weborgRuntime === 'browser' || !(window as Window & { __TAURI__?: unknown }).__TAURI__;
export async function call<T = Bag>(method: string, ...args: any[]): Promise<T> {
  const fn = host().weborg?.[method]; if (!fn) throw new Error(`当前环境不支持 ${method}`);
  const result = await fn(...args); if (result?.ok === false && !result?.canceled) throw new Error(result.reason || '操作失败'); return result as T;
}
export async function write<T = Bag>(method: string, ...args: any[]): Promise<T> { if (readonly()) throw new Error('浏览器预览只读，请在 FlowHub App 中操作'); return call<T>(method, ...args); }
