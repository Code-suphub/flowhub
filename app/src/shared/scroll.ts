// Keep explicit navigation inside its owning panes. scrollIntoView also moves
// overflow-hidden ancestors, including the outer document in native WebKit.
export function scrollElementWithin(container: HTMLElement, element: HTMLElement, align: 'nearest' | 'center' = 'nearest') {
  if (!container.contains(element)) return;
  for (let pane = element.parentElement; pane && container.contains(pane); pane = pane.parentElement) {
    if (pane.scrollHeight > pane.clientHeight && /^(auto|scroll|overlay)$/.test(getComputedStyle(pane).overflowY)) {
      const bounds = element.getBoundingClientRect(), viewport = pane.getBoundingClientRect();
      const top = viewport.top + pane.clientTop, bottom = top + pane.clientHeight;
      let delta = 0;
      if (align === 'center') delta = bounds.top - top - (pane.clientHeight - bounds.height) / 2;
      else if (bounds.top < top && bounds.bottom <= bottom) delta = bounds.top - top;
      else if (bounds.bottom > bottom && bounds.top >= top) delta = bounds.bottom - bottom;
      if (delta) pane.scrollTop = Math.max(0, Math.min(pane.scrollHeight - pane.clientHeight, pane.scrollTop + delta));
    }
    if (pane === container) break;
  }
}
