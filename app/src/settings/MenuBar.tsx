import { AppWindowIcon, ClipboardIcon, CommandIcon, Layers2Icon, PackageOpenIcon, RefreshCwIcon, ShieldIcon } from 'lucide-react';
import { FlowHubLogo } from '../shared/FeatureIcon';
import { Button, Tabs } from '../shared/ui';
import { Help, Switch } from '../shared/controls';
import { isKnownMenuBarSection, menuBarSectionLabel } from '../shared/menu-bar';
import { Row, Toggle } from './fields';
import { readonly, write } from './api';
import { SettingsStore, useSettings } from './store';
import { flowHubMenuIconLabel, flowHubMenuItems, type Bag } from './model';
import { ViewDetails, useViewState } from './view-state';
import './menu-bar-workspace.css';

const examples = [
  { windowId: 1, displayName: 'FlowHub', section: 'visible', hideable: true, Icon: Layers2Icon },
  { windowId: 2, displayName: '快捷启动', section: 'visible', hideable: true, Icon: CommandIcon },
  { windowId: 3, displayName: '文件托盘', section: 'visible', hideable: true, Icon: PackageOpenIcon },
  { windowId: 4, displayName: '网络代理', section: 'alwaysHidden', hideable: true, Icon: ShieldIcon },
  { windowId: 5, displayName: '剪贴板', section: 'alwaysHidden', hideable: true, Icon: ClipboardIcon },
];
export function MenuBar({ store }: { store: SettingsStore }) {
  const s = useSettings(store);
  const config = s.config!.core.menuBar;
  const iconVisible = config.enabled === true;
  const preview = readonly();
  const supported = s.management.supported !== false;
  const trusted = s.management.trusted === true;
  const liveOrganizer = s.saved?.core.menuBar.organizerEnabled === true;
  const draftOrganizer = config.organizerEnabled === true;
  const organizerPending = draftOrganizer !== liveOrganizer;
  const hasAccess = supported && trusted && liveOrganizer;
  const locked = s.busy || s.conflict;
  const canManage = hasAccess && !organizerPending && !locked;
  const [filter, setFilter] = useViewState('menubar:filter', 'all');
  const [demo, setDemo] = useViewState('menubar:preview', () => examples.map(item => ({ ...item })));
  const items: Bag[] = preview ? demo : hasAccess ? s.menuItems : [];
  const shown = items.filter(item => item.section === 'visible' || item.section === 'hidden');
  const filtered = filter === 'visible' ? shown : items;
  const empty = filter === 'visible' ? '没有可显示的图标。' : '没有读到菜单栏图标。可重新扫描。';
  const unavailable = !supported ? '当前系统不支持管理菜单栏图标。'
    : organizerPending ? '保存隐藏分区设置后生效。'
      : !liveOrganizer ? '开启隐藏分区并保存，即可开始管理图标。'
        : '授权辅助功能后可扫描菜单栏图标。';
  const change = (key: string, value: boolean) => store.edit(c => { c.core.menuBar[key] = value; });

  return <div className="settings-menubar">
    {preview && <section className="settings-menu-demo" aria-label="菜单栏效果演示">
      <div><h2>菜单栏预览</h2><small>示例数据，刷新后复原。</small></div>
      <div className="settings-menu-demo-icons">{shown.map(item => {
        const Icon = item.Icon || AppWindowIcon;
        return item.displayName === 'FlowHub'
          ? <span key={item.windowId} role="img" aria-label="FlowHub"><FlowHubLogo /></span>
          : <Icon key={item.windowId} role="img" aria-label={item.displayName} />;
      })}</div>
      <Button size="sm" variant="ghost" onClick={() => { setDemo(examples.map(item => ({ ...item }))); setFilter('all'); }}>恢复默认</Button>
    </section>}
    <section className="settings-menubar-card" aria-labelledby="menu-items-heading">
      <div className="settings-menubar-heading">
        <h2 id="menu-items-heading">菜单栏项目</h2>
        {!preview && hasAccess && <div className="settings-menu-native-actions">
          <Button size="sm" variant="outline" disabled={!canManage} onClick={() => void store.run(() => store.refreshMenu())}><RefreshCwIcon aria-hidden="true" />扫描图标</Button>
          <Button size="sm" variant="ghost" disabled={!canManage} onClick={() => void store.run(async () => { await write('toggleMenuBarItems'); })}>展开 / 收起</Button>
        </div>}
      </div>
      {(preview || hasAccess) ? <>
        <div className="settings-menu-toolbar">
          <Tabs label="筛选菜单栏项目" items={[{ id: 'all', label: '全部项目' }, { id: 'visible', label: preview ? '已显示' : '可显示' }]} value={filter} onChange={setFilter} />
          <span>{shown.length} / {items.length} 项{preview ? '显示' : '可显示'}</span>
        </div>
        {!preview && <p className="settings-menu-status" role="status">{organizerPending ? '保存后关闭隐藏分区。' : '图标开关即时生效。'}</p>}
        <div className="settings-menu-items" role="tabpanel" id={`panel-${filter}`} aria-labelledby={`tab-${filter}`}>{filtered.map(item => {
          const id = Number(item.windowId ?? item.window_id);
          const name = item.displayName || item.accessibilityLabel || item.name || item.ownerName || item.owner_name || item.title || '菜单栏图标';
          const Icon = item.Icon || AppWindowIcon;
          const known = isKnownMenuBarSection(item.section);
          const disabled = !item.hideable || !known || (!preview && !canManage);
          return <label className="settings-menu-item" key={id}>
            <span className="settings-menu-icon">{item.displayName === 'FlowHub' ? <FlowHubLogo /> : <Icon aria-hidden="true" />}</span>
            <span className="settings-menu-copy">
              <strong>{name}</strong>
              <small>{menuBarSectionLabel(item.section)}{!item.hideable ? ' · 系统固定' : ''}</small>
            </span>
            <Switch label={`显示 ${name}`} checked={known && item.section !== 'alwaysHidden'} disabled={disabled} onChange={visible => {
              if (preview) setDemo(previous => previous.map(entry => entry.windowId === id ? { ...entry, section: visible ? 'visible' : 'alwaysHidden' } : entry));
              else void store.run(async () => { await write('setMenuBarItemHidden', id, !visible); await store.refreshMenu(); });
            }} />
          </label>;
        })}{filtered.length === 0 && <p className="settings-menu-empty" role="status">{empty}</p>}</div>
      </> : <p className="settings-menu-empty" role="status">{unavailable}</p>}
    </section>
    <section className="settings-menubar-card settings-menubar-controls" aria-labelledby="menu-controls-heading">
      <div className="settings-menubar-heading"><h2 id="menu-controls-heading">显示设置</h2><Help label="显示设置生效说明">修改后保存设置。</Help></div>
      <fieldset className="settings-fieldset" disabled={preview || locked}>
        <Toggle label="启用菜单栏隐藏分区" checked={draftOrganizer} disabled={!supported} onChange={value => change('organizerEnabled', value)} />
        <Toggle label="启动时收起隐藏分区" checked={config.collapseOnLaunch === true} disabled={!supported || !draftOrganizer} onChange={value => change('collapseOnLaunch', value)} />
      </fieldset>
      {!preview && supported && <div className="settings-menu-permission" data-setting-label="菜单栏权限" tabIndex={-1}>
        <div>
          <strong>辅助功能权限</strong>
          <small role="status">{trusted ? '已授权，可按住 ⌘ 拖动图标调整分区。' : '未授权'}</small>
        </div>
        {!trusted && <div data-setting-control><Button size="sm" disabled={locked} onClick={() => void store.run(async () => {
          await write('requestMenuBarManagementPermission');
          await store.refreshMenu();
        })}>授权辅助功能</Button></div>}
      </div>}
      <ViewDetails memoryKey="menubar:options" className="settings-menu-options">
        <summary>FlowHub 图标与菜单</summary>
        <fieldset className="settings-fieldset" disabled={preview || locked}>
          <Toggle label={flowHubMenuIconLabel} checked={iconVisible} onChange={value => change('enabled', value)} />
          <fieldset className="settings-fieldset settings-flowhub-menu-items" disabled={!iconVisible} aria-describedby={iconVisible ? undefined : 'flowhub-menu-icon-off'}>
            <legend>点开图标后显示</legend>
            {!iconVisible && <p className="fh-copy-note" id="flowhub-menu-icon-off">开启图标后可设置菜单项。</p>}
            <div className="settings-flowhub-menu-list">
              {flowHubMenuItems.map(([key, label]) => <Row key={key} label={label} note={key === 'showOpenLauncher' ? '唤出搜索启动器' : undefined}>
                <Switch label={`在图标菜单中显示「${label}」`} checked={config[key] === true} disabled={!iconVisible} onChange={value => change(key, value)} />
              </Row>)}
            </div>
          </fieldset>
        </fieldset>
      </ViewDetails>
    </section>
  </div>;
}
