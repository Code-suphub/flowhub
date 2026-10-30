(() => {
  // Installed by the host before package scripts. Only persistent canvas cards
  // opt in; plugin panels, details and editors retain their own lifecycles.
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('flowhubWidgetToken');
  if (parent === window || !token || fragment.get('flowhubWidgetLifecycle') !== '1') return;
  const schedule = window.setTimeout.bind(window), cancel = window.clearTimeout.bind(window);
  const timers = new Map();
  let active = fragment.get('flowhubWidgetActive') !== '0', sequence = 0;
  const now = () => performance.now();
  function arm(timer) {
    timer.due = now() + timer.remaining;
    timer.native = schedule(() => {
      timer.native = null;
      if (!active || !timers.has(timer.id)) return;
      if (!timer.repeat) timers.delete(timer.id);
      try { Reflect.apply(timer.callback, window, timer.args); }
      finally {
        if (timer.repeat && timers.has(timer.id)) {
          timer.remaining = timer.delay;
          if (active) arm(timer);
        }
      }
    }, timer.remaining);
  }
  function add(callback, delay, repeat, args) {
    // String evaluation stays subject to the package's existing CSP.
    if (typeof callback !== 'function') return schedule(callback, delay, ...args);
    const numeric = Number(delay) || 0;
    const milliseconds = numeric < 0 || numeric > 2147483647 ? 0 : numeric;
    const timer = { id: --sequence, callback, args, repeat, delay: milliseconds, remaining: milliseconds, native: null, due: 0 };
    timers.set(timer.id, timer);
    if (active) arm(timer);
    return timer.id;
  }
  window.setTimeout = (callback, delay, ...args) => add(callback, delay, false, args);
  window.setInterval = (callback, delay, ...args) => add(callback, delay, true, args);
  window.clearTimeout = window.clearInterval = id => {
    const timer = timers.get(Number(id));
    if (timer) { cancel(timer.native); timers.delete(timer.id); }
    else cancel(id);
  };
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== parent || message?.token !== token || message.type !== 'flowhub:widget-lifecycle' || typeof message.active !== 'boolean' || message.active === active) return;
    active = message.active;
    for (const timer of timers.values()) {
      if (active) arm(timer);
      else {
        // Resume intervals at their normal cadence instead of replaying missed
        // ticks. One-shot work, including RPC deadlines, keeps its time budget.
        timer.remaining = timer.repeat ? timer.delay : Math.max(0, timer.due - now());
        cancel(timer.native); timer.native = null;
      }
    }
    window.dispatchEvent(new CustomEvent('flowhub:widget-activity', { detail: { active } }));
  });
})();
