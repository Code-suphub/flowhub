// Shared non-modal help for navigation: mouse hover and keyboard focus.
(() => {
  const tip = document.createElement('div');
  tip.id = 'navigationHelp'; tip.className = 'help-tooltip';
  tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  document.body.append(tip);
  let active, timer;
  function hide() {
    clearTimeout(timer);
    active?.removeAttribute('aria-describedby'); active = null; tip.hidden = true;
  }
  function show(button) {
    if (!button?.dataset.helpTooltip) return;
    hide(); active = button; tip.textContent = button.dataset.helpTooltip;
    tip.hidden = false; button.setAttribute('aria-describedby', tip.id);
    const rect = button.getBoundingClientRect(), box = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(rect.left, innerWidth - box.width - 8)) + 'px';
    tip.style.top = (rect.bottom + box.height + 8 < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - box.height - 6)) + 'px';
  }
  const deferHide = () => { clearTimeout(timer); timer = setTimeout(hide, 140); };
  document.addEventListener('mouseover', event => { const button = event.target.closest('[data-help-tooltip]'); if (button && button !== active) show(button); });
  document.addEventListener('mouseout', event => { if (active?.contains(event.target) && !active.contains(event.relatedTarget)) deferHide(); });
  document.addEventListener('focusin', event => show(event.target.closest('[data-help-tooltip]')));
  document.addEventListener('focusout', event => { if (active?.contains(event.target)) deferHide(); });
  tip.addEventListener('mouseenter', () => clearTimeout(timer));
  tip.addEventListener('mouseleave', deferHide);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && active) { event.preventDefault(); event.stopImmediatePropagation(); hide(); } }, true);
  document.addEventListener('pointerdown', event => { if (!active?.contains(event.target)) hide(); });
  window.addEventListener('resize', hide);
  document.addEventListener('scroll', hide, true);
})();
