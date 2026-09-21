export interface Manifest { id: string; name: string; version: string; description?: string }
export interface Installed { manifest: Manifest; directory: string; enabled: boolean; lastLoadedAt?: number }
export interface Source { id: string; name: string; kind: 'local' | 'https'; location: string; key: string }
export interface Candidate { manifest: Manifest; source: string; token: string }
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
type Host = Window & { __TAURI__?: { core?: { invoke?: Invoke } }; FlowHubPluginIntegration?: { refresh: () => Promise<void> } };
function host(): Host | undefined {
  try { return window.parent as Host; } catch { return undefined; }
}
export function getInvoke(): Invoke | undefined {
  try { return host()?.__TAURI__?.core?.invoke; } catch { return undefined; }
}
export const available = Boolean(getInvoke());
export function api<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const invoke = getInvoke();
  if (!invoke) return Promise.reject(new Error('浏览器预览只读，请在 FlowHub 中操作。'));
  return invoke<T>('plugin_api', { action, payload });
}
export async function refreshNavigation() { await host()?.FlowHubPluginIntegration?.refresh(); }
