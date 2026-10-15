/** Return navigation stays within this application's canvas page. */
export function canvasReturnUrl(raw: string | null, current: string): string {
  const fallback = new URL('plugin-canvas.html', current);
  if (raw) {
    try {
      const candidate = new URL(raw, current);
      if (candidate.protocol === fallback.protocol && candidate.origin === fallback.origin && candidate.pathname === fallback.pathname) {
        candidate.hash = ''; return candidate.href;
      }
    } catch { /* Use the local canvas when a return target is malformed. */ }
  }
  return fallback.href;
}

export function browserDetailUrl(current: string, preview: string | null, boardId: string, cardId: string, config: Record<string, unknown>, title: string, plugin?: string): string {
  const back = new URL(canvasReturnUrl(current, current));
  back.searchParams.set('board', boardId); back.searchParams.set('card', cardId);
  if (plugin) back.searchParams.set('returnPlugin', plugin);
  const detail = new URL('plugin-detail.html', current);
  detail.search = new URLSearchParams({ ...(preview ? { preview } : {}), config: JSON.stringify(config), title, returnTo: back.href }).toString();
  return detail.href;
}

export function previewDirectory(raw: string | null): URL {
  if (!raw) throw Error('请使用完整的 HTTP 或 HTTPS 插件预览地址。');
  let base: URL;
  try { base = new URL(raw); } catch { throw Error('预览地址无效，请使用完整的 HTTP 或 HTTPS 插件预览地址。'); }
  if (!['http:', 'https:'].includes(base.protocol)) throw Error('预览地址无效，请使用 HTTP 或 HTTPS 地址。');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  base.search = ''; base.hash = ''; return base;
}

export function previewDetailUrl(path: unknown, base: URL): string {
  if (typeof path !== 'string' || !path.trim()) throw Error('此插件未提供详情页面。');
  const url = new URL(path, base);
  if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol) || !url.pathname.startsWith(base.pathname)) throw Error('插件详情地址必须位于当前预览服务目录内。');
  return url.href;
}
