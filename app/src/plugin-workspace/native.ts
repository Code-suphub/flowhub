export interface WorkspaceSnapshot { module: string; open: boolean; revision: number }
type NativeHost = Window & { __TAURI__?: { core: { invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T> }; window?: { getCurrentWindow: () => { startDragging: () => Promise<void> } } } };
export function workspaceCall(action: string, module?: string, width?: number) {
  const invoke = (window as NativeHost).__TAURI__?.core.invoke;
  if (!invoke) return Promise.reject(new Error('独立悬浮窗口请在 FlowHub App 中使用'));
  return invoke<WorkspaceSnapshot>('plugin_workspace', { action, module: module ?? null, width: width ?? null });
}
export function dragWorkspace() { return (window as NativeHost).__TAURI__?.window?.getCurrentWindow().startDragging(); }
