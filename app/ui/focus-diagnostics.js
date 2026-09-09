// Explicit local diagnostic session; no values, text, URLs or clipboard data.
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  let enabled = false, sequence = 0;
  // Keep this probe local: no periodic IPC or disk writes. A healthy timer
  // during delayed input separates event delivery from a blocked JS thread.
  let lastTick = 0;
  let loopTimer = null;
  const ticks = [];
  function sampleLoop() {
    const now = performance.now();
    if (!document.hasFocus()) { lastTick=0; ticks.length=0; return; }
    if (document.hasFocus() && lastTick) ticks.push({end:now, gap:now-lastTick});
    lastTick = document.hasFocus() ? now : 0;
    while (ticks.length && ticks[0].end < now-1000) ticks.shift();
  }
  // The startup option permits A/B without keeping WebContent awake.
  function setLoopProbe(value) {
    if (loopTimer !== null) clearInterval(loopTimer);
    loopTimer = null; lastTick = 0; ticks.length = 0;
    if (enabled && value === true) loopTimer = setInterval(sampleLoop,16);
  }
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
    if (!enabled || sequence >= 250) { if (sequence >= 250) setLoopProbe(false); return; }
    void invoke('record_focus_sample', {sample:{event,target:label(target),active:label(document.activeElement),
      scope:document.querySelector('[data-scope].active')?.dataset.scope || 'all',focused:document.hasFocus(),
      sequence:++sequence,elapsed:performance.now(),metrics}}).catch(()=>{});
  }
  for (const event of ['mousedown','mouseup','click','focusin','focusout']) {
    document.addEventListener(event, e => {
      const delay = performance.now() - e.timeStamp;
      const metrics = delay >= 0 && delay < 60000 ? {eventDelayMs:delay} : {};
      if (enabled && lastTick) {
        const now = performance.now();
        metrics.eventLoopGapMs = Math.max(now-lastTick, ...ticks.filter(t=>t.end>=now-500).map(t=>t.gap));
      }
      record(event,e.target,metrics);
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
  for (const event of ['focus','blur','error']) window.addEventListener(event,()=>{
    if (event !== 'error') { lastTick=0; ticks.length=0; }
    record(event,window);
  });
  invoke('focus_diagnostics_enabled').then(value=>{
    enabled=value===true;
    if (enabled) void invoke('focus_diagnostics_loop_enabled').then(setLoopProbe).catch(()=>{});
    record('ready',window);
  }).catch(()=>{});
})();
