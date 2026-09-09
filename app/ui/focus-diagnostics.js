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
  function record(event, target, metrics = {}) {
    if (!enabled || sequence >= 250) return;
    void invoke('record_focus_sample', {sample:{event,target:label(target),active:label(document.activeElement),
      scope:document.querySelector('[data-scope].active')?.dataset.scope || 'all',focused:document.hasFocus(),
      sequence:++sequence,elapsed:performance.now(),metrics}}).catch(()=>{});
  }
  for (const event of ['mousedown','mouseup','click','focusin','focusout']) {
    document.addEventListener(event, e => {
      const delay = performance.now() - e.timeStamp;
      record(event,e.target, delay >= 0 && delay < 60000 ? {eventDelayMs:delay} : {});
      if (enabled && event === 'mousedown' && e.target.closest?.('[data-scope], [data-clipboard-kind]')) {
        window.flowhubSearchTiming?.enable(true);
        const start = performance.now();
        requestAnimationFrame(() => {
          const run = window.flowhubSearchTiming?.capture();
          requestAnimationFrame(() => {
            if (!run || window.flowhubSearchTiming?.capture() !== run) return;
            const metrics = {frameWaitMs:performance.now()-start,
              renderMs:run.renders.reduce((sum,value)=>sum+value,0),
              queryMs:run.sources.reduce((sum,value)=>sum+(value.durationMs||0),0)};
            for (const name of ['matches','markup','dom','layout']) metrics[name+'Ms'] =
              (run.phases||[]).filter(phase=>phase.name===name).reduce((sum,phase)=>sum+phase.ms,0);
            record('after-press',e.target,metrics);
          });
        });
      }
      if (event === 'click') requestAnimationFrame(()=>record('after-click',e.target));
    }, true);
  }
  for (const event of ['focus','blur','error']) window.addEventListener(event,()=>record(event,window));
  invoke('focus_diagnostics_enabled').then(value=>{enabled=value===true;record('ready',window);}).catch(()=>{});
})();
