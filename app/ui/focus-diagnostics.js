// Explicit local diagnostic session; no values, text, URLs or clipboard data.
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  let enabled = false, sequence = 0;
  const label = node => {
    if (node === window) return 'window';
    if (node === document.body) return 'body';
    if (node?.id === 'q') return 'q';
    const scope = node?.closest?.('[data-scope]')?.dataset.scope;
    if (scope) return 'scope:' + scope;
    if (node?.closest?.('[data-clipboard-kind]')) return 'kind';
    return 'other';
  };
  function record(event, target) {
    if (!enabled || sequence >= 250) return;
    void invoke('record_focus_sample', {sample:{event,target:label(target),active:label(document.activeElement),
      scope:document.querySelector('[data-scope].active')?.dataset.scope || 'all',focused:document.hasFocus(),
      sequence:++sequence,elapsed:performance.now()}}).catch(()=>{});
  }
  for (const event of ['mousedown','mouseup','click','focusin','focusout']) {
    document.addEventListener(event, e => {
      record(event,e.target);
      if (event === 'click') requestAnimationFrame(()=>record('after-click',e.target));
    }, true);
  }
  for (const event of ['focus','blur','error']) window.addEventListener(event,()=>record(event,window));
  invoke('focus_diagnostics_enabled').then(value=>{enabled=value===true;record('ready',window);}).catch(()=>{});
})();
