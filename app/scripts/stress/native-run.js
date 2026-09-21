(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const bounded = (task, ms = 10000) => {
    let timer;
    return Promise.race([Promise.resolve(task), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('query-timeout')), ms);
    })]).finally(() => clearTimeout(timer));
  };
  const started = performance.now();
  const report = { engine: navigator.userAgent, startedAt: new Date().toISOString(), inputs: [], switches: [], paging: {} };
  let bridge, resultsEl, restore, invoke;
  const settle = async () => {
    const deadline = performance.now() + 10000;
    await sleep(250);
    while (bridge.inspect().loading) {
      if (performance.now() > deadline) throw new Error('query-timeout');
      await sleep(20);
    }
    await sleep(100);
  };
  try {
    invoke = window.__TAURI__?.core?.invoke;
    const deadline = performance.now() + 10000;
    while (!window.FlowHubSearchDiagnostics && performance.now() < deadline) await sleep(50);
    bridge = window.FlowHubSearchDiagnostics;
    if (!bridge) throw new Error('not-initialized');
    await bounded(bridge.ready);
    if (!bridge.inspect().initialized) throw new Error('not-initialized');
    restore = bridge.checkpoint();
    resultsEl = bridge.resultsElement();
    await bounded(window.refreshSearchTiming());
    window.flowhubSearchTiming.enable(true);
    // Fixed ordinary strings avoid executing smart network tools and avoid exporting user content.
    for (const scope of ['all', 'clipboard', 'web', 'app', 'memo']) {
      bridge.setScope(scope); await settle();
      for (const query of ['test', 'docker', 'flowhub']) {
        window.flowhubSearchTiming.reset();
        bridge.setQuery(query);
        await settle();
        const deadline = performance.now() + 3000;
        while (!window.flowhubSearchTiming.report().some(run => run.sources.length && run.sources.every(source => source.status !== 'pending')) && performance.now() < deadline) await sleep(50);
        const metrics = bridge.inspect({details:true});
        report.inputs.push({ scope, queryCase: report.inputs.length % 3, runs: window.flowhubSearchTiming.report(), rows: metrics.rows, sizes:metrics.sizes, htmlChars:metrics.htmlChars });
      }
    }
    bridge.setQuery(''); await settle();
    for (let round = 0; round < 5; round++) {
      for (const scope of ['all', 'clipboard', 'app', 'web', 'memo']) {
        window.flowhubSearchTiming.reset();
        const t = performance.now(); bridge.setScope(scope);
        const syncMs = performance.now() - t;
        await settle();
        report.switches.push({ scope, syncMs, runs: window.flowhubSearchTiming.report(), rows: resultsEl.querySelectorAll('.result').length });
      }
    }
    bridge.setScope('all'); await settle();
    await bounded(bridge.refreshAll()); await settle();
    let pages = 0, maxRows = 0; const times = [];
    let stopped = "limit";
    while (bridge.inspect().hasMore && pages < 400) {
      const deadline = performance.now() + 10000;
      while (bridge.inspect().paging && performance.now() < deadline) await sleep(20);
      const before = bridge.inspect().loaded;
      const t = performance.now(); await bounded(bridge.loadMore()); times.push(performance.now() - t);
      if (bridge.inspect().loaded <= before) { stopped = "no-progress"; break; }
      await sleep(20);
      maxRows = Math.max(maxRows, resultsEl.querySelectorAll('.result').length);
      pages++;
    }
    report.paging = { pages, times, maxRows, loaded: bridge.inspect().loaded, hasMore: bridge.inspect().hasMore, stopped: bridge.inspect().hasMore ? stopped : "end",
      queriesCurrent: bridge.inspect().queriesCurrent };
    const frameIntervals=[];
    for (let step=0;step<60;step++) {
      const t=performance.now();
      resultsEl.scrollTop = (step % 20) / 19 * (resultsEl.scrollHeight-resultsEl.clientHeight);
      await bounded(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      frameIntervals.push(performance.now()-t);
    }
    report.scroll={twoFrameWaitMs:frameIntervals,rows:resultsEl.querySelectorAll('.result').length};
    report.foldChecks=[];
    bridge.setScope('clipboard'); await settle();
    resultsEl.scrollTop=800; await sleep(250);
    const viewport=resultsEl.getBoundingClientRect();
    const foldButton=[...resultsEl.querySelectorAll('[data-clipboard-toggle]')].find(button=>{
      const bounds=button.closest('.result').getBoundingClientRect();return bounds.top>=viewport.top && bounds.top<viewport.bottom;
    });
    if (foldButton) {
      const row=foldButton.closest('.result');
      for (let step=0;step<2;step++) {
        const before=resultsEl.scrollTop;foldButton.click();await sleep(100);
        report.foldChecks.push({before,after:resultsEl.scrollTop,sameButton:foldButton.isConnected,sameRow:row.isConnected,expanded:foldButton.getAttribute('aria-expanded')});
      }
    }
    report.urlChecks=[];
    for (const query of ['https://example.com:9000/a?x=1&x=2','urlencode 中文 +','urldecode %E4%B8%AD']) {
      bridge.setScope('all'); bridge.setQuery(query);await settle();
      report.urlChecks.push({recognized:bridge.hasTool('url'),buttons:resultsEl.querySelectorAll('[data-tool-id="url"]').length});
    }
  } catch (error) { report.error = error.message === 'query-timeout' ? 'query-timeout' : 'runner-failed'; }
  finally {
    report.elapsedMs = performance.now() - started;
    // Each cleanup is independent: failed initialization/restoration/timing must
    // still notify Rust, which restores the pre-run pin state and RUNNING flag.
    try { restore?.(); } catch { report.restoreError = 'restore-failed'; }
    try { await bounded(window.refreshSearchTiming?.()); } catch { report.timingError = 'timing-reset-failed'; }
    try {
      invoke ||= window.__TAURI__?.core?.invoke;
      if (invoke) await invoke('save_search_diagnostic_run', { report });
    } catch { /* Native save releases the session even when writing fails. */ }
  }
})();
