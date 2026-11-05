import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Dialog } from '../shared/ui';
import { Help, Switch } from '../shared/controls';
import { Choice, Row, Shortcut, TextField, Toggle } from './fields';
import { host, readonly, write } from './api';
import { tools, clipboardLimit, hasExclusions } from './model';
import { SettingsStore, useSettings } from './store';
import { useCatalogDragMotion } from './useCatalogDragMotion';
import { MenuBar } from './MenuBar';
import { Layers2Icon } from 'lucide-react';
import { DataPanel, PathControl } from './DataPanel';
import { SettingsSection } from './SettingsSection';
export { DataPanel, PathControl } from './DataPanel';
const sectionLabels:Record<string,string>={general:'通用设置',data:'数据与诊断',updates:'版本与更新',search:'搜索',menubar:'菜单栏'};
const names: Record<string, string> = { all: '全部', app: '应用', web: '网页目录', clipboard: '剪贴板', memo: '备忘录', tools: '工具' };
export function Core({ store, section }: { store: SettingsStore; section: string }) {
  const s = useSettings(store), c = s.config!, core = c.core;
  const activeSection = section === 'network' || section === 'notifications' ? 'general' : section;
  const setCore = (key: string, value: unknown) => store.edit(c => { c.core[key] = value; });
  const setNested = (key: string, field: string, value: boolean) => store.edit(c => { c.core[key][field] = value; });
  const savedOrder = Array.isArray(core.searchResultOrder) ? core.searchResultOrder as string[] : [];
  const sortableSources = ['app', 'web', 'clipboard', 'memo', ...(s.plugins.some(plugin => plugin.id === 'twofa') || c.plugins.twofa ? ['twofa'] : [])];
  const defaultOrder = core.webBeforeClipboard === false ? ['app', 'clipboard', 'web', 'memo'] : ['app', 'web', 'clipboard', 'memo'];
  const order = [...new Set([...savedOrder, ...defaultOrder, ...sortableSources])].filter(id => sortableSources.includes(id));
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const displayOrder = readonly() ? previewOrder ?? order : order;
  const searchPlugins = [...displayOrder.flatMap(id => s.plugins.filter(plugin => plugin.id === id)), ...s.plugins.filter(plugin => !displayOrder.includes(plugin.id))];
  const [draggingSource, setDraggingSource] = useState('');
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const dropTargetRef = useRef<{ id: string; position: 'before' | 'after' } | null>(null);
  const stopPointerDrag = useRef<(() => void) | null>(null);
  const dragMotion = useCatalogDragMotion({ rowSelector: '.settings-search-item[data-source]', identityAttribute: 'data-source', previewClassName: 'fh-root settings-search-drag-preview', draggingClassName: 'settings-search-dragging' });
  const moveOrder = (id: string, index: number) => {
    if (s.busy || s.conflict || index < 0 || index >= displayOrder.length || !displayOrder.includes(id)) return;
    const next = displayOrder.filter(v => v !== id); next.splice(index, 0, id);
    if (readonly()) setPreviewOrder(next); else setCore('searchResultOrder', next);
  };
  const updateDropTarget = (next: { id: string; position: 'before' | 'after' } | null) => {
    const current = dropTargetRef.current;
    if (current?.id === next?.id && current?.position === next?.position) return;
    dropTargetRef.current = next; setDropTarget(next);
  };
  function beginSearchDrag(source: string, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || s.busy || s.conflict) return;
    const list = event.currentTarget.closest<HTMLElement>('.settings-search-list');
    const sourceRow = event.currentTarget.closest<HTMLElement>('.settings-search-item[data-source]');
    if (!list || !sourceRow) return;
    stopPointerDrag.current?.();
    const { pointerId, clientX, clientY } = event;
    let moved = false;
    const rowAt = (x: number, y: number) => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('.settings-search-item[data-source]');
      return row && list.contains(row) && row.dataset.source !== source && displayOrder.includes(row.dataset.source!) ? row : null;
    };
    const dropAt = (row: HTMLElement, y: number) => {
      const rect = row.getBoundingClientRect(), position = (y - rect.top) < rect.height / 2 ? 'before' : 'after';
      const id = row.dataset.source!;
      updateDropTarget({ id, position });
      return { id, position } as const;
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('keydown', onKey);
      dragMotion.end();
      if (stopPointerDrag.current === cleanup) stopPointerDrag.current = null;
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (!moved && Math.hypot(move.clientX - clientX, move.clientY - clientY) < 5) return;
      if (!moved) dragMotion.lift(sourceRow, list, [source], clientX, clientY);
      moved = true;
      dragMotion.move(move.clientX, move.clientY);
      move.preventDefault();
      const row = rowAt(move.clientX, move.clientY);
      if (row) dropAt(row, move.clientY);
      else updateDropTarget(null);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      if (moved) {
        const row = rowAt(up.clientX, up.clientY);
        if (row) {
          const { id, position } = dropAt(row, up.clientY), targetIndex = displayOrder.indexOf(id);
          let index = targetIndex + (position === 'after' ? 1 : 0);
          if (displayOrder.indexOf(source) < index) index--;
          dragMotion.captureDrop();
          moveOrder(source, index);
        }
      }
      cleanup(); setDraggingSource(''); updateDropTarget(null);
    };
    const onCancel = () => { cleanup(); setDraggingSource(''); updateDropTarget(null); };
    const onKey = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); onCancel(); } };
    setDraggingSource(source);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    window.addEventListener('keydown', onKey);
    stopPointerDrag.current = cleanup;
  }
  useEffect(() => { if (activeSection !== 'menubar' || readonly()) return; const refresh = () => void store.run(() => store.refreshMenu()); refresh(); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [activeSection, store]);
  const previewInspect = readonly() && ['general', 'search', 'menubar', 'data'].includes(activeSection);
  useEffect(() => () => stopPointerDrag.current?.(), []);
  useEffect(() => { stopPointerDrag.current?.(); setDraggingSource(''); updateDropTarget(null); }, [activeSection]);
  return <><fieldset disabled={s.busy || s.conflict || (readonly() && !previewInspect)} className="settings-fieldset"><section className="settings-core-panel" data-section={activeSection} id={`panel-${activeSection}`} aria-label={sectionLabels[activeSection]}>
    {activeSection === 'general' ? <div className="settings-core-general">
      <section className="settings-core-group" aria-labelledby="general-launch-heading"><h2 id="general-launch-heading" className="settings-core-group-title">启动与快捷键</h2><fieldset disabled={readonly()} className="settings-core-subgroup"><Shortcut label="唤出 FlowHub" value={core.hotkey || 'Alt+Space'} taken={Object.values(core.scopeShortcuts)} onChange={v => setCore('hotkey', v)} /><Toggle label="开机自动启动" checked={core.launchAtLogin === true} onChange={v => setCore('launchAtLogin', v)} help="登录 macOS 用户账户后自动启动 FlowHub，保存设置后生效。" /></fieldset></section>
      <section className="settings-core-group" aria-labelledby="general-network-heading"><h2 id="general-network-heading" className="settings-core-group-title">网络</h2><Choice label="代理检测适配器" value={c.plugins.tools.settings.proxyAdapter} options={[{ value: 'auto', label: '自动' }, { value: 'mihomo', label: 'Mihomo' }, { value: 'clash-rest', label: 'Clash REST' }, { value: 'system', label: '系统代理' }]} onChange={v => store.edit(c => { c.plugins.tools.settings.proxyAdapter = v; })} /></section>
      <section className="settings-core-group" aria-labelledby="general-notifications-heading"><h2 id="general-notifications-heading" className="settings-core-group-title">通知</h2><fieldset disabled={readonly()} className="settings-core-subgroup"><Toggle label="允许通知" checked={core.notifications.enabled} disabled={readonly()} onChange={v => setNested('notifications', 'enabled', v)} /><Toggle label="更新通知" checked={core.notifications.updates} disabled={readonly() || !core.notifications.enabled} onChange={v => setNested('notifications', 'updates', v)} /><Row label="系统通知权限" help="权限由 macOS 系统设置 → 通知管理。"><Button disabled={readonly() || !core.notifications.enabled} onClick={() => void store.run(async () => { await write('sendTestNotification'); store.notice('测试通知已发送'); })}>发送测试通知</Button></Row></fieldset></section>
    </div> : null}
    {activeSection === 'search' ? <>
      <Shortcut label="全部结果范围键" value={core.scopeShortcuts.all} allowBare disabled={readonly()} taken={[core.hotkey, ...Object.entries(core.scopeShortcuts).filter(([k]) => k !== 'all').map(([, v]) => String(v))]} onChange={v => store.edit(c => { c.core.scopeShortcuts.all = v; })} />
      <div className="settings-search-heading"><span>搜索来源与顺序</span><Help label="搜索来源排序说明">拖动把手，或聚焦把手后按 Alt + 上下方向键调整。浏览器预览的排序仅暂存于当前页面，刷新后复原；桌面 App 保存后生效。点击范围键可重新录入，按 Delete 可清空。顺序只影响有关键词时的「全部」结果；智能工具按命令匹配规则展示，不参与来源排序。</Help></div>
      <div className="settings-search-list" role="list" aria-label="搜索来源与顺序" data-setting-label="搜索来源与顺序" tabIndex={-1}>{searchPlugins.map(plugin => {
        const index = displayOrder.indexOf(plugin.id), sortable = index >= 0;
        const label = plugin.settingsName || plugin.name || names[plugin.id] || plugin.id;
        return <div role="listitem" className="settings-search-item" data-setting-label={`${names[plugin.id] || label}搜索来源`} tabIndex={-1} data-source={plugin.id} data-drop-position={dropTarget && dropTarget.id === plugin.id && draggingSource ? dropTarget.position : undefined} key={plugin.id}>
          <div className="settings-search-rank">{sortable ? <button type="button" className="settings-search-grip" draggable={false} aria-label={`调整${label}顺序`} title="拖动排序；Alt + 上下方向键调整" onPointerDown={e => beginSearchDrag(plugin.id, e)} onKeyDown={e => { if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); moveOrder(plugin.id, index + (e.key === 'ArrowUp' ? -1 : 1)); } }}><span aria-hidden="true">⠿</span></button> : null}</div>
          <div className="settings-search-name"><span>{label}</span>{plugin.available === false ? <small>{plugin.reason || (readonly() ? '浏览器预览不可用' : '当前环境不可用')}</small> : null}</div>
          <div className="settings-search-toggle"><Switch label={`启用${label}`} checked={c.plugins[plugin.id]?.enabled !== false} disabled={readonly() || plugin.available === false} onChange={v => store.edit(c => { c.plugins[plugin.id] ||= { settings: {} }; c.plugins[plugin.id].enabled = v; })} /></div>
          <div className="settings-search-shortcut">{plugin.id in core.scopeShortcuts ? <Shortcut inline label={`${names[plugin.id] || label}范围键`} value={core.scopeShortcuts[plugin.id]} allowBare disabled={readonly()} taken={[core.hotkey, ...Object.entries(core.scopeShortcuts).filter(([k]) => k !== plugin.id).map(([, v]) => String(v))]} onChange={v => store.edit(c => { c.core.scopeShortcuts[plugin.id] = v; })} /> : <span className="settings-search-none" aria-label="无范围快捷键">—</span>}</div>
        </div>;
      })}</div>
      <Toggle label="优先复用浏览器标签页" checked={core.reuseBrowserTabs === true} disabled={readonly()} onChange={v => setCore('reuseBrowserTabs', v)} help="默认浏览器为 Arc 时复用完整链接相同的普通标签页；未找到则新建。" />
      <Toggle label="长内容自动预览" checked={core.autoPreviewLongContent !== false} disabled={readonly()} onChange={v => setCore('autoPreviewLongContent', v)} help="默认开启。宽窗口中选中超过 80 个字符或至少 3 行的剪贴板文本、命令备忘时自动展开详情，并保留搜索框焦点。手动收起只影响当前记录；窄窗口仍手动进入详情。" />
    </> : null}
    {activeSection === 'menubar' ? <MenuBar store={store} /> : null}
    {activeSection === 'data' ? <DataPanel store={store} /> : null}
    {activeSection === 'updates' ? <Updates store={store} /> : null}
  </section></fieldset></>;
}
export async function primaryUpdate(store: SettingsStore) {
  if (store.dirty) throw new Error('请先保存或放弃修改，再安装更新');
  if (store.snapshot().busy) return;
  store.patch({ busy: true });
  try { const result = await write('downloadAndInstallUpdate'); if (result.state) store.patch({ update: result.state }); }
  finally { store.patch({ busy: false }); }
}
function Updates({ store }: { store: SettingsStore }) {
  const s = useSettings(store), core = s.config!.core, update = s.update;
  const statusNames: Record<string, string> = { unsupported: '当前环境不支持更新', idle: '尚未检查', checking: '正在检查', available: '发现新版本', downloaded: '等待安装', downloading: '正在下载', installing: '正在安装', 'not-available': '暂无可用更新', 'up-to-date': '已是最新版本', error: '更新失败' };
  return <div className="settings-updates">
    <section className="settings-core-group settings-update-summary" aria-label="版本状态" data-setting-label="版本状态" tabIndex={-1}>
      <div className="settings-update-identity"><span className="settings-update-icon"><Layers2Icon aria-hidden="true" /></span><div><h2>FlowHub</h2><span className="fh-muted">当前版本 {update.currentVersion || '预览版'}</span></div></div>
      <div className="settings-update-status"><p role="status">{statusNames[update.status] || '尚未检查'}{update.availableVersion ? ` · ${update.availableVersion}` : ''}</p><div className="flex flex-wrap gap-2"><Button disabled={readonly() || ['checking', 'downloading', 'installing'].includes(update.status)} onClick={() => void store.run(async () => { const result = await write('checkForUpdates'); if (result.state) store.patch({ update: result.state }); })}>检查更新</Button>{['available', 'downloaded'].includes(update.status) ? <Button className="primary" onClick={() => void store.run(() => primaryUpdate(store))}>{update.status === 'downloaded' ? '重启安装' : '下载并安装'}</Button> : null}</div></div>
      {update.error ? <p role="alert" className="settings-error">{update.error}</p> : null}{['downloading', 'installing'].includes(update.status) && typeof update.percent === 'number' ? <progress aria-label="更新进度" max={100} value={update.percent} /> : null}
    </section>
    <section className="settings-core-group" aria-labelledby="update-preferences"><h2 id="update-preferences" className="settings-core-group-title">自动更新</h2><Toggle label="自动检查正式版" checked={core.autoUpdateCheck !== false} onChange={v => store.edit(c => { c.core.autoUpdateCheck = v; })} help="每 10 分钟检查正式版。" /><Toggle label="自动下载并重启安装" checked={core.autoUpdateInstall === true} onChange={v => store.edit(c => { c.core.autoUpdateInstall = v; })} /></section>
  </div>;
}
const toolSections: {title:string;keys:(keyof typeof tools)[]}[] = [
  {title:'网络与连接',keys:['ping','curl','dns','dnsIpGeo','cloudflare','ip']},
  {title:'转换与解析',keys:['calculator','timestamp','jwt','json','url']},
  {title:'本机与进程',keys:['port','localIp','proxy']},
  {title:'历史与模板',keys:['commandHistory']},
];
export function Tools({ store }: { store: SettingsStore }) {
  const s=useSettings(store),[counts,setCounts]=useState(()=>host().FlowHubCommandStore?.counts()),[clearHistory,setClearHistory]=useState(false);
  return <><div className="settings-tool-sections grid gap-7">{toolSections.map(section=><SettingsSection key={section.title} title={section.title}>
    <div className="settings-tools-grid">{section.keys.map(key=><Toggle key={key} label={tools[key]} checked={s.config!.plugins.tools.settings[key]!==false} onChange={value=>store.edit(config=>{config.plugins.tools.settings[key]=value;})} />)}</div>
    {section.keys.includes('commandHistory')?<Row label="命令历史与参数模板" help="ping、curl、端口历史共用此开关；包含凭据的查询不会写入历史。"><p>{counts?`${counts.total} 条历史 · ${counts.templates} 个模板`:'暂无历史'}</p><Button onClick={()=>setClearHistory(true)}>清空历史与模板</Button></Row>:null}
  </SettingsSection>)}</div>{clearHistory?<Dialog title="清空命令历史与模板" busy={false} onClose={()=>setClearHistory(false)}><p>此操作不能撤销。历史和参数模板将同时清空。</p><Button onClick={()=>{if(readonly())return;host().FlowHubCommandStore?.clearAll();setCounts(host().FlowHubCommandStore?.counts());setClearHistory(false);}}>确认清空</Button></Dialog>:null}</>;
}
export function Clipboard({ store }: { store: SettingsStore }) {
  const s=useSettings(store),config=s.config!.plugins.clipboard.settings;
  return <div className="settings-section-stack flex flex-col gap-7">
    <SettingsSection title="采集与隐私">
      <Toggle label="暂停采集" checked={config.capturePaused===true} onChange={value=>store.edit(config=>{config.plugins.clipboard.settings.capturePaused=value;})} help="暂停保留历史搜索和粘贴，恢复不会补采暂停期间的内容；请保存成功后再复制敏感内容。" />
      <Toggle label="敏感标记保护" checked={config.protectSensitive!==false} onChange={value=>store.edit(config=>{config.plugins.clipboard.settings.protectSensitive=value;})} help="按 macOS 剪贴板类型标记跳过隐藏、临时和自动生成内容；未标记的密码仍可能被记录，历史不会自动脱敏。" />
      {hasExclusions(s.config)||hasExclusions(s.saved)?<Row label="旧来源应用排除列表" help="平台无法可靠识别来源应用；旧列表会保守阻止所有新采集。清空列表将连同其他草稿一起保存。"><Button onClick={()=>void store.run(async()=>{store.edit(config=>{config.plugins.clipboard.settings.excludedApps=[];config.plugins.clipboard.settings.excludedBundleIds=[];});await store.save();})}>清空旧列表并保存</Button></Row>:null}
    </SettingsSection>
    <SettingsSection title="历史保留">{(['retentionDays','maxRecords','maxBytes'] as const).map((key,index)=><TextField key={key} label={['留存天数','最多记录条数','逻辑内容容量（字节）'][index]} type="number" min={0} max={index===0?3650:undefined} value={config[key]??(index===0?30:0)} onChange={value=>store.edit(config=>{config.plugins.clipboard.settings[key]=clipboardLimit(value,key);})} help="0 表示不限制；保存后生效，超限按最近复制时间淘汰。逻辑容量不等于数据库物理大小。" />)}</SettingsSection>
    <SettingsSection title="存储位置"><PathControl store={store} storage /></SettingsSection>
  </div>;
}
