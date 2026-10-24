import { AppWindowIcon } from 'lucide-react';
import { Button } from '../shared/ui';
import { Row, Toggle } from './fields';
import { write } from './api';
import { SettingsStore, useSettings } from './store';

export function Applications({ store }: { store: SettingsStore }) {
  const s = useSettings(store);
  return <section className="settings-applications" aria-labelledby="application-options-title">
    <header><span className="settings-application-icon"><AppWindowIcon aria-hidden="true" /></span><h2 id="application-options-title">搜索与启动</h2></header>
    <Toggle label="启用应用搜索" checked={s.config!.plugins.app.enabled !== false} onChange={value => store.edit(config => { config.plugins.app.enabled = value; })} help="扫描 macOS 应用目录，在搜索结果中显示应用图标，回车即可启动。" />
    <Row label="辅助功能权限" help="在系统设置中查看或调整 FlowHub 的辅助功能授权。"><Button onClick={() => void store.run(async () => { await write('openAccessibilitySettings'); })}>打开系统设置</Button></Row>
  </section>;
}
