// Declarative, shared help dialog. Only explicitly marked explanatory content moves here.
(() => {
  const dialog = document.createElement('dialog');
  dialog.className = 'help-dialog';
  dialog.setAttribute('aria-labelledby', 'helpDialogTitle');
  dialog.innerHTML = '<header><h2 id="helpDialogTitle"></h2><button type="button" aria-label="关闭说明" autofocus>×</button></header><div class="help-dialog-copy"></div>';
  document.body.append(dialog);
  dialog.querySelector('button').onclick = () => dialog.close();
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close(); }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if(event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  const groups = new Map();
  document.querySelectorAll('template[data-help]').forEach(template => {
    const scope = template.closest('.field, .settings-block, .selected-card');
    const heading = scope?.querySelector('label, .settings-block-title, .update-title strong, .selected-banner strong');
    const target = heading || template.parentElement;
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(template);
  });
  for (const [heading, templates] of groups) {
    const title = heading.textContent.trim() || '使用说明';
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'help-dialog-trigger';
    trigger.setAttribute('aria-label', title + '说明');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/></svg>';
    trigger.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      dialog.querySelector('h2').textContent = title;
      dialog.querySelector('.help-dialog-copy').replaceChildren(...templates.map(template => { const p = document.createElement('p'); p.append(template.content.cloneNode(true)); return p; }));
      dialog.showModal();
    };
    // Do not nest an interactive button inside a form label.
    if (heading.tagName === 'LABEL') heading.after(trigger); else heading.append(trigger);
  }
})();
