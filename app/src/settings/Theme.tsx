import { useEffect, useState } from 'react';
import { Select } from '../shared/controls';
import { host } from './api';
export function Theme() {
  const [value, setValue] = useState(() => host().FlowHubTheme?.get() || 'system');
  useEffect(() => {
    const sync = () => setValue(host().FlowHubTheme?.get() || 'system');
    const message = (event: MessageEvent) => { if (event.data?.type === 'flowhub:theme') sync(); };
    window.addEventListener('flowhub-theme-change', sync); window.addEventListener('flowhub:theme', sync); window.addEventListener('message', message);
    return () => { window.removeEventListener('flowhub-theme-change', sync); window.removeEventListener('flowhub:theme', sync); window.removeEventListener('message', message); };
  }, []);
  return <Select label="外观主题" value={value} options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} onChange={next => { host().FlowHubTheme?.set(next); setValue(host().FlowHubTheme?.get() || next); }} />;
}
