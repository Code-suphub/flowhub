export type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type Unlisten = () => void;
export interface NativeHost {
  core?: {invoke?: Invoke};
  event?: {listen: (event: string, handler: (event: {payload: unknown}) => void) => Promise<Unlisten>};
  window?: {getCurrentWindow: () => {startDragging: () => Promise<void>}};
}
export function nativeHost(): NativeHost | undefined {return (window as Window & {__TAURI__?: NativeHost}).__TAURI__;}
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const call = nativeHost()?.core?.invoke;
  return call ? call<T>(command, args) : Promise.reject(new Error('浏览器预览只读，请在 FlowHub 中操作。'));
}
