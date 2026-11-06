import type { SearchItem } from './types';

const preferenceKey = 'flowhub.search.previewExpanded';

export function isLongPreviewContent(item?: SearchItem): boolean {
  if (!item || !(item.type === 'clipboard' && item.kind === 'text' || item.type === 'memo')) return false;
  const content = String(item.content || '');
  // A long record needs no scan. Line counting only handles the short remainder.
  return content.length > 80 || content.split(/\r\n|\r|\n/).length >= 3;
}

export function previewIdentity(item?: SearchItem): string | null {
  return item ? `${item.type}:${item.id ?? item.path ?? item.url ?? ''}` : null;
}

export function readPreviewExpanded(): boolean {
  try { return localStorage.getItem(preferenceKey) === 'true'; }
  catch { return false; }
}

export function rememberPreviewExpanded(expanded: boolean) {
  if (document.documentElement.dataset.weborgReadonly === 'true') return;
  try { localStorage.setItem(preferenceKey, String(expanded)); }
  catch { /* Presentation remains usable when storage is unavailable. */ }
}
