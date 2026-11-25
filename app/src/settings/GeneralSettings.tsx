import { useRef, useState } from 'react';
import { Button } from '../shared/ui';
import { readonly, write } from './api';
import { Choice, Row, Shortcut, Toggle } from './fields';
import { SettingsStore, useSettings } from './store';
import './general-settings.css';

const proxyAdapters = [
  { value: 'auto', label: '自动' },
  { value: 'mihomo', label: 'Mihomo' },
  { value: 'clash-rest', label: 'Clash REST' },
  { value: 'system', label: '系统代理' },
];

export function GeneralSettings({ store }: { store: SettingsStore }) {
  const state = useSettings(store);
  const { core, plugins } = state.config!;
  const preview = readonly();
  const locked = preview || state.busy || state.conflict;
  const notificationsEnabled = core.notifications.enabled;
  const savedNotificationsEnabled = Boolean(state.saved?.core.notifications.enabled);
  const notificationPending = !preview && notificationsEnabled && !savedNotificationsEnabled;
  const [test, setTest] = useState<{ status: 'sending' | 'sent' | 'error'; message?: string } | null>(null);
  const notificationInFlight = useRef(false);

  async function sendTestNotification() {
    const current = store.snapshot();
    if (notificationInFlight.current || readonly() || current.busy || current.conflict ||
        !current.config?.core.notifications.enabled || !current.saved?.core.notifications.enabled) return;
    notificationInFlight.current = true;
    setTest({ status: 'sending' });
    try {
      await write('sendTestNotification');
      setTest({ status: 'sent', message: '测试通知已发送' });
    } catch (error) {
      setTest({ status: 'error', message: error instanceof Error && error.message ? error.message : '无法发送测试通知，请重试。' });
    } finally {
      notificationInFlight.current = false;
    }
  }

  return <div className="settings-core-general">
    <section className="settings-core-group" aria-labelledby="general-launch-heading">
      <h2 id="general-launch-heading" className="settings-core-group-title">启动与快捷键</h2>
      <Shortcut label="唤出 FlowHub" value={core.hotkey || 'Alt+Space'} taken={Object.values(core.scopeShortcuts)} disabled={locked}
        onChange={value => store.edit(config => { config.core.hotkey = value; })} />
      <Toggle label="开机自动启动" checked={core.launchAtLogin === true} disabled={locked}
        help="登录 macOS 后自动启动 FlowHub。保存后生效。"
        onChange={value => store.edit(config => { config.core.launchAtLogin = value; })} />
    </section>
    <section className="settings-core-group" aria-labelledby="general-network-heading">
      <h2 id="general-network-heading" className="settings-core-group-title">网络</h2>
      <Choice label="代理检测适配器" value={plugins.tools.settings.proxyAdapter} options={proxyAdapters}
        onChange={value => store.edit(config => { config.plugins.tools.settings.proxyAdapter = value; })} />
    </section>
    <section className="settings-core-group" aria-labelledby="general-notifications-heading">
      <h2 id="general-notifications-heading" className="settings-core-group-title">通知</h2>
      <Toggle label="允许通知" checked={notificationsEnabled} disabled={locked} onChange={value => {
        if (!notificationInFlight.current) setTest(null);
        store.edit(config => { config.core.notifications.enabled = value; });
      }} />
      <Toggle label="更新通知" checked={core.notifications.updates} disabled={locked || !notificationsEnabled}
        onChange={value => store.edit(config => { config.core.notifications.updates = value; })} />
      <Row label="系统通知权限" help="在 macOS 的系统设置 → 通知中管理 FlowHub 的权限。"
        note={notificationPending ? '保存后可发送测试通知。' : undefined}>
        <div className="settings-notify-control">
          <Button disabled={locked || !notificationsEnabled || !savedNotificationsEnabled || test?.status === 'sending'}
            onClick={() => void sendTestNotification()}>{test?.status === 'sending' ? '发送中…' : '发送测试通知'}</Button>
          {notificationsEnabled && savedNotificationsEnabled && test?.message && (
            <small role={test.status === 'error' ? 'alert' : 'status'} className="settings-notify-feedback">
              {test.message}
            </small>
          )}
        </div>
      </Row>
    </section>
  </div>;
}
