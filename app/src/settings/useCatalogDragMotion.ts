import { useEffect, useLayoutEffect, useRef } from 'react';

// Presentation only: the catalog owns hit testing and configuration changes.
// Pointer frames move one overlay without rerendering the entire tree.
type DragMotionOptions = {
  rowSelector?: string;
  identityAttribute?: string;
  previewClassName?: string;
  draggingClassName?: string;
};
export function useCatalogDragMotion(options: DragMotionOptions = {}) {
  const rowSelector = options.rowSelector || '[data-node-id]';
  const identityAttribute = options.identityAttribute || 'data-node-id';
  const previewClassName = options.previewClassName || 'fh-root settings-catalog settings-catalog-drag-preview';
  const draggingClassName = options.draggingClassName || 'settings-catalog-dragging';
  const active = useRef<{
    ghost: HTMLElement; tree: HTMLElement; rows: HTMLElement[];
    offsetX: number; offsetY: number; x: number; y: number; frame: number;
  } | null>(null);
  const pending = useRef<{ tree: HTMLElement; positions: Map<string, DOMRect> } | null>(null);
  const animations = useRef<Animation[]>([]);
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  function end() {
    const drag = active.current;
    if (drag) {
      cancelAnimationFrame(drag.frame);
      drag.ghost.remove();
      drag.rows.forEach(row => row.removeAttribute('data-drag-source'));
      drag.tree.removeAttribute('data-drag-active');
      document.body.classList.remove(draggingClassName);
      active.current = null;
    }
  }

  function lift(row: HTMLElement, tree: HTMLElement, ids: string[], x: number, y: number) {
    end();
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
    const rect = row.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = previewClassName;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.style.width = `${rect.width}px`;
    ghost.style.transform = `translate3d(${rect.left}px,${rect.top}px,0)`;
    const copy = row.cloneNode(true) as HTMLElement;
    [copy, ...copy.querySelectorAll<HTMLElement>('*')].forEach(element => {
      ['id', identityAttribute, 'data-drop-position', 'data-drop-target', 'data-drag-source', 'role', 'tabindex'].forEach(name => element.removeAttribute(name));
    });
    copy.style.paddingInlineStart = '10px';
    ghost.append(copy);
    if (ids.length > 1) {
      const count = document.createElement('span');
      count.className = 'settings-catalog-drag-count';
      count.textContent = `${ids.length} 项`;
      ghost.append(count);
    }
    document.body.append(ghost);
    const rows = [...tree.querySelectorAll<HTMLElement>(rowSelector)].filter(item => ids.includes(item.getAttribute(identityAttribute) || ''));
    rows.forEach(item => item.setAttribute('data-drag-source', 'true'));
    tree.setAttribute('data-drag-active', 'true');
    document.body.classList.add(draggingClassName);
    active.current = { ghost, tree, rows, offsetX: x - rect.left, offsetY: y - rect.top, x, y, frame: 0 };
  }

  function move(x: number, y: number) {
    const drag = active.current;
    if (!drag) return;
    drag.x = x; drag.y = y;
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0;
      drag.ghost.style.transform = `translate3d(${drag.x - drag.offsetX}px,${drag.y - drag.offsetY - 6}px,0)`;
    });
  }

  function captureDrop() {
    const tree = active.current?.tree;
    if (!tree || reduced()) return;
    pending.current = { tree, positions: new Map([...tree.querySelectorAll<HTMLElement>(rowSelector)].map(row => [row.getAttribute(identityAttribute) || '', row.getBoundingClientRect()])) };
  }

  // Read all final positions before writing animation styles (FLIP).
  useLayoutEffect(() => {
    const before = pending.current;
    if (!before) return;
    pending.current = null;
    const moves = [...before.tree.querySelectorAll<HTMLElement>(rowSelector)].map(row => {
      const old = before.positions.get(row.getAttribute(identityAttribute) || ''), rect = row.getBoundingClientRect();
      return { row, dx: old ? old.left - rect.left : 0, dy: old ? old.top - rect.top : 0 };
    });
    animations.current = moves.filter(({ dx, dy }) => dx || dy).map(({ row, dx, dy }) => row.animate([
      { transform: `translate(${dx}px,${dy}px)` }, { transform: 'translate(0,0)' },
    ], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' }));
  });

  useEffect(() => () => {
    end(); pending.current = null;
    animations.current.forEach(animation => animation.cancel());
  }, []);
  return { lift, move, captureDrop, end };
}
