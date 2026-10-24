import { useState } from 'react';
import { AppWindowIcon, ClipboardIcon, CommandIcon, Layers2Icon, PackageOpenIcon, ShieldIcon } from 'lucide-react';
import { Button, Tabs } from '../shared/ui';
import { Switch } from '../shared/controls';
import { isKnownMenuBarSection, menuBarSectionLabel } from '../shared/menu-bar';
import { Toggle } from './fields';
import { readonly, write } from './api';
import { SettingsStore, useSettings } from './store';
import type { Bag } from './model';

const examples = [
  { windowId: 1, displayName: 'FlowHub', section: 'visible', hideable: true, detail: '随时唤起你的工作空间', Icon: Layers2Icon },
  { windowId: 2, displayName: 'Raycast', section: 'visible', hideable: true, detail: '快速启动与命令', Icon: CommandIcon },
  { windowId: 3, displayName: 'Dropover', section: 'visible', hideable: true, detail: '临时文件托盘', Icon: PackageOpenIcon },
  { windowId: 4, displayName: '网络代理', section: 'alwaysHidden', hideable: true, detail: '需要时再出现', Icon: ShieldIcon },
  { windowId: 5, displayName: '剪贴板', section: 'alwaysHidden', hideable: true, detail: '需要时再出现', Icon: ClipboardIcon },
];

export function MenuBar({ store }: { store: SettingsStore }) {
  const s = useSettings(store), core = s.config!.core, preview = readonly();
  const [filter, setFilter] = useState('all');
  const [demo, setDemo] = useState(() => examples.map(item => ({ ...item })));
  const items: Bag[] = preview ? demo : s.menuItems;
  const shown = items.filter(item => item.section === 'visible' || item.section === 'hidden');
  const filtered = filter === 'visible' ? shown : items;
  return <div className="settings-menubar">
    <div className="settings-page-intro"><span className="settings-eyebrow">A LITTLE LESS. A LITTLE LIGHTER.</span><h2>留一点，刚刚好。</h2><p>整理菜单栏，把视线留给正在做的事。</p></div>
    {preview ? <div className="settings-menu-demo" aria-label="菜单栏效果演示"><span>显示效果</span><div>{shown.map(item => { const Icon = item.Icon || AppWindowIcon; return <Icon key={item.windowId} aria-label={item.displayName} />; })}</div><small>示例数据</small></div> : null}
    <div className="settings-menu-toolbar"><Tabs label="筛选菜单栏项目" items={[{ id: 'all', label: '全部项目' }, { id: 'visible', label: '已显示' }]} value={filter} onChange={setFilter} /><span>{shown.length} / {items.length} 项{preview ? '显示' : '可显示'}</span></div>
    <div className="settings-menu-items" role="tabpanel" id={`panel-${filter}`} aria-labelledby={`tab-${filter}`} aria-label="菜单栏项目">{filtered.map(item => {
      const id = Number(item.windowId ?? item.window_id);
      const name = item.displayName || item.accessibilityLabel || item.name || item.ownerName || item.owner_name || item.title || '菜单栏图标';
      const Icon = item.Icon || AppWindowIcon;
      const disabled = !item.hideable || !isKnownMenuBarSection(item.section) || (!preview && (!core.menuBar.organizerEnabled || !s.management.trusted || s.busy || s.conflict));
      return <label className="settings-menu-item" key={id}>
        <span className="settings-menu-icon"><Icon aria-hidden="true" /></span>
        <span className="settings-menu-copy"><strong>{name}</strong><small>{preview ? item.detail : `${menuBarSectionLabel(item.section)}${!item.hideable ? ' · 系统固定' : ''}`}</small></span>
        <Switch label={`显示 ${name}`} checked={isKnownMenuBarSection(item.section) && item.section !== 'alwaysHidden'} disabled={disabled} onChange={visible => {
          if (preview) setDemo(previous => previous.map(entry => entry.windowId === id ? { ...entry, section: visible ? 'visible' : 'alwaysHidden' } : entry));
          else void store.run(async () => { await write('setMenuBarItemHidden', id, !visible); await store.refreshMenu(); });
        }} />
      </label>;
    })}{!filtered.length ? <p className="settings-menu-empty">{filter === 'visible' ? '暂无可显示项目' : core.menuBar.organizerEnabled ? '授权辅助功能后，扫描菜单栏图标。' : '在下方开启隐藏分区，开始整理菜单栏。'}</p> : null}</div>
    <div className="settings-menu-foot"><p>{preview ? '切换开关，预览菜单栏变化；刷新后复原。' : '逐项开关即时生效；隐藏分区中的项目随箭头展开或收起。'}</p>{preview ? <Button variant="ghost" onClick={() => { setDemo(examples.map(item => ({ ...item }))); setFilter('all'); }}>恢复默认</Button> : <Button variant="ghost" disabled={s.busy || !core.menuBar.organizerEnabled} onClick={() => void store.run(() => store.refreshMenu())}>扫描图标</Button>}</div>
    <details className="settings-menu-options"><summary>菜单栏设置与权限</summary><fieldset className="settings-fieldset" disabled={preview || s.busy || s.conflict}>
      {Object.entries({ enabled: '显示 FlowHub 图标', showOpenLauncher: '打开启动器', showOpenSettings: '打开设置', showVersion: '显示版本', showQuit: '退出菜单', organizerEnabled: '启用菜单栏隐藏分区', collapseOnLaunch: '启动时收起隐藏分区' }).map(([key, label]) => <Toggle key={key} label={label} checked={core.menuBar[key] === true} disabled={key === 'collapseOnLaunch' ? !core.menuBar.organizerEnabled : ['showOpenLauncher', 'showOpenSettings', 'showVersion', 'showQuit'].includes(key) && !core.menuBar.enabled} onChange={v => store.edit(c => { c.core.menuBar[key] = v; })} />)}
      <div className="settings-menu-native-actions"><Button disabled={!core.menuBar.organizerEnabled} onClick={() => void store.run(async () => { await write('toggleMenuBarItems'); })}>展开 / 收起</Button><Button onClick={() => void store.run(async () => { await write('requestMenuBarManagementPermission'); await store.refreshMenu(); })}>授权辅助功能</Button></div>
    </fieldset><p className="settings-menu-permission" role="status">{preview ? '此处为交互演示，不会修改 Mac 菜单栏或保存配置。' : s.management.supported === false ? '当前系统不支持菜单栏图标管理。' : s.management.trusted ? '辅助功能已授权；可按住 ⌘ 拖动图标调整分区。' : '辅助功能未授权，扫描和逐项管理图标需授权。'}</p></details>
  </div>;
}
