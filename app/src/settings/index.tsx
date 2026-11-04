import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeftIcon, ArrowRightIcon, EllipsisIcon, Layers2Icon, PuzzleIcon } from 'lucide-react';
import { Button, Dialog } from '../shared/ui';
import { Textarea } from '../components/ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { EmptyState, Help, Select, Tooltip } from '../shared/controls';
import { Badge } from '../components/ui/badge';
import { useMediaQuery } from '../shared/useMediaQuery';
import { Core, Clipboard, Tools } from './Core';
import { CanvasSettings } from './CanvasSettings';
import { WebCatalog, Memos } from './Collections';
import { Applications } from './Applications';
import { call, host, readonly, type InstalledPlugin } from './api';
import { SettingsStore, useSettings } from './store';
import { signature } from './model';
import './settings.css';
import './glass.css';
import './layout.css';
import { PluginDock, PluginFrame } from '../plugin-workspace/controls';
import { workspaceCall } from '../plugin-workspace/native';
import { Theme } from './Theme';
import { bindNativeSettings } from './native';
import { bindSettingsClose } from './close';
import { observePopupOwner } from '../../../../common-components/packages/frontend/dom/popup';
import { Navigation } from './SettingsNavigation';
import { corePage, isPage, navigationItems, type PageId } from './navigation';
import { ViewStateContext, type ViewMemory } from './view-state';
const emptyPlugins: InstalledPlugin[] = [];
export function Settings({ store }: { store: SettingsStore }) {
  const s = useSettings(store), [journey,setJourney]=useState<{pages:PageId[];index:number}>(()=>{const params=new URLSearchParams(window.location.search),requested=params.get('module') || '';return {pages:[params.get('update')==='1'?'updates':isPage(requested)?requested:'core'],index:0};}), [json, setJson] = useState(false), [reset, setReset] = useState(false), [close, setClose] = useState(false);
  const module=journey.pages[journey.index], narrow=useMediaQuery('(max-width: 699px)');
  const journeyRef=useRef(journey), main=useRef<HTMLElement>(null);
  const sourceKey=JSON.stringify([s.configPath.resolvedPath || '',s.storage.resolvedPath || '']);
  const viewMemory=useMemo<ViewMemory>(()=>new Map(),[sourceKey]);
  const positions=useMemo(()=>new Map<PageId,number>(),[sourceKey]);
  const navigationRef=useRef<(id:string)=>boolean>(()=>false), sectionRef=useRef<(id:string)=>boolean>(()=>false);
  const integration = host().FlowHubPluginIntegration;
  const jsonBefore = useRef<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false), [pluginModule, setPluginModule] = useState('extensions');
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const menuActions = useRef<{ unmount(): void; close(): void } | null>(null);
  useLayoutEffect(() => { if (!menuOpen) menuActions.current?.unmount(); }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    if (s.busy) { setMenuOpen(false); return; }
    return menuTrigger.current ? observePopupOwner(menuTrigger.current, () => setMenuOpen(false)) : undefined;
  }, [menuOpen, s.busy]);
  const installed = useSyncExternalStore(integration?.subscribe || (() => () => {}), integration?.getSnapshot || (() => emptyPlugins), () => emptyPlugins);
  useEffect(() => {
    const unbindClose = bindSettingsClose(store, () => setClose(true));
    const unbind = bindNativeSettings(store, id => navigationRef.current(id), id=>sectionRef.current(id));
    void store.run(() => store.load());
    const beforeUnload = (event: BeforeUnloadEvent) => { store.persist(); if (store.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('pagehide', store.persist);
    return () => { unbindClose(); unbind(); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', store.persist); };
  }, [store]);
  useEffect(() => { if (pluginModule.startsWith('plugin:') && !installed.some(p => p.enabled && `plugin:${p.manifest.id}` === pluginModule)) setPluginModule('extensions'); }, [installed, pluginModule]);
  function finishJson() {
    if (store.snapshot().busy) return false;
    try { store.applyJson(); setJson(false); return true; } catch (e) { store.notice(String(e), true); return false; }
  }
  function openJson() { jsonBefore.current = store.snapshot().jsonText; setJson(true); }
  function cancelJson() { if (!store.snapshot().busy) { store.restoreJson(jsonBefore.current); setJson(false); } }
  function navigate(id: string) {
    if(!isPage(id) && id!=='extensions' && !id.startsWith('plugin:'))return false;
    if (store.snapshot().busy || !finishJson()) return false;
    if (id === 'extensions' || id.startsWith('plugin:')) { if (!readonly()) { void workspaceCall('select', id).catch(e => store.notice(String(e), true)); } else { setPluginModule(id); setPluginsOpen(true); } }
    else if(isPage(id)) {
      const current=journeyRef.current;
      if(current.pages[current.index]!==id){
        if(main.current)positions.set(current.pages[current.index],main.current.scrollTop);
        const pages=[...current.pages.slice(0,current.index+1),id].slice(-40),next={pages,index:pages.length-1};journeyRef.current=next;setJourney(next);
      }
      setPluginsOpen(false);
    }return true;
  }
  function travel(delta:number) {
    const current=journeyRef.current,index=current.index+delta;
    if(index<0 || index>=current.pages.length || store.snapshot().busy || !finishJson())return;
    if(main.current)positions.set(current.pages[current.index],main.current.scrollTop);
    const next={...current,index};journeyRef.current=next;setJourney(next);setPluginsOpen(false);
  }
  navigationRef.current=navigate;sectionRef.current=id=>navigate(corePage(id));
  useLayoutEffect(()=>{if(main.current)main.current.scrollTop=positions.get(module) || 0;},[module,positions,s.config!==null]);
  const page=navigationItems.find(item=>item.id===module)!;
  const pluginTitle = pluginModule === 'extensions' ? '插件市场' : installed.find(plugin => `plugin:${plugin.manifest.id}` === pluginModule)?.manifest.name || '插件';
  return <ViewStateContext.Provider value={viewMemory}><div className={`settings-stage${readonly() ? '' : ' settings-detached-workspace'}`}><div className="settings-landscape" aria-hidden="true" /><div className="fh-root settings-shell flex flex-col" aria-busy={s.busy}>
    <a className="settings-skip-link" href="#settings-content" onClick={event=>{event.preventDefault();main.current?.focus({preventScroll:true});}}>跳到页面内容</a>
    <header data-tauri-drag-region="deep" className="settings-topbar flex items-center justify-between gap-3"><div className="settings-page-navigation flex items-center gap-3"><div className="settings-history flex items-center gap-1"><Tooltip content="返回上一页"><Button size="icon-sm" variant="ghost" aria-label="返回上一页" disabled={s.busy || journey.index===0} onClick={()=>travel(-1)}><ArrowLeftIcon/></Button></Tooltip><Tooltip content="前进下一页"><Button size="icon-sm" variant="ghost" aria-label="前进下一页" disabled={s.busy || journey.index===journey.pages.length-1} onClick={()=>travel(1)}><ArrowRightIcon/></Button></Tooltip></div><div className="settings-page-heading"><span>{page.group}</span><h1 id="settings-page-title">{page.label}</h1></div></div><div className="settings-global-actions flex items-center gap-2">{!readonly() ? <Button aria-label="显示独立插件栏" disabled={s.busy} onClick={() => void workspaceCall('show').catch(e => store.notice(String(e), true))}><PuzzleIcon aria-hidden="true" /><span className="settings-action-label">插件栏</span></Button> : null}<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} actionsRef={menuActions}><DropdownMenuTrigger ref={menuTrigger} render={<Button aria-label="更多设置操作" disabled={s.busy || !s.config} />}><EllipsisIcon data-icon="inline-start" /><span className="settings-action-label">更多</span></DropdownMenuTrigger><DropdownMenuContent align="end" className="settings-global-menu"><DropdownMenuGroup><DropdownMenuItem onClick={openJson}>{readonly() ? '查看完整配置 JSON' : '编辑完整配置 JSON'}</DropdownMenuItem><DropdownMenuItem onClick={() => navigate('updates')}>版本与更新</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>{readonly() ? <Button onClick={() => host().requestSettingsClose?.()} disabled={s.busy}>关闭</Button> : null}</div></header>
    {narrow?<div className="settings-mobile-navigation"><Select label="切换页面" value={module} options={[...navigationItems.map(item=>({value:item.id,label:item.label})),{value:'extensions',label:'插件市场（独立工作区）'}]} onChange={navigate} disabled={s.busy}/></div>:null}
    <div className={`settings-workspace grid${narrow?' settings-workspace-narrow':''}`}>
      {!narrow?<Navigation page={module} busy={s.busy} preview={readonly()} onNavigate={navigate}/>:null}
      <main ref={main} id="settings-content" aria-labelledby="settings-page-title" tabIndex={-1} className="settings-main min-w-0" onScroll={()=>{if(main.current)positions.set(journeyRef.current.pages[journeyRef.current.index],main.current.scrollTop);}}><div key={`${sourceKey}:${module}`} className={`settings-page${module==='web' || module==='memo'?' settings-page-wide':''}`}>
        {!s.config ? <EmptyState error={!s.busy}>{s.busy ? '正在读取配置…' : '配置未能加载'}<Button disabled={s.busy} onClick={() => void store.run(() => store.load())}>重试</Button></EmptyState> : <>
          {module === 'canvas' ? <CanvasSettings /> : module === 'appearance' ? <div className="settings-appearance"><div className="settings-material-sample"><Layers2Icon aria-hidden="true" /><strong>轻雾玻璃</strong><span>鼠尾草绿 · 暖沙色</span></div><div className="settings-appearance-choice"><span>外观主题</span><Theme /></div><p className="fh-muted">{readonly() ? '浏览器使用玻璃效果演示背景；Mac 版叠加原生窗口材质。' : '原生窗口材质随桌面光色变化，并尊重系统的降低透明度设置。'}</p></div> : <>
            {['core', 'data', 'updates', 'search', 'menubar'].includes(module) ? <Core store={store} section={module === 'core' ? 'general' : module} /> : <fieldset disabled={s.busy || s.conflict || (readonly() && module !== 'web' && module !== 'memo')} className="settings-fieldset">{module === 'web' ? <WebCatalog store={store} /> : module === 'memo' ? <Memos store={store} /> : module === 'clipboard' ? <Clipboard store={store} /> : module === 'tools' ? <Tools store={store} /> : <Applications store={store} />}</fieldset>}
          </>}
        </>}
      </div></main></div>
    {readonly() && pluginsOpen ? <Dialog title={pluginTitle} busy={s.busy} modal={false} onClose={() => setPluginsOpen(false)} className="settings-plugin-drawer"><div className="settings-drawer-handle" aria-hidden="true" /><PluginFrame module={pluginModule} /><p className="settings-plugin-caption">{readonly() ? '浏览器预览 · 插件安装与管理请在桌面 App 中操作' : '本地插件工作区'}</p></Dialog> : null}
    <footer className="settings-footer flex flex-wrap items-center justify-between gap-3"><div className="settings-save-status">{store.dirty && !readonly()?<Badge variant="secondary">未保存</Badge>:null}<p role={s.error ? 'alert' : 'status'} className={s.error ? 'settings-error' : ''}>{s.notice || (readonly() ? '浏览器预览 · 不会保存配置' : store.dirty ? '有未保存修改' : '已保存')}</p><Help label="草稿与保存">切换页面会保留未保存的配置草稿；保存后生效。未保存的修改也会保留为本地草稿，可在下次打开时恢复。</Help></div><div className="settings-footer-actions flex flex-wrap gap-2"><Button disabled={readonly() || s.busy || !s.undo.length || s.conflict} onClick={() => store.travel('undo')}>撤销</Button><Button disabled={readonly() || s.busy || !s.redo.length || s.conflict} onClick={() => store.travel('redo')}>重做</Button><Button disabled={s.busy || !store.dirty} onClick={() => setReset(true)}>重置未保存</Button><Button className="primary settings-save-button" disabled={readonly() || s.busy || !store.dirty || s.conflict} onClick={() => void store.run(() => store.save())}>{s.busy ? '处理中…' : '保存'}</Button></div></footer>
    {json && s.config ? <Dialog title={readonly() ? '查看完整配置 JSON' : '编辑完整配置 JSON'} busy={s.busy} onClose={cancelJson} notice={s.error ? s.notice : undefined} className="settings-json-dialog"><p className="fh-muted">{readonly() ? '此处查看 FlowHub 完整配置。' : '此处编辑 FlowHub 完整配置；完成后进入草稿，保存后生效。'}</p><Textarea aria-label="完整配置 JSON" className="settings-code" rows={18} spellCheck={false} readOnly={readonly() || s.busy || s.conflict} value={s.jsonText ?? JSON.stringify(s.config, null, 2)} onChange={e => store.setJson(e.target.value)} /><div className="settings-dialog-actions">{!readonly() ? <Button disabled={s.busy} onClick={cancelJson}>取消编辑</Button> : null}<Button disabled={s.busy} onClick={() => { finishJson(); }}>{readonly() ? '完成' : '完成编辑'}</Button></div></Dialog> : null}
    {reset ? <Dialog title="重置未保存修改" busy={s.busy} onClose={() => setReset(false)}><p>{s.conflict ? '保留源草稿并加载当前目标配置？' : '放弃当前编辑，重新加载已保存配置？'}</p><Button onClick={() => void store.run(async () => { await store.reset(); setReset(false); })}>确认重置</Button></Dialog> : null}
    {close ? <Dialog title="关闭设置" busy={s.busy} onClose={() => setClose(false)} notice={s.error ? s.notice : undefined}><p>尚有未保存修改，关闭前请选择如何处理。</p><div className="settings-dialog-actions"><Button disabled={s.busy} onClick={() => setClose(false)}>取消</Button><Button disabled={s.busy} onClick={() => void store.run(async () => { store.persist(); await call('closeSettings'); })}>保留草稿并关闭</Button><Button className="primary" disabled={s.busy || s.conflict} onClick={() => void store.run(async () => { await store.save(); if (!store.dirty) await call('closeSettings'); })}>保存并关闭</Button></div></Dialog> : null}
    {s.recovery ? <Dialog title="发现本地草稿" busy={false} onClose={() => store.patch({ recovery: null })}><p>{new Date(s.recovery.savedAt).toLocaleString()} 保存的草稿。{s.recovery.baseSignature !== signature(s.saved) ? '磁盘配置已发生变化，请核对后恢复。' : ''}</p><pre className="settings-code">{s.recovery.jsonDirty ? s.recovery.jsonText : JSON.stringify(s.recovery.config, null, 2)}</pre><Button disabled={!s.recovery.origin} onClick={() => void store.run(async () => store.recoverDraft())}>恢复同源草稿</Button><Button onClick={() => store.patch({ recovery: null })}>暂不恢复</Button></Dialog> : null}
  </div>{readonly() ? <PluginDock installed={installed} busy={s.busy} open={pluginsOpen} active={pluginModule} onSelect={id => { if (pluginsOpen && pluginModule === id) setPluginsOpen(false); else navigate(id); }} /> : null}</div></ViewStateContext.Provider>;
}
export function mountSettings(element: HTMLElement) { const store = new SettingsStore(), root = createRoot(element); root.render(<Settings store={store} />); return () => { store.dispose(); root.unmount(); }; }
