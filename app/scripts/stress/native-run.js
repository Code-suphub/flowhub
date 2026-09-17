(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const started = performance.now();
  const report = { engine: navigator.userAgent, startedAt: new Date().toISOString(), inputs: [], switches: [], paging: {} };
  const savedQuery = q.value, savedScope = state.scope;
  const settle = async () => {
    const deadline = performance.now() + 10000;
    await sleep(250);
    while (state.clipboardLoading || state.appLoading || state.webLoading || state.memoLoading) {
      if (performance.now() > deadline) throw new Error('query-timeout');
      await sleep(20);
    }
    await sleep(100);
  };
  try {
    await sleep(500);
    if (!initialized) throw new Error('not-initialized');
    await window.refreshSearchTiming();
    window.flowhubSearchTiming.enable(true);
    // Fixed ordinary strings avoid executing smart network tools and avoid exporting user content.
    for (const scope of ['all', 'clipboard', 'web', 'app', 'memo']) {
      setScope(scope); await settle();
      for (const query of ['test', 'docker', 'flowhub']) {
        window.flowhubSearchTiming.reset();
        q.value = query; q.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        const deadline = performance.now() + 3000;
        while (!window.flowhubSearchTiming.report().some(run => run.sources.length && run.sources.every(source => source.status !== 'pending')) && performance.now() < deadline) await sleep(50);
        report.inputs.push({ scope, queryCase: report.inputs.length % 3, runs: window.flowhubSearchTiming.report(), rows: resultsEl.querySelectorAll('.result').length, sizes:matches().map(item=>({type:item.type,content:String(item.content||'').length,preview:String(item.content||'').split('\n').slice(0,2).join('\n').length,description:String(item.description||'').length,title:String(item.title||'').length,icon:String(item.iconUrl||item.imageUrl||'').length})), htmlChars:resultsEl.innerHTML.length });
      }
    }
    q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    for (let round = 0; round < 5; round++) {
      for (const scope of ['all', 'clipboard', 'app', 'web', 'memo']) {
        window.flowhubSearchTiming.reset();
        const t = performance.now(); setScope(scope);
        const syncMs = performance.now() - t;
        await settle();
        report.switches.push({ scope, syncMs, runs: window.flowhubSearchTiming.report(), rows: resultsEl.querySelectorAll('.result').length });
      }
    }
    setScope('all'); await settle();
    await refreshAllScopes(); await settle();
    let pages = 0, maxRows = 0; const times = [];
    let stopped = "limit";
    while (allHasMore() && pages < 400) {
      const deadline = performance.now() + 10000;
      while (allPaging && performance.now() < deadline) await sleep(20);
      const before = matches().length;
      const t = performance.now(); await loadMoreAll(); times.push(performance.now() - t);
      if (matches().length <= before) { stopped = "no-progress"; break; }
      await sleep(20);
      maxRows = Math.max(maxRows, resultsEl.querySelectorAll('.result').length);
      pages++;
    }
    report.paging = { pages, times, maxRows, loaded: matches().length, hasMore: allHasMore(), stopped: allHasMore() ? stopped : "end",
      queriesCurrent: ['clipboard','app','web','memo'].map(id => ({source:id,current:state[id+'LoadedQuery']===state.query,hasMore:state[id+'HasMore'],count:state[id+'Results'].length})) };
    const frameIntervals=[];
    for (let step=0;step<60;step++) {
      const t=performance.now();
      resultsEl.scrollTop = (step % 20) / 19 * (resultsEl.scrollHeight-resultsEl.clientHeight);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      frameIntervals.push(performance.now()-t);
    }
    report.scroll={twoFrameWaitMs:frameIntervals,rows:resultsEl.querySelectorAll('.result').length};
    report.foldChecks=[];
    setScope('clipboard'); await settle();
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
      setScope('all'); q.value=query;q.dispatchEvent(new Event('input',{bubbles:true}));await settle();
      report.urlChecks.push({recognized:matches().some(item=>item.toolId==='url'),buttons:resultsEl.querySelectorAll('[data-tool-id="url"]').length});
    }
  } catch (error) { report.error = error.message === 'query-timeout' ? 'query-timeout' : 'runner-failed'; }
  finally {
    report.elapsedMs = performance.now() - started;
    q.value = savedQuery; q.dispatchEvent(new Event('input', { bubbles: true })); setScope(savedScope);
    await window.refreshSearchTiming();
    await window.__TAURI__.core.invoke('save_search_diagnostic_run', { report });
  }
})();
