import { useLayoutEffect, useRef } from 'react';
// Keep presentation state outside the configuration. Field typing does not measure layout.
export function useTreeView(ids: string[], selected: string, filter: string) {
  const ref = useRef<HTMLDivElement>(null), anchor = useRef<{ id: string; offset: number } | null>(null);
  const previous = useRef({ ids: '', selected: '', filter: '' }), signature = ids.join('\u0000');
  function capture() {
    const tree = ref.current; if (!tree) return;
    const rows = [...tree.querySelectorAll<HTMLElement>('[data-node-id]')];
    const row = rows.find(row => row.offsetTop - tree.offsetTop + row.offsetHeight > tree.scrollTop);
    anchor.current = row ? { id: row.dataset.nodeId!, offset: row.offsetTop - tree.offsetTop - tree.scrollTop } : null;
  }
  useLayoutEffect(() => {
    const tree = ref.current; if (!tree) return;
    const before = previous.current;
    if (filter !== before.filter || !ids.length) { tree.scrollTop = 0; anchor.current = null; }
    else if (signature !== before.ids && anchor.current) {
      const row = [...tree.querySelectorAll<HTMLElement>('[data-node-id]')].find(row => row.dataset.nodeId === anchor.current?.id);
      if (row) tree.scrollTop = row.offsetTop - tree.offsetTop - anchor.current.offset;
    }
    if (selected !== before.selected && selected) {
      const row = [...tree.querySelectorAll<HTMLElement>('[data-node-id]')].find(row => row.dataset.nodeId === selected);
      if (row) { const top = row.offsetTop - tree.offsetTop, bottom = top + row.offsetHeight; if (top < tree.scrollTop) tree.scrollTop = top; else if (bottom > tree.scrollTop + tree.clientHeight) tree.scrollTop = Math.max(0, bottom - tree.clientHeight); }
    }
    previous.current = { ids: signature, selected, filter };
  }, [signature, selected, filter]);
  return { ref, capture };
}
