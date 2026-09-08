// Opt-in, in-memory measurements. No queries, result contents or URLs retained.
(() => {
  let enabled = false, current = null, serial = 0;
  const runs = [];
  const now = () => performance.now();
  const api = {
    enable(value) { enabled = value === true; if (!enabled) current = null; },
    begin(reason) {
      if (!enabled) return;
      current = { id: ++serial, reason: reason === 'scope' ? 'scope' : 'input', start: now(), sources: [], renders: [] };
      runs.push(current); if (runs.length > 100) runs.shift();
    },
    capture() { return current; },
    dispatch(run) { if (run && run === current) run.dispatchMs ??= now() - run.start; },
    async query(source, task) {
      const run = current, start = now();
      if (!run) return task();
      const entry = { source, startMs: start - run.start, status: 'pending' };
      if (run.sources.length < 100) run.sources.push(entry);
      try { const value = await task(); entry.status = 'ok'; return value; }
      catch (error) { entry.status = 'error'; throw error; }
      finally { entry.durationMs = now() - start; entry.stale = current !== run; }
    },
    applied() { if (current) current.hasAppliedSource = true; },
    render(task) {
      const run = current, start = now();
      try { return task(); }
      finally {
        if (run && run === current) {
          const end = now();
          if (run.renders.length < 100) run.renders.push(end - start);
          if (run.hasAppliedSource && run.firstResponseDomMs == null) {
            run.firstResponseDomMs = end - run.start;
            requestAnimationFrame(() => {
              if (enabled && current === run) run.nextFrameWaitMs = now() - end;
            });
          }
        }
      }
    },
    report() { return JSON.parse(JSON.stringify(runs)); },
    reset() { runs.length = 0; current = null; }
  };
  window.flowhubSearchTiming = api;
  window.refreshSearchTiming = async () => {
    try { api.enable((await window.weborg?.getDiagnosticsState?.())?.enabled === true); } catch { api.enable(false); }
  };
  void window.refreshSearchTiming();
})();
