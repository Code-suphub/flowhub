import { useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '../shared/ui';
import { host, readonly } from './api';
import { Row, Toggle } from './fields';
import { tools } from './model';
import { SettingsSection } from './SettingsSection';
import { SettingsStore, useSettings } from './store';
import './tools-settings.css';

const toolSections = [
  { title: '网络与连接', keys: ['ping', 'curl', 'dns', 'dnsIpGeo', 'cloudflare', 'ip'] },
  { title: '转换与解析', keys: ['calculator', 'timestamp', 'jwt', 'json', 'url'] },
  { title: '本机与进程', keys: ['port', 'localIp', 'proxy'] },
] as const;

function readHistoryCounts() {
  try {
    const counts = host().FlowHubCommandStore?.counts();
    if (counts && Number.isSafeInteger(counts.total) && Number.isSafeInteger(counts.templates) && counts.total >= 0 && counts.templates >= 0) {
      return { total: counts.total, templates: counts.templates };
    }
  } catch {
    return null;
  }
  return null;
}

export function Tools({ store }: { store: SettingsStore }) {
  const state = useSettings(store);
  const settings = state.config!.plugins.tools.settings;
  const locked = readonly() || state.busy || state.conflict;
  const [counts, setCounts] = useState(readHistoryCounts);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearError, setClearError] = useState('');
  const countStatus = useRef<HTMLSpanElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const hasHistoryData = Boolean(counts && (counts.total > 0 || counts.templates > 0));

  useEffect(() => {
    const refreshCounts = () => setCounts(readHistoryCounts());
    window.addEventListener('focus', refreshCounts);
    window.addEventListener('storage', refreshCounts);
    return () => {
      window.removeEventListener('focus', refreshCounts);
      window.removeEventListener('storage', refreshCounts);
    };
  }, []);

  function setEnabled(key: keyof typeof tools, enabled: boolean) {
    store.edit(config => { config.plugins.tools.settings[key] = enabled; });
  }

  function clearHistory() {
    const current = store.snapshot();
    if (readonly() || current.busy || current.conflict) return;
    let written;
    try {
      written = host().FlowHubCommandStore?.clearAll();
    } catch {
      setCounts(readHistoryCounts());
      setClearError('清空失败，请重试。');
      return;
    }
    const remaining = readHistoryCounts();
    setCounts(remaining);
    if (!remaining) {
      setClearError('无法确认清空结果，请重试。');
      return;
    }
    if (remaining.total || remaining.templates) {
      setClearError('仍有历史或模板未清空，请重试。');
      return;
    }
    if (written === false) {
      setClearError('清空失败，请重试。');
      return;
    }
    setConfirmOpen(false);
    requestAnimationFrame(() => countStatus.current?.focus({ preventScroll: true }));
  }

  return <>
    <div className="settings-tool-sections">
      {toolSections.map(section => <div key={section.title} className="settings-tools-card">
        <SettingsSection title={section.title}>
          <div className="settings-tools-grid">
            {section.keys.map(key => <Toggle key={key} label={tools[key]} checked={settings[key] !== false} disabled={locked} onChange={value => setEnabled(key, value)} />)}
          </div>
        </SettingsSection>
      </div>)}
      <div className="settings-tools-card">
        <SettingsSection title="历史与模板">
          <div className="settings-tools-grid">
            <Toggle label={tools.commandHistory} checked={settings.commandHistory !== false} disabled={locked} note="保存后生效，关闭会保留已有数据。" onChange={value => setEnabled('commandHistory', value)} />
            <Row label="命令历史与参数模板" help="Ping、HTTP 请求和端口查询共用命令历史。包含凭据的查询不会写入历史。" note={
              <span ref={countStatus} role="status" tabIndex={-1}>{counts ? `${counts.total} 条历史 · ${counts.templates} 个模板` : '暂时无法读取历史和模板'}</span>
            }>
              <Button disabled={locked || !hasHistoryData} onClick={() => { setClearError(''); setConfirmOpen(true); }}>清空历史与模板</Button>
              {!readonly() && hasHistoryData && <small className="fh-copy-note settings-tools-clear-note">确认后立即清空</small>}
            </Row>
          </div>
        </SettingsSection>
      </div>
    </div>
    {confirmOpen && <Dialog title="清空命令历史与模板" busy={false} onClose={() => setConfirmOpen(false)} initialFocus={cancelButton} notice={clearError}>
      <p>确认后立即清空历史和参数模板。此操作不能撤销。</p>
      <div className="settings-dialog-actions">
        <Button ref={cancelButton} onClick={() => setConfirmOpen(false)}>取消</Button>
        <Button variant="destructive" disabled={locked} onClick={clearHistory}>确认清空</Button>
      </div>
    </Dialog>}
  </>;
}
