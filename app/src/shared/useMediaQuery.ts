import { useCallback, useMemo, useSyncExternalStore } from 'react';

export function useMediaQuery(query:string) {
  const media=useMemo(()=>typeof window.matchMedia==='function'?window.matchMedia(query):null,[query]);
  const subscribe=useCallback((listener:()=>void)=>{media?.addEventListener('change',listener);return()=>media?.removeEventListener('change',listener);},[media]);
  const snapshot=useCallback(()=>media?.matches ?? false,[media]);
  return useSyncExternalStore(subscribe,snapshot,()=>false);
}
