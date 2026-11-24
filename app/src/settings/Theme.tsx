import { useEffect, useState } from 'react';
import { Help, Select } from '../shared/controls';
import { host, readonly } from './api';
import './appearance.css';

const themes = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

function readTheme(fallback = 'system') {
  return {
    value: host().FlowHubTheme?.get() || fallback,
    resolved: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  };
}

export function Theme() {
  const [{ value, resolved }, setTheme] = useState(readTheme);
  useEffect(() => {
    const sync = () => setTheme(readTheme());
    const message = (event: MessageEvent) => { if (event.data?.type === 'flowhub:theme') sync(); };
    window.addEventListener('flowhub-theme-change', sync); window.addEventListener('flowhub:theme', sync); window.addEventListener('message', message);
    return () => { window.removeEventListener('flowhub-theme-change', sync); window.removeEventListener('flowhub:theme', sync); window.removeEventListener('message', message); };
  }, []);

  const preview = readonly();
  return <section className="settings-appearance-panel" aria-labelledby="appearance-theme-heading">
    <div className="settings-appearance-choice" data-setting-label="外观主题" tabIndex={-1}>
      <div>
        <div className="settings-appearance-heading">
          <h2 id="appearance-theme-heading">外观主题</h2>
          {!preview && <Help label="窗口材质说明">macOS 窗口材质随桌面变化，并遵循系统的「降低透明度」设置。</Help>}
        </div>
        <p className="settings-appearance-note">{preview ? '仅在此浏览器生效' : '即时生效'}</p>
      </div>
      <div className="settings-theme-picker" data-setting-control>
        {value === 'system' && <span className="settings-theme-status" data-resolved={resolved} role="status">
          <span className="settings-theme-swatch" aria-hidden="true"><i data-tone="light" /><i data-tone="dark" /></span>
          当前{resolved === 'dark' ? '深色' : '浅色'}
        </span>}
        <Select label="外观主题" value={value} options={themes} onChange={next => {
          host().FlowHubTheme?.set(next);
          setTheme(readTheme(next));
        }} />
      </div>
    </div>
  </section>;
}
