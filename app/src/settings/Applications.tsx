import { useEffect, useId, useRef, useState } from 'react';
import { SquareArrowOutUpRightIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../shared/ui';
import { Row, Toggle } from './fields';
import { call, readonly, write } from './api';
import { SettingsStore, useSettings } from './store';

const permissionLabels = {
  checking: '正在读取授权状态…',
  granted: '已授权',
  denied: '未授权',
  unavailable: '授权状态读取失败',
  unsupported: '当前系统不支持',
};
const permissionRefreshMs = 5_000;

export function Applications({ store }: { store: SettingsStore }) {
  const s = useSettings(store);
  const preview = readonly();
  const permissionNote = useId();
  const openingRequest = useRef(false);
  const [opening, setOpening] = useState(false);
  const [permissionError, setPermissionError] = useState('');
  const [permission, setPermission] = useState<keyof typeof permissionLabels>('checking');

  useEffect(() => {
    if (preview) return;
    let disposed = false;
    let reading = false;

    async function refreshPermission() {
      if (disposed || reading || document.hidden) return;
      reading = true;
      try {
        const state = await call<{ supported?: boolean; trusted?: boolean }>('getMenuBarManagementState');
        if (disposed) return;
        if (state?.supported === false) setPermission('unsupported');
        else if (typeof state?.trusted !== 'boolean') setPermission('unavailable');
        else setPermission(state.trusted ? 'granted' : 'denied');
      } catch {
        if (!disposed) setPermission('unavailable');
      } finally {
        reading = false;
      }
    }

    void refreshPermission();
    const timer = window.setInterval(refreshPermission, permissionRefreshMs);
    window.addEventListener('focus', refreshPermission);
    document.addEventListener('visibilitychange', refreshPermission);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshPermission);
      document.removeEventListener('visibilitychange', refreshPermission);
    };
  }, [preview]);

  async function openAccessibilitySettings() {
    if (preview || openingRequest.current) return;
    openingRequest.current = true;
    setOpening(true);
    setPermissionError('');
    try {
      await write('openAccessibilitySettings');
    } catch (error) {
      setPermissionError(error instanceof Error ? error.message : String(error));
    } finally {
      openingRequest.current = false;
      setOpening(false);
    }
  }

  return <section className="settings-applications max-w-2xl min-w-0 rounded-xl border border-[var(--fh-border)] bg-[var(--fh-surface-raised)] px-3 sm:px-4 max-sm:[&_[data-slot=switch]]:after:-inset-y-3.5" aria-label="应用设置">
    <div className="settings-section">
      <Toggle
        label="启用应用搜索"
        note="保存后生效。"
        checked={s.config!.plugins.app.enabled !== false}
        disabled={preview}
        onChange={value => store.edit(config => { config.plugins.app.enabled = value; })}
      />
      <Row
        label="辅助功能权限"
        note={preview ? '请在 FlowHub App 中查看授权状态。' : <span role="status">{permissionLabels[permission]}</span>}
        noteId={permissionNote}
      >
        <Button aria-describedby={permissionNote} className="max-sm:min-h-11" disabled={preview || opening || permission === 'unsupported'} onClick={() => void openAccessibilitySettings()}>
          {opening ? '正在打开…' : '打开系统设置'}<SquareArrowOutUpRightIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </Row>
    </div>
    {permissionError && <Alert variant="destructive" className="mb-3">
      <AlertTitle>系统设置未打开</AlertTitle>
      <AlertDescription>{permissionError}<p>可手动前往「系统设置 → 隐私与安全性 → 辅助功能」。</p></AlertDescription>
    </Alert>}
  </section>;
}
