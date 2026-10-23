import { useCallback, useEffect, useRef, useState } from 'react';
import type { Invoke } from './model';

export type CanvasLifecycle = { active: boolean; revision: number };
/** Native window presentation and browser page visibility are separate signals. */
export function useCanvasActivity(invoke: Invoke | undefined, onSuspend: () => void, onProbeError: (message: string) => void) {
  const native = Boolean(invoke);
  const state = useRef({ nativeActive: true, revision: -1, pageActive: true, browserActive: !document.hidden, generation: 0, active: native || !document.hidden });
  const [active, setActive] = useState(state.current.active);
  const suspended = useRef(onSuspend); suspended.current = onSuspend;
  const probeError = useRef(onProbeError); probeError.current = onProbeError;
  const probing = useRef<Promise<void> | null>(null), alive = useRef(true);
  const listeners = useRef(new Set<(active: boolean) => void>());
  const update = useCallback(() => {
    const current = state.current, next = current.pageActive && (native ? current.nativeActive : current.browserActive);
    if (next === current.active) return;
    current.active = next; current.generation++; setActive(next);
    if (!next) suspended.current();
    for (const listener of listeners.current) listener(next);
  }, [native]);
  const accept = useCallback((value: unknown) => {
    if (!native || !value || typeof value !== 'object') return;
    const next = value as CanvasLifecycle;
    if (typeof next.active !== 'boolean' || !Number.isSafeInteger(next.revision) || next.revision < 0 || next.revision <= state.current.revision) return;
    state.current.revision = next.revision; state.current.nativeActive = next.active; update();
  }, [native, update]);
  const probe = useCallback(() => {
    if (!invoke) return Promise.resolve();
    if (probing.current) return probing.current;
    const request = Promise.resolve().then(() => invoke<{ lifecycle: CanvasLifecycle }>('plugin_canvas_api', { action: 'lifecycle', payload: {} })).then(result => { if (alive.current) accept(result.lifecycle); }).catch(error => { if (alive.current) probeError.current(`恢复可见性失败：${String(error)}`); });
    probing.current = request; void request.finally(() => { if (probing.current === request) probing.current = null; }); return request;
  }, [invoke, accept]);
  useEffect(() => {
    alive.current = true;
    const receive = (event: Event) => accept((event as CustomEvent<unknown>).detail);
    const visibility = () => { if (!native) { state.current.browserActive = !document.hidden; update(); } };
    const hide = () => { state.current.pageActive = false; update(); };
    const show = () => { state.current.pageActive = true; visibility(); update(); if (native && !state.current.nativeActive) void probe(); };
    window.addEventListener('flowhub:canvas-lifecycle', receive);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    document.addEventListener('visibilitychange', visibility);
    return () => { alive.current = false; window.removeEventListener('flowhub:canvas-lifecycle', receive); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); document.removeEventListener('visibilitychange', visibility); };
  }, [accept, native, update, probe]);
  const subscribe = useCallback((listener: (active: boolean) => void) => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; }, []);
  const isActive = useCallback(() => state.current.active, []);
  const generation = useCallback(() => state.current.generation, []);
  return { active, accept, subscribe, isActive, generation, probe };
}
