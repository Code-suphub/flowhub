/* Presentation state is separate from the configuration draft. */
(() => {
  const workspace = document.querySelector('.workspace');
  const divider = document.getElementById('webPaneDivider');
  const narrow = matchMedia('(max-width: 760px)');
  const setWidth = value => {
    const width = Math.max(220, Math.min(380, Math.round(Number.isFinite(value) ? value : 260)));
    workspace.style.setProperty('--web-tree-width', `${width}px`);
    divider.setAttribute('aria-valuenow', String(width));
    return width;
  };
  const persistWidth = () => {
    try { localStorage.setItem('flowhub:web-tree-width', divider.getAttribute('aria-valuenow')); } catch {}
  };
  try { const saved = Number(localStorage.getItem('flowhub:web-tree-width')); setWidth(saved || 260); } catch { setWidth(260); }
  let drag = null;
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    divider.focus({ preventScroll: true });
    drag = { x: event.clientX, width: Number(divider.getAttribute('aria-valuenow')) };
    divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  divider.addEventListener('pointermove', event => {
    if (drag) setWidth(drag.width + event.clientX - drag.x);
  });
  const endDrag = () => { if (drag) persistWidth(); drag = null; };
  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('pointercancel', endDrag);
  divider.addEventListener('lostpointercapture', endDrag);
  divider.addEventListener('dblclick', () => { setWidth(260); persistWidth(); });
  divider.addEventListener('keydown', event => {
    const current = Number(divider.getAttribute('aria-valuenow'));
    const next = { ArrowLeft: current - 10, ArrowRight: current + 10, Home: 220, End: 380 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); setWidth(next); persistWidth();
  });
  let opener = null;
  const reset = () => { workspace.removeAttribute('data-collection-detail'); };
  const open = module => {
    if (!narrow.matches) return;
    opener = document.querySelector(module === 'web' ? '.tree-row.active' : '.memo-list-item.active');
    workspace.dataset.collectionDetail = module;
    document.querySelector('.editor')?.scrollTo({ top: 0 });
    workspace.scrollTo({ top: 0 });
    document.querySelector(`[data-collection-back="${module}"]`)?.focus({ preventScroll: true });
  };
  window.flowhubCollectionLayout = { open, reset };
  narrow.addEventListener('change', reset);
  document.addEventListener('click', event => {
    const back = event.target.closest('[data-collection-back]');
    if (back) {
      reset();
      const target = opener?.isConnected ? opener : document.querySelector(back.dataset.collectionBack === 'web' ? '.tree-row.active' : '.memo-list-item.active');
      target?.focus();
      return;
    }
    // Run after the settings handler has rendered the selected/new item.
    const action = event.target.closest('[data-action]')?.dataset.action;
    const web = !event.target.closest('[data-toggle-node], .tree-drag-handle') && event.target.closest('[data-node-id]');
    const memo = event.target.closest('[data-memo-id]');
    const module = web || ['add-root', 'add-child', 'add-sibling'].includes(action) ? 'web' : memo || action === 'add-memo' ? 'memo' : null;
    if (module) queueMicrotask(() => open(module));
  });
})();
