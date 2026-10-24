import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Dialog, Input, Tabs } from '../shared/ui';
import { Help, Switch } from '../shared/controls';
import { Choice, Row, Shortcut, TextField, Toggle } from './fields';
import { call, host, readonly, write } from './api';
import { diff, imported, tools, clipboardLimit, hasExclusions, type Bag } from './model';
import { SettingsStore, useSettings } from './store';
import { useCatalogDragMotion } from './useCatalogDragMotion';
import { MenuBar } from './MenuBar';
import { Layers2Icon } from 'lucide-react';
export const sections = [
  { id: 'general', label: '常规' },
  { id: 'data', label: '数据与诊断' },
  { id: 'updates', label: '更新' },
];
const names: Record<string, string> = { all: '全部', app: '应用', web: '网页目录', clipboard: '剪贴板', memo: '备忘录', tools: '工具' };
export function PathControl({ store, storage = false }: { store: SettingsStore; storage?: boolean }) {
  const s = useSettings(store), config = s.config!;
  const value = storage ? config.plugins.clipboard.settings.storagePath || '' : config.core.configPath || '';
  const info = storage ? s.storage : s.configPath;
  return <Row label={storage ? '数据库与剪贴板目录' : '配置文件位置'} help={storage ? '保存后：空目录接收当前全部数据；已有数据库则加载目标数据，不合并源网页草稿。恢复默认位置也遵循此规则。' : '保存后切换配置文件，原文件保留。'}><div className="grid gap-2"><Input aria-label="路径" title={value || info.defaultPath || info.resolvedPath || '默认位置'} value={value || info.defaultPath || info.resolvedPath || '默认位置'} readOnly /><div className="flex flex-wrap gap-2"><Button onClick={() => void store.run(async () => { const editing = store.snapshot().config; const result = await write(storage ? 'chooseClipboardStorage' : 'chooseConfigPath'); if (store.snapshot().config !== editing) throw new Error('配置已改变，请重新选择位置'); if (!result.canceled && result.path) store.edit(c => { if (storage) c.plugins.clipboard.settings.storagePath = result.path; else c.core.configPath = result.path; }); })}>选择…</Button><Button onClick={() => void store.run(async () => { if (value !== (info.configuredPath || '')) throw new Error('请先保存位置修改，再打开'); await write(storage ? 'openClipboardStorage' : 'openConfigPath'); })}>打开位置</Button><Button onClick={() => store.edit(c => { if (storage) c.plugins.clipboard.settings.storagePath = ''; else c.core.configPath = ''; })}>恢复默认</Button></div></div></Row>;
}
export function DataPanel({ store }: { store: SettingsStore }) {
  const s = useSettings(store), [scope, setScope] = useState('all'), [pending, setPending] = useState<Bag | null>(null), [mode, setMode] = useState('merge'), [preview, setPreview] = useState<Bag | null>(null), [restore, setRestore] = useState(''), [report, setReport] = useState(''), [clearSampling, setClearSampling] = useState(false);
  let changes: string[] = [], importError = '';
  if (pending) { try { changes = diff(s.config, imported(s.config!, pending, mode as 'merge' | 'replace')); } catch (e) { importError = String(e); } }
  return <div className="settings-data-panel">
    <div className="settings-group"><h2 className="settings-core-group-title">存储位置</h2><PathControl store={store} /></div>
    <div className="settings-group"><h2 className="settings-core-group-title">备份与恢复</h2><Row label="配置历史" help="每次保存前自动备份上一版；恢复前会再次备份。系统集成类改动可能需要重启。"><Button onClick={() => void store.refreshHistory()}>刷新历史</Button></Row>
    {s.history.error ? <p role="alert">{s.history.error}</p> : null}
    {!s.history.entries?.length ? <p>{s.history.available === false ? '浏览器预览不提供配置历史' : '暂无历史版本'}</p> : (s.history.entries as Bag[]).map(entry => <div className="settings-row flex flex-wrap items-center justify-between gap-2" key={entry.id}><span>{new Date(entry.created_at).toLocaleString()} · {entry.catalog_count || 0} 项 · {entry.bytes} B</span><div className="flex gap-2"><Button onClick={() => void store.run(async () => { setPreview(await call('previewConfigHistory', entry.id)); })}>预览</Button><Button onClick={() => setRestore(entry.id)}>恢复</Button></div></div>)}
    </div>
    {preview ? <Dialog title="历史预览" busy={false} onClose={() => setPreview(null)}><pre className="settings-code">{JSON.stringify(preview.config, null, 2)}</pre></Dialog> : null}
    {restore ? <Dialog title="恢复配置历史" notice={s.error ? s.notice : undefined} busy={s.busy} onClose={() => setRestore('')}><p>将替换当前配置并放弃编辑器中的未保存修改。当前已保存配置会先备份；系统集成可能需要重启。</p><Button disabled={s.busy} onClick={() => void store.run(async () => { await store.restoreHistory(restore); setRestore(''); })}>确认恢复</Button></Dialog> : null}
    <div className="settings-group"><h2 className="settings-core-group-title">导入与导出</h2><Choice label="导出范围" value={scope} options={[{ value: 'all', label: '全部配置' }, { value: 'core', label: '全局设置' }, ...Object.keys(s.config!.plugins).sort().map(value => ({ value, label: names[value] || value }))]} onChange={setScope} />
    <div className="flex flex-wrap gap-2"><Button onClick={() => void store.run(async () => { const result = await write('exportConfig', scope); store.notice(result.canceled ? '已取消导出' : `已导出到 ${result.path}`); })}>导出配置…</Button><Button onClick={() => void store.run(async () => { const result = await write('pickConfigImport'); if (!result.canceled) { setPending(result); setMode('merge'); } })}>导入配置…</Button></div>
    </div>
    {pending ? <Dialog title="核对导入差异" busy={false} onClose={() => setPending(null)}><p>{pending.path} · 范围 {pending.scope || 'all'}</p>{pending.appVersion && pending.currentAppVersion !== pending.appVersion ? <p role="status">导出版本 {pending.appVersion} 与当前版本不同，请核对字段。</p> : null}<Choice label="导入方式" value={mode} options={[{ value: 'merge', label: '递归合并（数组替换）' }, { value: 'replace', label: '替换所选范围' }]} onChange={setMode} /><pre className="settings-code">{importError || changes.join('\n') || '没有变化'}</pre><Button disabled={Boolean(importError)} onClick={() => void store.run(async () => { store.replace(imported(s.config!, pending, mode as 'merge' | 'replace')); setPending(null); })}>应用为草稿</Button></Dialog> : null}
    <div className="settings-group"><h2 className="settings-core-group-title">本地诊断</h2><Toggle label="性能采样" checked={s.diagnostics.enabled === true} onChange={enabled => void store.run(async () => { const result = await write('setDiagnosticsEnabled', enabled); store.patch({ diagnostics: { ...s.diagnostics, ...result, enabled } }); host().flowhubPerformance?.enable(enabled); })} help="记录本机 FlowHub 与 WebKit 资源使用，不上传网络。" />
    <p className="break-all">{s.diagnostics.path || '仅桌面 App 可用'}</p><div className="flex flex-wrap gap-2"><Button onClick={() => void store.run(async () => { const result = await write('sampleDiagnostics'); store.notice(result.reason || '已记录性能采样'); })}>采样一次</Button><Button onClick={() => setClearSampling(true)}>清理采样</Button><Button onClick={() => setReport(JSON.stringify(host().flowhubPerformance?.report(), null, 2))}>界面测量</Button><Button onClick={() => { host().flowhubPerformance?.reset(); setReport(''); }}>重置测量</Button></div>{report ? <pre className="settings-code">{report}</pre> : null}{clearSampling ? <Dialog title="清理性能采样" busy={s.busy} onClose={() => setClearSampling(false)}><p>只清理本机性能记录，不影响网页、剪贴板或备忘录数据。</p><Button onClick={() => void store.run(async () => { await write('clearDiagnostics'); setClearSampling(false); store.notice('性能数据已清理'); })}>确认清理</Button></Dialog> : null}
    </div>
  </div>;
}
export function Core({ store, section, onSection, navigation = true }: { store: SettingsStore; section: string; onSection: (id: string) => void; navigation?: boolean }) {
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
  const previewInspect = readonly() && ['general', 'search', 'menubar'].includes(activeSection);
  useEffect(() => () => stopPointerDrag.current?.(), []);
  useEffect(() => { stopPointerDrag.current?.(); setDraggingSource(''); updateDropTarget(null); }, [activeSection]);
  return <>{navigation ? <div className="settings-core-toolbar"><Tabs label="通用设置分类" items={sections} value={activeSection} onChange={onSection} /></div> : null}<fieldset disabled={s.busy || s.conflict || (readonly() && !previewInspect)} className="settings-fieldset"><section role="tabpanel" className="settings-core-panel" data-section={activeSection} id={`panel-${activeSection}`} aria-labelledby={navigation ? `tab-${activeSection}` : undefined} aria-label={navigation ? undefined : activeSection === 'search' ? '搜索' : activeSection === 'menubar' ? '菜单栏' : sections.find(item => item.id === activeSection)?.label}>
    {activeSection === 'general' ? <div className="settings-core-general">
      <section className="settings-core-group" aria-labelledby="general-launch-heading"><h2 id="general-launch-heading" className="settings-core-group-title">启动与快捷键</h2><fieldset disabled={readonly()} className="settings-core-subgroup"><Shortcut label="唤出 FlowHub" value={core.hotkey || 'Alt+Space'} taken={Object.values(core.scopeShortcuts)} onChange={v => setCore('hotkey', v)} /><Toggle label="开机自动启动" checked={core.launchAtLogin === true} onChange={v => setCore('launchAtLogin', v)} help="登录 macOS 用户账户后自动启动 FlowHub，保存设置后生效。" /></fieldset></section>
      <section className="settings-core-group" aria-labelledby="general-network-heading"><h2 id="general-network-heading" className="settings-core-group-title">网络</h2><Choice label="代理检测适配器" value={c.plugins.tools.settings.proxyAdapter} options={[{ value: 'auto', label: '自动' }, { value: 'mihomo', label: 'Mihomo' }, { value: 'clash-rest', label: 'Clash REST' }, { value: 'system', label: '系统代理' }]} onChange={v => store.edit(c => { c.plugins.tools.settings.proxyAdapter = v; })} /></section>
      <section className="settings-core-group" aria-labelledby="general-notifications-heading"><h2 id="general-notifications-heading" className="settings-core-group-title">通知</h2><fieldset disabled={readonly()} className="settings-core-subgroup"><Toggle label="允许通知" checked={core.notifications.enabled} disabled={readonly()} onChange={v => setNested('notifications', 'enabled', v)} /><Toggle label="更新通知" checked={core.notifications.updates} disabled={readonly() || !core.notifications.enabled} onChange={v => setNested('notifications', 'updates', v)} /><Row label="系统通知权限" help="权限由 macOS 系统设置 → 通知管理。"><Button disabled={readonly() || !core.notifications.enabled} onClick={() => void store.run(async () => { await write('sendTestNotification'); store.notice('测试通知已发送'); })}>发送测试通知</Button></Row></fieldset></section>
    </div> : null}
    {activeSection === 'search' ? <>
      <Shortcut label="全部结果范围键" value={core.scopeShortcuts.all} allowBare disabled={readonly()} taken={[core.hotkey, ...Object.entries(core.scopeShortcuts).filter(([k]) => k !== 'all').map(([, v]) => String(v))]} onChange={v => store.edit(c => { c.core.scopeShortcuts.all = v; })} />
      <div className="settings-search-heading"><span>搜索来源与顺序</span><Help label="搜索来源排序说明">拖动把手，或聚焦把手后按 Alt + 上下方向键调整。浏览器预览的排序仅暂存于当前页面，刷新后复原；桌面 App 保存后生效。点击范围键可重新录入，按 Delete 可清空。顺序只影响有关键词时的「全部」结果；智能工具按命令匹配规则展示，不参与来源排序。</Help></div>
      <div className="settings-search-list" role="list" aria-label="搜索来源与顺序">{searchPlugins.map(plugin => {
        const index = displayOrder.indexOf(plugin.id), sortable = index >= 0;
        const label = plugin.settingsName || plugin.name || names[plugin.id] || plugin.id;
        return <div role="listitem" className="settings-search-item" data-source={plugin.id} data-drop-position={dropTarget && dropTarget.id === plugin.id && draggingSource ? dropTarget.position : undefined} key={plugin.id}>
          <div className="settings-search-rank">{sortable ? <button type="button" className="settings-search-grip" draggable={false} aria-label={`调整${label}顺序`} title="拖动排序；Alt + 上下方向键调整" onPointerDown={e => beginSearchDrag(plugin.id, e)} onKeyDown={e => { if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); moveOrder(plugin.id, index + (e.key === 'ArrowUp' ? -1 : 1)); } }}><span aria-hidden="true">⠿</span></button> : null}</div>
          <div className="settings-search-name"><span>{label}</span>{plugin.available === false ? <small>{plugin.reason || (readonly() ? '浏览器预览不可用' : '当前环境不可用')}</small> : null}</div>
          <div className="settings-search-toggle"><Switch label={`启用${label}`} checked={c.plugins[plugin.id]?.enabled !== false} disabled={readonly() || plugin.available === false} onChange={v => store.edit(c => { c.plugins[plugin.id] ||= { settings: {} }; c.plugins[plugin.id].enabled = v; })} /></div>
          <div className="settings-search-shortcut">{plugin.id in core.scopeShortcuts ? <Shortcut inline label={`${names[plugin.id] || label}范围键`} value={core.scopeShortcuts[plugin.id]} allowBare disabled={readonly()} taken={[core.hotkey, ...Object.entries(core.scopeShortcuts).filter(([k]) => k !== plugin.id).map(([, v]) => String(v))]} onChange={v => store.edit(c => { c.core.scopeShortcuts[plugin.id] = v; })} /> : <span className="settings-search-none" aria-label="无范围快捷键">—</span>}</div>
        </div>;
      })}</div>
      <Toggle label="优先复用浏览器标签页" checked={core.reuseBrowserTabs === true} disabled={readonly()} onChange={v => setCore('reuseBrowserTabs', v)} help="默认浏览器为 Arc 时复用完整链接相同的普通标签页；未找到则新建。" />
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
    <section className="settings-core-group settings-update-summary" aria-label="版本状态">
      <div className="settings-update-identity"><span className="settings-update-icon"><Layers2Icon aria-hidden="true" /></span><div><h2>FlowHub</h2><span className="fh-muted">当前版本 {update.currentVersion || '预览版'}</span></div></div>
      <div className="settings-update-status"><p role="status">{statusNames[update.status] || '尚未检查'}{update.availableVersion ? ` · ${update.availableVersion}` : ''}</p><div className="flex flex-wrap gap-2"><Button disabled={readonly() || ['checking', 'downloading', 'installing'].includes(update.status)} onClick={() => void store.run(async () => { const result = await write('checkForUpdates'); if (result.state) store.patch({ update: result.state }); })}>检查更新</Button>{['available', 'downloaded'].includes(update.status) ? <Button className="primary" onClick={() => void store.run(() => primaryUpdate(store))}>{update.status === 'downloaded' ? '重启安装' : '下载并安装'}</Button> : null}</div></div>
      {update.error ? <p role="alert" className="settings-error">{update.error}</p> : null}{['downloading', 'installing'].includes(update.status) && typeof update.percent === 'number' ? <progress aria-label="更新进度" max={100} value={update.percent} /> : null}
    </section>
    <section className="settings-core-group" aria-labelledby="update-preferences"><h2 id="update-preferences" className="settings-core-group-title">自动更新</h2><Toggle label="自动检查正式版" checked={core.autoUpdateCheck !== false} onChange={v => store.edit(c => { c.core.autoUpdateCheck = v; })} help="每 10 分钟检查正式版。" /><Toggle label="自动下载并重启安装" checked={core.autoUpdateInstall === true} onChange={v => store.edit(c => { c.core.autoUpdateInstall = v; })} /></section>
  </div>;
}
export function Tools({ store }: { store: SettingsStore }) { const s = useSettings(store), [counts, setCounts] = useState(() => host().FlowHubCommandStore?.counts()), [clearHistory, setClearHistory] = useState(false); return <><div className="settings-tools-grid">{Object.entries(tools).map(([key, label]) => <Toggle key={key} label={label} checked={s.config!.plugins.tools.settings[key] !== false} onChange={v => store.edit(c => { c.plugins.tools.settings[key] = v; })} />)}</div><Row label="命令历史与参数模板" help="ping、curl、端口历史共用此开关；包含凭据的查询不会写入历史。"><p>{counts ? `${counts.total} 条历史 · ${counts.templates} 个模板` : '暂无历史'}</p><Button onClick={() => setClearHistory(true)}>清空历史与模板</Button></Row>{clearHistory ? <Dialog title="清空命令历史与模板" busy={false} onClose={() => setClearHistory(false)}><p>此操作不能撤销。历史和参数模板将同时清空。</p><Button onClick={() => { if (readonly()) return; host().FlowHubCommandStore?.clearAll(); setCounts(host().FlowHubCommandStore?.counts()); setClearHistory(false); }}>确认清空</Button></Dialog> : null}</>; }
export function Clipboard({ store }: { store: SettingsStore }) { const s = useSettings(store), config = s.config!.plugins.clipboard.settings; return <><Toggle label="暂停采集" checked={config.capturePaused === true} onChange={v => store.edit(c => { c.plugins.clipboard.settings.capturePaused = v; })} help="暂停保留历史搜索和粘贴，恢复不会补采暂停期间的内容；请保存成功后再复制敏感内容。" /><Toggle label="敏感标记保护" checked={config.protectSensitive !== false} onChange={v => store.edit(c => { c.plugins.clipboard.settings.protectSensitive = v; })} help="按 macOS 剪贴板类型标记跳过隐藏、临时和自动生成内容；未标记的密码仍可能被记录，历史不会自动脱敏。" />{['retentionDays', 'maxRecords', 'maxBytes'].map((key, i) => <TextField key={key} label={['留存天数', '最多记录条数', '逻辑内容容量（字节）'][i]} type="number" min={0} max={i === 0 ? 3650 : undefined} value={config[key] ?? (i === 0 ? 30 : 0)} onChange={v => store.edit(c => { c.plugins.clipboard.settings[key] = clipboardLimit(v, key); })} help="0 表示不限制；保存后生效，超限按最近复制时间淘汰。逻辑容量不等于数据库物理大小。" />)}{hasExclusions(s.config) || hasExclusions(s.saved) ? <Row label="旧来源应用排除列表" help="平台无法可靠识别来源应用；旧列表会保守阻止所有新采集。清空列表将连同其他草稿一起保存。"><Button onClick={() => void store.run(async () => { store.edit(c => { c.plugins.clipboard.settings.excludedApps = []; c.plugins.clipboard.settings.excludedBundleIds = []; }); await store.save(); })}>清空旧列表并保存</Button></Row> : null}<PathControl store={store} storage /></>; }
