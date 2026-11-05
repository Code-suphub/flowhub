const preferenceKey = 'flowhub.search.previewExpanded';

export function readPreviewExpanded(): boolean {
  try { return localStorage.getItem(preferenceKey) === 'true'; }
  catch { return false; }
}

export function rememberPreviewExpanded(expanded: boolean) {
  if (document.documentElement.dataset.weborgReadonly === 'true') return;
  try { localStorage.setItem(preferenceKey, String(expanded)); }
  catch { /* Presentation remains usable when storage is unavailable. */ }
}
