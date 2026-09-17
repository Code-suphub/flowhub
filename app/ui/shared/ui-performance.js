// Opt-in, bounded local measurements. Never collect field values or user content.
(() => {
  let enabled = false, frame = 0, last = 0, until = 0;
  const samples = { scroll: [], input: [], draft: [] };
  function add(kind, value) { const a = samples[kind]; a.push(value); if (a.length > 2000) a.shift(); }
  function tick(now) {
    if (!enabled || now > until || document.hidden) { frame = 0; last = 0; return; }
    if (last) add('scroll', now - last);
    last = now; frame = requestAnimationFrame(tick);
  }
  document.addEventListener('scroll', () => {
    if (!enabled) return;
    until = performance.now() + 150;
    if (!frame) frame = requestAnimationFrame(tick);
  }, { capture: true, passive: true });
  function stats(a) {
    if (!a.length) return '无样本';
    const sorted = [...a].sort((a,b) => a-b);
    return `n=${a.length}, p50=${sorted[Math.floor((a.length-1)*.5)].toFixed(2)}ms, p95=${sorted[Math.ceil((a.length-1)*.95)].toFixed(2)}ms, max=${sorted.at(-1).toFixed(2)}ms`;
  }
  window.flowhubPerformance = {
    enable(value) { enabled = value; if (!value && frame) { cancelAnimationFrame(frame); frame=0; last=0; } },
    measure(kind, task) { if (!enabled) return task(); const start=performance.now(); try { return task(); } finally { add(kind, performance.now()-start); } },
    report() {
      const a=samples.scroll, avg=a.reduce((x,y)=>x+y,0)/a.length;
      return `滚动帧间隔：${stats(a)}${a.length ? `；等效帧率 ${(1000/avg).toFixed(1)} fps；>33.3ms ${a.filter(v=>v>33.3).length} 帧` : ''}\n输入事件处理：${stats(samples.input)}\n草稿序列化与本地存储：${stats(samples.draft)}`;
    },
    reset() { Object.values(samples).forEach(a=>a.length=0); }
  };
})();
