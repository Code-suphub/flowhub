import { call, host } from './api';
import type { SettingsStore } from './store';

// The native title-bar and preview close action share this entry point. Wait
// through loading/saving, then inspect the latest draft rather than a closure.
export function bindSettingsClose(store: SettingsStore, onUnsaved: () => void) {
  const previous = host().requestSettingsClose;
  let pending = false, closing = false, disposed = false;
  const request = () => {
    if (disposed || closing) return;
    if (store.snapshot().busy) { pending = true; return; }
    pending = false;
    if (store.dirty) { store.persist(); onUnsaved(); return; }
    closing = true;
    void store.run(async () => {
      try { await call('closeSettings'); } finally { closing = false; }
    });
  };
  host().requestSettingsClose = request;
  const unsubscribe = store.subscribe(() => {
    if (pending && !store.snapshot().busy) queueMicrotask(request);
  });
  return () => {
    disposed = true; unsubscribe();
    if (host().requestSettingsClose === request) host().requestSettingsClose = previous;
  };
}
