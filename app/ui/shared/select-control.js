(() => {
  const controls = [];
  let opened;
  const close = () => { if (opened) { opened.menu.hidePopover?.(); opened.menu.hidden = true; opened.button.setAttribute('aria-expanded', 'false'); opened = null; } };
  for (const select of document.querySelectorAll('select')) {
    const shell = document.createElement('span'); shell.className = 'select-shell';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'select-trigger';
    const label = select.getAttribute('aria-label') || select.labels?.[0]?.textContent.replace(select.textContent, '').trim() || '选择';
    button.setAttribute('aria-label', label); button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('span'); menu.className = 'select-menu'; menu.hidden = true;
    menu.id = `${select.id || 'select-'+controls.length}-options`; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', label); button.setAttribute('aria-controls', menu.id);
    menu.setAttribute('popover', 'manual');
    select.after(shell); shell.append(button, menu); select.hidden = true;
    const control = { select, button, menu, shell, label, signature: '' }; controls.push(control);
    function show() {
      close(); sync(); if (select.disabled) return;
      opened = control; menu.hidden = false; button.setAttribute('aria-expanded', 'true');
      menu.showPopover?.();
      const rect = button.getBoundingClientRect();
      menu.style.width = Math.min(Math.max(rect.width, 200), innerWidth-16)+'px';
      menu.style.left = Math.max(8, Math.min(rect.left, innerWidth-menu.offsetWidth-8))+'px';
      menu.style.top = Math.max(8, rect.bottom+menu.offsetHeight+8<innerHeight ? rect.bottom+4 : rect.top-menu.offsetHeight-4)+'px';
      (menu.querySelector('input') || menu.querySelector('[aria-selected="true"]:not(:disabled)') || menu.querySelector('[role="option"]:not(:disabled)'))?.focus();
    }
    button.onclick = e => { e.preventDefault(); opened === control ? close() : show(); };
    button.onkeydown = e => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); show(); } };
    menu.onkeydown = e => {
      const options = [...menu.querySelectorAll('[role="option"]:not(:disabled):not([hidden])')]; const i = options.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); button.focus(); }
      if (e.key === 'Tab') close();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        if(e.target.tagName==='INPUT' && ['Home','End'].includes(e.key))return;
        e.preventDefault(); options[e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
      }
    };
    new MutationObserver(() => sync()).observe(select, { childList: true, subtree: true, attributes: true });
    select.addEventListener('change', sync);
    select.addEventListener('invalid', e => {e.preventDefault();button.focus();button.setAttribute('aria-invalid','true');});
    select.addEventListener('change', () => button.removeAttribute('aria-invalid'));
    for(const element of select.labels || []) element.addEventListener('click', e => {if(e.target===element){e.preventDefault();button.focus();}});
    // Programmatic form hydration does not emit change or mutate attributes.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', { configurable:true, get(){return descriptor.get.call(this);}, set(value){descriptor.set.call(this,value);sync();} });
  }
  function sync() {
    for (const c of controls) {
      c.button.disabled = c.select.disabled;
      c.button.textContent = c.select.selectedOptions[0]?.textContent || '请选择';
      c.button.setAttribute('aria-label', c.label+'：'+c.button.textContent);
      const signature = JSON.stringify([...c.select.options].map(o => [o.value, o.textContent, o.disabled])) + c.select.value;
      if (signature === c.signature) continue; c.signature = signature;
      c.menu.replaceChildren(...[...c.select.options].map(o => {
        const option = document.createElement('button'); option.type = 'button'; option.setAttribute('role', 'option'); option.tabIndex = -1;
        option.textContent = o.textContent; option.disabled = o.disabled; option.setAttribute('aria-selected', String(o.value === c.select.value));
        option.onclick = e => { e.preventDefault(); c.select.value = o.value; c.select.dispatchEvent(new Event('change', { bubbles: true })); close(); c.button.focus(); };
        return option;
      }));
      if(c.select.id==='batchMoveTarget'){
        const search=document.createElement('input');search.type='search';search.placeholder='搜索目录';search.setAttribute('aria-label','搜索目录');
        search.oninput=()=>c.menu.querySelectorAll('[role="option"]').forEach(option=>option.hidden=!option.textContent.toLowerCase().includes(search.value.toLowerCase()));
        c.menu.prepend(search);
      }
    }
  }
  document.addEventListener('pointerdown', e => { if (opened && !opened.shell.contains(e.target)) close(); });
  document.addEventListener('click', e => { if (e.target.closest('[role="tab"]')) close(); });
  window.addEventListener('resize', close);
  document.addEventListener('scroll', e => { if(opened && !opened.menu.contains(e.target))close(); }, true);
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
