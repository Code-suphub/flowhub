(() => {
  const controls = [];
  let opened;
  const close = () => { if (opened) { opened.menu.hidden = true; opened.button.setAttribute('aria-expanded', 'false'); opened = null; } };
  for (const select of document.querySelectorAll('select')) {
    const shell = document.createElement('span'); shell.className = 'select-shell';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'select-trigger';
    const label = select.labels?.[0]?.textContent.replace(select.textContent, '').trim() || '选择';
    button.setAttribute('aria-label', label); button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('span'); menu.className = 'select-menu'; menu.hidden = true;
    menu.id = `${select.id}-options`; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', label); button.setAttribute('aria-controls', menu.id);
    select.after(shell); shell.append(button, menu); select.hidden = true;
    const control = { select, button, menu, shell, signature: '' }; controls.push(control);
    function show() {
      close(); sync(); if (select.disabled) return;
      opened = control; menu.hidden = false; button.setAttribute('aria-expanded', 'true');
      (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild)?.focus();
    }
    button.onclick = e => { e.preventDefault(); opened === control ? close() : show(); };
    button.onkeydown = e => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); show(); } };
    menu.onkeydown = e => {
      const options = [...menu.children]; const i = options.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(); button.focus(); }
      if (e.key === 'Tab') close();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); options[e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
      }
    };
    new MutationObserver(() => sync()).observe(select, { childList: true, subtree: true, attributes: true });
    select.addEventListener('change', sync);
  }
  function sync() {
    for (const c of controls) {
      c.button.disabled = c.select.disabled;
      c.button.textContent = c.select.selectedOptions[0]?.textContent || '请选择';
      const signature = JSON.stringify([...c.select.options].map(o => [o.value, o.textContent, o.disabled])) + c.select.value;
      if (signature === c.signature) continue; c.signature = signature;
      c.menu.replaceChildren(...[...c.select.options].map(o => {
        const option = document.createElement('button'); option.type = 'button'; option.setAttribute('role', 'option'); option.tabIndex = -1;
        option.textContent = o.textContent; option.disabled = o.disabled; option.setAttribute('aria-selected', String(o.value === c.select.value));
        option.onclick = e => { e.preventDefault(); c.select.value = o.value; c.select.dispatchEvent(new Event('change', { bubbles: true })); close(); c.button.focus(); };
        return option;
      }));
    }
  }
  document.addEventListener('pointerdown', e => { if (opened && !opened.shell.contains(e.target)) close(); });
  document.addEventListener('click', e => { if (e.target.closest('[role="tab"]')) close(); });
  window.FlowHubSelects = { sync }; sync();
  for (const help of document.querySelectorAll('.inline-help')) {
    const button = help.querySelector('.help-trigger'), content = help.querySelector('.help-content');
    const show = visible => { content.hidden = !visible; button.setAttribute('aria-expanded', String(visible)); };
    help.onmouseenter = () => show(true);
    help.onmouseleave = () => { if (document.activeElement !== button) show(false); };
    button.onfocus = () => show(true);
    button.onblur = () => show(false);
    button.onclick = () => show(true);
    button.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); show(false); } };
    document.addEventListener('pointerdown', e => { if (!help.contains(e.target)) show(false); });
    document.addEventListener('click', e => { if (e.target.closest('[role="tab"]')) show(false); });
  }
})();
