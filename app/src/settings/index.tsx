import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeftIcon, ArrowRightIcon, EllipsisIcon, PuzzleIcon, SearchIcon } from 'lucide-react';
import { Button, Dialog } from '../shared/ui';
import { Textarea } from '../components/ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { EmptyState, Select, Tooltip } from '../shared/controls';
import { DraftReview } from './DraftReview';
import { SettingsSearch } from './SettingsSearch';
import { SettingsFooter } from './SettingsFooter';
import { useSettingLocation } from './useSettingLocation';
import { shortcutKeys } from '../shared/shortcuts';
import { useMediaQuery } from '../shared/useMediaQuery';
import { Core, Clipboard } from './Core';
import { Tools } from './Tools';
import { CanvasSettings } from './CanvasSettings';
import { WebCatalog, Memos } from './Collections';
import { Applications } from './Applications';
import { call, host, readonly, type InstalledPlugin } from './api';
import { SettingsStore, useSettings } from './store';
import { signature } from './model';
import './settings.css';
import './glass.css';
import './layout.css';
import './compact-workspace.css';
import { Market } from '../market/Market';
import { workspaceCall } from '../plugin-workspace/native';
import { bindNativeSettings } from './native';
import { bindSettingsClose } from './close';
import { observePopupOwner } from '../../../../common-components/packages/frontend/dom/popup';
import { Navigation } from './SettingsNavigation';
import { corePage, navigationItems, settingsLocation, type PageId } from './navigation';
import { ViewStateContext, type ViewMemory } from './view-state';
const emptyPlugins: InstalledPlugin[] = [];
const pageChoices=navigationItems.map(({id,label,group})=>({value:id,label,group}));
export function Settings({ store }: { store: SettingsStore }) {
  const s = useSettings(store), [journey,setJourney]=useState<{pages:PageId[];index:number}>(()=>{const params=new URLSearchParams(window.location.search);return {pages:[params.get('update')==='1'?'updates':settingsLocation(params.get('module') || '') ?? 'core'],index:0};}), [json, setJson] = useState(false), [reset, setReset] = useState(false), [close, setClose] = useState(false), [review,setReview] = useState(false), [searchOpen,setSearchOpen] = useState(false);
  const module=journey.pages[journey.index], narrow=useMediaQuery('(max-width: 699px)');
  const marketView = module === 'plugins-discover' ? 'discover' : module === 'plugins-installed' ? 'installed' : null;
  const journeyRef=useRef(journey), main=useRef<HTMLElement>(null);
  const navigationFocus=useRef<'lookup'|'page'|null>(null), transferringNavigation=useRef(false);
  useLayoutEffect(()=>{
    if(!navigationFocus.current || document.activeElement!==document.body)return;
    const selector=narrow?'.settings-mobile-navigation [role=combobox]':navigationFocus.current==='lookup'?'[aria-label="查找页面"]':'.settings-sidebar [data-current-group],.settings-sidebar [aria-current=page]';
    const target=document.querySelector<HTMLElement>(selector) || (!narrow?document.querySelector<HTMLElement>('[aria-label="搜索设置"]'):null);
    transferringNavigation.current=true;target?.focus({preventScroll:true});transferringNavigation.current=false;
  },[narrow]);
  const sourceKey=JSON.stringify([s.configPath.resolvedPath || '',s.storage.resolvedPath || '']);
  const viewMemory=useMemo<ViewMemory>(()=>new Map(),[sourceKey]);
  const positions=useMemo(()=>new Map<PageId,number>(),[sourceKey]);
  const navigationRef=useRef<(id:string)=>boolean>(()=>false), sectionRef=useRef<(id:string)=>boolean>(()=>false);
  const integration = host().FlowHubPluginIntegration;
  const jsonBefore = useRef<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null), reviewTrigger = useRef<HTMLButtonElement>(null);
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
  function finishJson() {
    if (store.snapshot().busy) return false;
    try { store.applyJson(); setJson(false); return true; } catch (e) { store.notice(String(e), true); return false; }
  }
  function openJson() { jsonBefore.current = store.snapshot().jsonText; setJson(true); }
  function cancelJson() { if (!store.snapshot().busy) { store.restoreJson(jsonBefore.current); setJson(false); } }
  function navigate(requested: string) {
    const id = settingsLocation(requested);
    if(!id && (readonly() || !requested.startsWith('plugin:')))return false;
    if (store.snapshot().busy || !finishJson()) return false;
    if (!id) {
      void workspaceCall('select', requested).catch(e => store.notice(String(e), true));
    }
    else {
      const current=journeyRef.current;
      if(current.pages[current.index]!==id){
        if(main.current)positions.set(current.pages[current.index],main.current.scrollTop);
        const pages=[...current.pages.slice(0,current.index+1),id].slice(-40),next={pages,index:pages.length-1};journeyRef.current=next;setJourney(next);
      }
      if(requested==='appearance')requestLocation('core',{label:'外观主题'});
    }return true;
  }
  function travel(delta:number) {
    const current=journeyRef.current,index=current.index+delta;
    if(index<0 || index>=current.pages.length || store.snapshot().busy || !finishJson())return;
    if(main.current)positions.set(current.pages[current.index],main.current.scrollTop);
    const next={...current,index};journeyRef.current=next;setJourney(next);
  }
  navigationRef.current=navigate;sectionRef.current=id=>navigate(corePage(id));
  useLayoutEffect(()=>{if(main.current)main.current.scrollTop=positions.get(module) || 0;},[module,positions,s.config!==null]);
  const requestLocation=useSettingLocation(main,module,s.config!==null,sourceKey);
  function openSettingsSearch() {
    if(store.snapshot().busy || !store.snapshot().config)return;
    if(searchOpen){const input=document.querySelector<HTMLInputElement>('[aria-label="搜索设置项"]');input?.focus();input?.select();return;}
    if([...document.querySelectorAll<HTMLElement>('[role=dialog],[role=menu],[role=listbox]')].some(popup=>popup.getClientRects().length && getComputedStyle(popup).visibility!=='hidden'))return;
    setSearchOpen(true);
  }
  const searchKey=useRef(openSettingsSearch);searchKey.current=openSettingsSearch;
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(event.defaultPrevented || event.repeat || event.isComposing || event.keyCode===229 || !event.metaKey && !event.ctrlKey)return;
      if(!shortcutKeys.matches(event,'CommandOrControl+K'))return;
      if(store.snapshot().busy || !store.snapshot().config)return;
      if(document.querySelector('[role=dialog]') && !document.querySelector('[aria-label="搜索设置项"]'))return;
      event.preventDefault();searchKey.current();
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[store]);
  const page=navigationItems.find(item=>item.id===module)!;
  const pagePicker = narrow ? <div className="settings-mobile-navigation">
    <Select label="切换页面" value={module} options={pageChoices}
      valueLabel={<><span className="settings-mobile-group">{page.group} · </span><span>{page.label}</span></>}
      onChange={id=>{navigationFocus.current='page';navigate(id);}} disabled={s.busy}/>
  </div> : null;
  return <ViewStateContext.Provider value={viewMemory}><div className={`settings-stage${readonly() ? '' : ' settings-detached-workspace'}`}><div className="settings-landscape" aria-hidden="true" /><div className="fh-root settings-shell settings-compact-workspace flex flex-col" aria-busy={s.busy} onFocusCapture={event=>{
    const target=event.target as HTMLElement;
    if(!transferringNavigation.current)navigationFocus.current=target.closest('.settings-sidebar')?(target.matches('input')?'lookup':'page'):target.closest('.settings-mobile-navigation')?'page':null;
  }}>
    <a className="settings-skip-link" href="#settings-content" onClick={event=>{event.preventDefault();main.current?.focus({preventScroll:true});}}>跳到页面内容</a>
    <header data-tauri-drag-region="deep" className="settings-topbar flex items-center justify-between gap-3">
      <div className="settings-page-navigation flex items-center gap-3">
        <div className="settings-history flex items-center gap-1">
          <Tooltip content="返回上一页"><Button size="icon-sm" variant="ghost" aria-label="返回上一页" disabled={s.busy || journey.index===0} onClick={()=>travel(-1)}><ArrowLeftIcon/></Button></Tooltip>
          <Tooltip content="前进下一页"><Button size="icon-sm" variant="ghost" aria-label="前进下一页" disabled={s.busy || journey.index===journey.pages.length-1} onClick={()=>travel(1)}><ArrowRightIcon/></Button></Tooltip>
        </div>
        <div className="settings-page-heading">
          <h1 id="settings-page-title" className={narrow ? 'sr-only' : undefined}>{page.label}</h1>
        </div>
        {pagePicker}
      </div>
      <div className="settings-global-actions flex items-center gap-2">
        <Tooltip content={`搜索设置（${shortcutKeys.format('CommandOrControl+K')}）`}>
          <Button className="settings-quick-find" aria-label="搜索设置" disabled={s.busy || !s.config} onClick={openSettingsSearch}>
            <SearchIcon aria-hidden="true" /><span className="settings-action-label">搜索设置</span><kbd className="settings-search-key">{shortcutKeys.format('CommandOrControl+K')}</kbd>
          </Button>
        </Tooltip>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} actionsRef={menuActions}>
          <DropdownMenuTrigger ref={menuTrigger} render={<Button size="icon-sm" aria-label="更多设置操作" disabled={s.busy || !s.config} />}>
            <EllipsisIcon data-icon="inline-start" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="settings-global-menu">
            <DropdownMenuGroup>
              {!readonly() && <DropdownMenuItem onClick={() => void workspaceCall('show').catch(e => store.notice(String(e), true))}><PuzzleIcon aria-hidden="true" />显示插件栏</DropdownMenuItem>}
              <DropdownMenuItem onClick={openJson}>{readonly() ? '查看完整配置 JSON' : '编辑完整配置 JSON'}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('updates')}>版本与更新</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {readonly() && <Button onClick={() => host().requestSettingsClose?.()} disabled={s.busy}>关闭</Button>}
      </div>
    </header>
    <div className={`settings-workspace grid${narrow?' settings-workspace-narrow':''}`}>
      {!narrow?<Navigation key={sourceKey} page={module} busy={s.busy} preview={readonly()} installedCount={installed.length} useGlobalSearch onNavigate={navigate}/>:null}
      <main ref={main} id="settings-content" aria-labelledby="settings-page-title" tabIndex={-1} className="settings-main min-w-0" onScroll={()=>{if(main.current)positions.set(journeyRef.current.pages[journeyRef.current.index],main.current.scrollTop);}}><div key={`${sourceKey}:${marketView ? 'plugin-market' : module}`} className={`settings-page${marketView || module==='web' || module==='memo'?' settings-page-wide':''}`}>
        {!s.config ? <EmptyState error={!s.busy}>{s.busy ? '正在读取配置…' : '配置未能加载'}<Button disabled={s.busy} onClick={() => void store.run(() => store.load())}>重试</Button></EmptyState> : <>
          {marketView ? <Market readOnly={readonly()} section={{view:marketView,onChange:view=>navigate(view==='installed'?'plugins-installed':'plugins-discover')}}/> : module === 'canvas' ? <CanvasSettings /> : <>
            {['core', 'data', 'updates', 'search', 'menubar'].includes(module) ? <Core store={store} section={module === 'core' ? 'general' : module} /> : <fieldset disabled={s.busy || s.conflict || (readonly() && module !== 'web' && module !== 'memo' && module !== 'tools')} className="settings-fieldset">{module === 'web' ? <WebCatalog store={store} /> : module === 'memo' ? <Memos store={store} /> : module === 'clipboard' ? <Clipboard store={store} /> : module === 'tools' ? <Tools store={store} /> : <Applications store={store} />}</fieldset>}
          </>}
        </>}
      </div></main></div>
    <SettingsFooter store={store} compact reviewTrigger={reviewTrigger} onReview={()=>{if(finishJson())setReview(true);}} onReset={()=>setReset(true)} />
    {searchOpen ? <SettingsSearch onClose={()=>setSearchOpen(false)} onChoose={entry=>{
      if(!navigate(entry.page))return {ok:false,error:store.snapshot().notice || '当前无法切换，请先处理未完成的配置编辑。'};
      setSearchOpen(false);requestLocation(entry.page,entry.target);return {ok:true};
    }} />:null}
    {review && s.config ? <DraftReview store={store} onClose={()=>setReview(false)} onNavigate={id=>{
      if(s.busy || !navigate(id))return;setReview(false);
      requestAnimationFrame(()=>requestAnimationFrame(()=>{if(document.activeElement===reviewTrigger.current || document.activeElement===document.body)main.current?.focus({preventScroll:true});}));
    }} />:null}
    {json && s.config ? <Dialog title={readonly() ? '查看完整配置 JSON' : '编辑完整配置 JSON'} busy={s.busy} onClose={cancelJson} notice={s.error ? s.notice : undefined} className="settings-json-dialog" fixedHeight
      footer={<div className="settings-dialog-actions">{!readonly() ? <Button disabled={s.busy} onClick={cancelJson}>取消编辑</Button> : null}<Button disabled={s.busy} onClick={() => { finishJson(); }}>{readonly() ? '完成' : '完成编辑'}</Button></div>}>
      <p className="fh-muted">{readonly() ? '此处查看 FlowHub 完整配置。' : '此处编辑完整配置；完成后进入草稿，保存后生效。'}</p>
      <Textarea aria-label="完整配置 JSON" className="settings-code" rows={18} spellCheck={false} readOnly={readonly() || s.busy || s.conflict} value={s.jsonText ?? JSON.stringify(s.config, null, 2)} onChange={e => store.setJson(e.target.value)} />
    </Dialog> : null}
    {reset ? <Dialog title="重置未保存修改" busy={s.busy} onClose={() => setReset(false)}><p>{s.conflict ? '保留源草稿并加载当前目标配置？' : '放弃当前编辑，重新加载已保存配置？'}</p><Button onClick={() => void store.run(async () => { await store.reset(); setReset(false); })}>确认重置</Button></Dialog> : null}
    {close ? <Dialog title="关闭设置" busy={s.busy} onClose={() => setClose(false)} notice={s.error ? s.notice : undefined}><p>尚有未保存修改，关闭前请选择如何处理。</p><div className="settings-dialog-actions"><Button disabled={s.busy} onClick={() => setClose(false)}>取消</Button><Button disabled={s.busy} onClick={() => void store.run(async () => { store.persist(); await call('closeSettings'); })}>保留草稿并关闭</Button><Button className="primary" disabled={s.busy || s.conflict} onClick={() => void store.run(async () => { await store.save(); if (!store.dirty) await call('closeSettings'); })}>保存并关闭</Button></div></Dialog> : null}
    {s.recovery ? <Dialog title="发现本地草稿" busy={false} onClose={() => store.patch({ recovery: null })} fixedHeight
      footer={<div className="settings-dialog-actions"><Button disabled={!s.recovery.origin} onClick={() => void store.run(async () => store.recoverDraft())}>恢复同源草稿</Button><Button onClick={() => store.patch({ recovery: null })}>暂不恢复</Button></div>}>
      <p>{new Date(s.recovery.savedAt).toLocaleString()} 保存的草稿。{s.recovery.baseSignature !== signature(s.saved) ? '磁盘配置已发生变化，请核对后恢复。' : ''}</p>
      <pre className="settings-code">{s.recovery.jsonDirty ? s.recovery.jsonText : JSON.stringify(s.recovery.config, null, 2)}</pre>
    </Dialog> : null}
  </div></div></ViewStateContext.Provider>;
}
export function mountSettings(element: HTMLElement) { const store = new SettingsStore(), root = createRoot(element); root.render(<Settings store={store} />); return () => { store.dispose(); root.unmount(); }; }
