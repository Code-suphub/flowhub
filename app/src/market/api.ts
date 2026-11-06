export interface Manifest { id: string; name: string; version: string; description?: string; searchable?: boolean; statusSurface?: boolean; widget?: Record<string, unknown>; permissions?: string[] }
export interface Installed { manifest: Manifest; directory: string; enabled: boolean; lastLoadedAt?: number }
export interface Source { id: string; name: string; kind: 'local' | 'https'; location: string; key: string }
export interface Candidate { manifest: Manifest; source: string; token: string; target?:string; releaseNotes?:string; publishedAt?:string }
export interface InstallProgress {phase:'preparing'|'downloading'|'verifying'|'extracting'|'applying'|'complete';received?:number;total?:number|null}
type Channel = {onmessage:(progress:InstallProgress)=>void};
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
type Host = Window & { __TAURI__?: { core?: { invoke?: Invoke; Channel?:new()=>Channel } }; FlowHubPluginIntegration?: { refresh: () => Promise<void> } };
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
export async function installCandidate(token:string,onProgress:(progress:InstallProgress)=>void) {
  const Constructor=host()?.__TAURI__?.core?.Channel;
  const channel=Constructor?new Constructor():undefined;
  if(channel)channel.onmessage=onProgress;
  try {return await api('installCandidate',{token,...(channel?{onProgress:channel}:{})});}
  finally {if(channel)channel.onmessage=()=>{};}
}
export async function openPlugin(id:string) {
  const invoke=getInvoke();if(!invoke)throw Error('请在 FlowHub 中打开插件。');
  await refreshNavigation();
  await invoke('plugin_workspace',{action:'select',module:`plugin:${id}`,width:null});
}
