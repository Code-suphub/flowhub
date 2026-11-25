import { useEffect, useState } from 'react';
import { Select } from '../shared/controls';
import { Row } from './fields';
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
  return <Row label="外观主题" note={preview ? '仅在此浏览器生效' : undefined}>
      <div className="settings-theme-picker">
        {value === 'system' && <span className="settings-theme-status" data-resolved={resolved} role="status">
          <span className="settings-theme-swatch" aria-hidden="true"><i data-tone="light" /><i data-tone="dark" /></span>
          当前{resolved === 'dark' ? '深色' : '浅色'}
        </span>}
        <Select label="外观主题" value={value} options={themes} onChange={next => {
          host().FlowHubTheme?.set(next);
          setTheme(readTheme(next));
        }} />
      </div>
  </Row>;
}
