(() => {
  const key = 'flowhub.theme';
  const media = matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['light', 'dark', 'system'].includes(value);
  let preference = 'system';
  try { const saved = localStorage.getItem(key); if (valid(saved)) preference = saved; } catch {}
  const resolved = () => preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  const message = () => ({type: 'flowhub:theme', theme: resolved(), preference});
  function apply() {
    document.documentElement.dataset.theme = resolved();
    document.documentElement.style.colorScheme = resolved();
    document.querySelectorAll('[data-theme-select]').forEach(select => { select.value = preference; });
    document.querySelectorAll('iframe').forEach(frame => frame.contentWindow?.postMessage(message(), '*'));
    window.dispatchEvent(new Event('flowhub-theme-change'));
  }
  window.FlowHubTheme = {get: () => preference, set(value) {
    if (!valid(value)) return;
    preference = value;
    try { localStorage.setItem(key, value); } catch {}
    apply();
  }};
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : 'system'; apply();
  });
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('message', event => {
    if (event.data?.type !== 'flowhub:theme-ready') return;
    // Theme data is public, but only actual child surfaces receive a reply.
    const frame = [...document.querySelectorAll('iframe')].find(frame => frame.contentWindow === event.source);
    frame?.contentWindow?.postMessage(message(), '*');
  });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-theme-select]')) window.FlowHubTheme.set(event.target.value);
  });
  document.addEventListener('DOMContentLoaded', apply);
  apply();
})();
