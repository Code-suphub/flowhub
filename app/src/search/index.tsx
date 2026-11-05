import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Button, Dialog } from '../shared/ui';
import { Help, Tooltip } from '../shared/controls';
import { Command, CornerUpLeft, CornerDownLeft, History, MoreHorizontal, PanelRight, PanelRightClose, Pin, PinOff, Search as SearchIcon, Settings2 } from 'lucide-react';
import { useMediaQuery } from '../shared/useMediaQuery';
import { Results, resultActions } from './Results';
import { ActionPanel, actionIdentity, availableActions, type ResultAction } from './ActionPanel';
import { CommandPalette } from './CommandPalette';
import { QueryHistory } from './QueryHistory';
import { ClipboardFilters, ClipboardNoteEditor, type ClipboardNoteTarget } from './ClipboardOrganization';
import { getQueryHistory, type QueryHistoryEntry } from './query-history';
import type { LauncherCommand } from './commands';
import { shortcutKeys } from '../shared/shortcuts';
import { Preview, canPreview, previewNeighbor, primaryLabel } from './Preview';
import { isLongPreviewContent, previewIdentity, readPreviewExpanded, rememberPreviewExpanded } from './preview-layout';
import { host, type SearchController, type SearchSnapshot, type SearchItem } from './types';
import './search.css';

function KeyboardHint({selected,usageNavigation}: {selected?:SearchItem;usageNavigation?:boolean}) {
  const hints:string[]=[];
  hints.push('Tab 切换范围','F6 / ⇧F6 切换操作按钮，末尾 F6 进入操作面板',`${shortcutKeys.format('CommandOrControl+Shift+P')} 查找命令`,`${shortcutKeys.format('CommandOrControl+Shift+H')} 搜索历史与补全`,'⌘K 返回搜索框');
  if(selected?.type==='clipboard') {
    if(selected.kind!=='image')hints.push('⇧⏎ 纯文本粘贴');
    hints.push('⌘D 置顶');
    if(selected.kind==='text')hints.push('⌘E 编辑副本');
    if(document.documentElement.dataset.weborgReadonly!=='true')hints.push('⌥⌫ 删除');
  }
  if(selected && (selected.type==='clipboard' || resultActions(selected).length))hints.push('右键 搜索结果操作');
  const action=primaryLabel(selected);
  hints.push('单击选择 · 双击或回车执行');
  if(canPreview(selected))hints.push('⌘I 展开／收起预览','预览中 ⌥↑ / ⌥↓ 切换结果');
  return <span id="keyboardHint" className="search-keyboard-hint"><span>{usageNavigation?'↑↓ 跨排 · ←→ 同排':selected?'↑↓ 选择 · ↵ '+action:'输入以搜索'}</span><Help label="其他快捷键"><div className="search-shortcut-list">{hints.map(hint=><span key={hint}>{hint}</span>)}</div></Help></span>;
}

function Search() {
  const root=useRef<HTMLDivElement>(null), controller=useRef<SearchController | null>(null);
  const [snapshot,setSnapshot]=useState<SearchSnapshot | null>(null), [pinBusy,setPinBusy]=useState(false);
  const state=snapshot?.state, activeIndex=state?.index || 0, selected=snapshot?.items[activeIndex];
  const selectedKey=previewIdentity(selected);
  const [detailOpen,setDetailOpen]=useState(false);
  const [widePreview,setWidePreview]=useState(readPreviewExpanded);
  const [dismissedPreview,setDismissedPreview]=useState<string|null>(null);
  const narrow=useMediaQuery('(max-width: 719px)');
  const previousNarrow=useRef(narrow), previewFocused=useRef(false);
  const previewFrame=useRef<number | undefined>(undefined);
  const pendingPreviewFocus=useRef(false);
  const openPreview=useCallback((index:number,reveal=false)=>{
    setDismissedPreview(null);
    controller.current?.selectResult(index,{reveal});
    if(narrow)setDetailOpen(true);
    else if(!widePreview){setWidePreview(true);rememberPreviewExpanded(true);}
    pendingPreviewFocus.current=true;
  },[narrow,widePreview]);
  const cancelPreviewFocus=useCallback(()=>{
    pendingPreviewFocus.current=false;
    if(previewFrame.current!==undefined){cancelAnimationFrame(previewFrame.current);previewFrame.current=undefined;}
  },[]);
  const closePreview=useCallback(()=>{
    cancelPreviewFocus();
    if(narrow)setDetailOpen(false);
    else {setWidePreview(false);setDismissedPreview(selectedKey);rememberPreviewExpanded(false);}
    root.current?.querySelector<HTMLInputElement>('#q')?.focus({preventScroll:true});
  },[narrow,selectedKey,cancelPreviewFocus]);
  useEffect(()=>{
    setDismissedPreview(current=>current===selectedKey?current:null);
  },[selectedKey]);
  // Resizing returns a narrow detail view to the list. Never leave focus on an
  // unmounted preview, or turn a temporary narrow view into a saved preference.
  useLayoutEffect(()=>{
    if(previousNarrow.current===narrow)return;
    previousNarrow.current=narrow;
    cancelPreviewFocus();setDetailOpen(false);
    if(previewFocused.current && !document.hidden && document.hasFocus())root.current?.querySelector<HTMLInputElement>('#q')?.focus({preventScroll:true});
    previewFocused.current=false;
  },[narrow,cancelPreviewFocus]);
  const clearSearch=useCallback(()=>{
    const input=root.current?.querySelector<HTMLInputElement>('#q');
    if(!input)return;input.value='';controller.current?.handlers['input:input']?.();input.focus({preventScroll:true});
  },[]);
  const [actionKey,setActionKey]=useState<string|null>(null);
  const [commandsOpen,setCommandsOpen]=useState(false);
  const [historyOpen,setHistoryOpen]=useState(false);
  const [noteTarget,setNoteTarget]=useState<ClipboardNoteTarget|null>(null);
  const actionFrame=useRef<number|undefined>(undefined);
  const cancelActionWork=useCallback(()=>{
    if(actionFrame.current!==undefined){cancelAnimationFrame(actionFrame.current);actionFrame.current=undefined;}
  },[]);
  const closeActions=useCallback(()=>{
    cancelActionWork();
    setActionKey(null);
    setCommandsOpen(false);
    setHistoryOpen(false);
    // Wait for the modal focus trap to unmount before returning to the query.
    actionFrame.current=requestAnimationFrame(()=>{actionFrame.current=undefined;controller.current?.returnToSearch();});
  },[cancelActionWork]);
  const closeNote=useCallback(()=>{setNoteTarget(null);actionFrame.current=requestAnimationFrame(()=>{actionFrame.current=undefined;controller.current?.returnToSearch();});},[]);
  useLayoutEffect(()=>{
    const c=host.createFlowHubSearchController(root.current!,setSnapshot,{onQueryUsed:entry=>getQueryHistory().record(entry)}); controller.current=c;
    return ()=>{controller.current=null;c.dispose();cancelActionWork();if(previewFrame.current!==undefined)cancelAnimationFrame(previewFrame.current);};
  },[cancelActionWork]);
  useEffect(()=>{
    const node=root.current;
    const preview=(event:Event)=>{
      const mode=(event as CustomEvent<string>).detail;
      if(mode==='dismiss-actions'){cancelActionWork();setActionKey(null);setCommandsOpen(false);setHistoryOpen(false);return;}
      if(mode==='reset'){cancelActionWork();cancelPreviewFocus();setDetailOpen(false);setActionKey(null);setCommandsOpen(false);setHistoryOpen(false);return;}
      if(mode==='selection'){if(narrow)setDetailOpen(true);return;}
      if(mode==='close'){
        if(narrow && detailOpen){event.preventDefault();closePreview();}
        return;
      }
      if(mode==='toggle'){
        if(narrow?detailOpen:node?.querySelector('.search-workbench')?.getAttribute('data-preview-open')==='true')closePreview();
        else openPreview(controller.current?.state.index || 0);
      }
    };
    node?.addEventListener('flowhub:preview',preview);
    return ()=>node?.removeEventListener('flowhub:preview',preview);
  },[detailOpen,widePreview,narrow,openPreview,closePreview,cancelPreviewFocus,cancelActionWork]);
  useEffect(()=>{
    const node=root.current;
    const open=()=>{cancelActionWork();cancelPreviewFocus();setActionKey(null);setHistoryOpen(false);setCommandsOpen(true);};
    node?.addEventListener('flowhub:commands',open);
    return()=>node?.removeEventListener('flowhub:commands',open);
  },[cancelActionWork,cancelPreviewFocus]);
  useEffect(()=>{
    const node=root.current;
    const open=(event:Event)=>{cancelActionWork();cancelPreviewFocus();setActionKey(null);setCommandsOpen(false);setHistoryOpen(false);setNoteTarget((event as CustomEvent<ClipboardNoteTarget>).detail);};
    node?.addEventListener('flowhub:clipboard-note',open);
    return()=>node?.removeEventListener('flowhub:clipboard-note',open);
  },[cancelActionWork,cancelPreviewFocus]);
  useEffect(()=>{
    const node=root.current;
    const open=()=>{cancelActionWork();cancelPreviewFocus();setActionKey(null);setCommandsOpen(false);setHistoryOpen(true);};
    node?.addEventListener('flowhub:query-history',open);
    return()=>node?.removeEventListener('flowhub:query-history',open);
  },[cancelActionWork,cancelPreviewFocus]);
  useLayoutEffect(()=>{
    if(snapshot?.timing) host.flowhubSearchTiming?.commit(snapshot.timing.run,snapshot.timing.startedAt);
  },[snapshot]);
  // Measure only windowed rows after a commit; ordinary input renders do not
  // synchronously read geometry or scroll. ResizeObserver catches expansion.
  useLayoutEffect(()=>{
    const plan=snapshot?.plan, c=controller.current;
    if(!plan || !c || typeof ResizeObserver==='undefined') return;
    let frame:number|undefined;
    const observer=new ResizeObserver(entries=>{
      let changed=false;
      for(const entry of entries) {
        const id=(entry.target as HTMLElement).dataset.measureKey;
        const height=entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
        if(id && height>0 && Math.abs((c.resultWindow.heights.get(id) || 0)-height)>.5){c.resultWindow.heights.set(id,height);changed=true;}
      }
      if(changed && frame===undefined)frame=requestAnimationFrame(()=>{frame=undefined;c.render({preserveScroll:true});});
    });
    for(const group of plan.groups) {
      const row=root.current?.querySelector<HTMLElement>(`.result[data-i="${group.start}"]`);
      const element=row?.closest<HTMLElement>('[data-group]') || row;
      if(element){element.dataset.measureKey=group.id;observer.observe(element);}
    }
    return ()=>{observer.disconnect();if(frame!==undefined)cancelAnimationFrame(frame);};
  },[snapshot?.plan]);
  const dispatch=(name:string)=>(event:React.SyntheticEvent)=>controller.current?.handlers[name]?.(event);
  useLayoutEffect(()=>{
    const results=root.current?.querySelector('#results');
    const open=(event:Event)=>{
      const index=(event as CustomEvent<{index:number}>).detail?.index;
      const item=snapshot?.items[index];
      if(!item || (item.type!=='clipboard' && !resultActions(item).length))return;
      cancelActionWork();cancelPreviewFocus();setActionKey(actionIdentity(item));
    };
    results?.addEventListener('flowhub:open-action-menu',open);
    return ()=>results?.removeEventListener('flowhub:open-action-menu',open);
  },[snapshot?.items,cancelPreviewFocus,cancelActionWork]);
  function contextMenu(event:React.MouseEvent<HTMLDivElement>) {
    if((event.target as HTMLElement).closest('[data-clipboard-editor]'))return;
    const row=(event.target as HTMLElement).closest<HTMLElement>('.result');
    const item=row && snapshot?.items[Number(row.dataset.i)];
    if(!item || !availableActions(item,false).length) {setActionKey(null);controller.current?.handlers['results:contextmenu']?.(event);return;}
    event.preventDefault();
    if(state?.editingClipboard || state?.deletingClipboard)return;
    cancelActionWork();cancelPreviewFocus();
    controller.current?.selectResult(Number(row!.dataset.i));
    setActionKey(actionIdentity(item));
  }
  const activate=(event:React.MouseEvent<HTMLButtonElement>)=>{setDetailOpen(false);controller.current?.activateScopeControl(event.currentTarget);};
  const press=(event:React.MouseEvent)=>controller.current?.preserveSearchFocus(event);
  const plan=snapshot?.plan;
  // The result list is virtualized: the active option leaves the DOM once the
  // user scrolls past it. Only reference an option that is actually rendered.
  const activeRendered=Boolean(selected)&&(!plan||(activeIndex>=plan.from&&activeIndex<plan.to));
  const actionItem=actionKey?snapshot?.items.find(item=>actionIdentity(item)===actionKey):undefined;
  useEffect(()=>{if(actionKey && !actionItem)closeActions();},[actionKey,actionItem,closeActions]);
  const version=String(snapshot?.updateState?.currentVersion || ''), hasUpdate=['available','downloaded'].includes(snapshot?.updateState?.status || '');
  const placeholders:Record<string,string>={app:'搜索已安装的应用…',web:'搜索网页与书签…',clipboard:'搜索剪贴板历史…',memo:'搜索命令备忘…',twofa:'搜索验证码账户…'};
  const placeholder=placeholders[state?.scope || ''] || '搜索应用、网页、剪贴板…';
  const previewable=canPreview(selected) && !state?.editingClipboard;
  const autoPreview=state?.config?.core?.autoPreviewLongContent !== false && isLongPreviewContent(selected) && dismissedPreview !== selectedKey;
  const previewVisible=Boolean(previewable && (narrow?detailOpen:widePreview || autoPreview));
  useLayoutEffect(()=>{
    if(previewVisible || !previewFocused.current)return;
    cancelPreviewFocus();
    if(!state?.editingClipboard && !state?.deletingClipboard && !document.hidden && document.hasFocus())root.current?.querySelector<HTMLInputElement>('#q')?.focus({preventScroll:true});
    previewFocused.current=false;
  },[previewVisible,state?.editingClipboard,state?.deletingClipboard,cancelPreviewFocus]);
  // A collapsed preview has no DOM. Wait for its committed mount before
  // scheduling focus; reset/input/resize can still cancel this explicit intent.
  useLayoutEffect(()=>{
    if(!pendingPreviewFocus.current)return;
    pendingPreviewFocus.current=false;
    if(!previewVisible)return;
    if(previewFrame.current!==undefined)cancelAnimationFrame(previewFrame.current);
    previewFrame.current=requestAnimationFrame(()=>{
      previewFrame.current=undefined;
      if(!document.hidden && document.hasFocus())root.current?.querySelector<HTMLElement>('.search-preview-body')?.focus({preventScroll:true});
    });
  });
  const openActions=()=>{
    if(!selected)return;
    cancelActionWork();cancelPreviewFocus();setActionKey(actionIdentity(selected));
  };
  const chooseAction=(action:ResultAction)=>{
    if(!actionKey || action.disabled || actionFrame.current!==undefined)return;
    // The controller resolves the same identity against its latest results.
    // A refresh or reorder must never redirect an action to another record.
    const key=actionKey;
    setActionKey(null);
    actionFrame.current=requestAnimationFrame(()=>{
      actionFrame.current=undefined;
      const c=controller.current;if(!c)return;
      c.returnToSearch();c.executeAction(key,action.kind,action.action);
    });
  };
  const readonly=document.documentElement.dataset.weborgReadonly==='true';
  function recallHistory(entry:QueryHistoryEntry) {
    if(actionFrame.current!==undefined)return;
    setHistoryOpen(false);
    actionFrame.current=requestAnimationFrame(()=>{
      actionFrame.current=undefined;
      const current=getQueryHistory().snapshot().find(current=>current.id===entry.id);
      if(current)controller.current?.recallQuery(current);
      else controller.current?.returnToSearch();
    });
  }
  async function executeCommand(command:LauncherCommand) {
    const c=controller.current;if(!c)throw Error('启动器已关闭');
    const target=command.target;
    if(target.type==='settings') {
      const result=await host.weborg.openSettings({initialModule:target.module});
      if(result?.ok===false)throw Error(result.reason || '当前无法打开此入口');
      return;
    }
    if(target.type==='scope')c.setScope(target.id);
    else if(target.action==='history') {cancelPreviewFocus();setCommandsOpen(false);setHistoryOpen(true);return 'handled' as const;}
    else if(target.action==='clear')clearSearch();
    else if(target.action==='preview') {if(previewVisible)closePreview();else openPreview(activeIndex);cancelPreviewFocus();}
    else if(target.action==='pin') {
      if(readonly || document.documentElement.dataset.weborgReadonly==='true')throw Error('只读预览不能固定窗口');
      if(!await c.togglePin())throw Error('窗口固定失败，请重试');
    }
    closeActions();
  }
  return <div ref={root} className="fh-root search-shell flex flex-col h-full" onFocusCapture={event=>{previewFocused.current=Boolean((event.target as HTMLElement).closest('.search-preview'));}} onLoadCapture={dispatch('results:load')} onErrorCapture={dispatch('results:error')}>
    {state?.deletingClipboard?<Dialog title="删除剪贴板记录" busy={state.deletingClipboard.busy} notice={state.deletingClipboard.error} onClose={()=>controller.current?.cancelClipboardDelete()}>
      <p>确定删除这条剪贴板记录吗？只会删除历史记录和图片副本，不会删除原始文件。</p>
      <div className="flex justify-end gap-2 mt-4"><Button autoFocus disabled={state.deletingClipboard.busy} onClick={()=>controller.current?.cancelClipboardDelete()}>取消</Button><Button className="danger" disabled={state.deletingClipboard.busy} onClick={()=>void controller.current?.confirmClipboardDelete()}>确认删除</Button></div>
    </Dialog>:null}
    <header className="search-header flex items-center gap-2">
    <SearchIcon className="search-leading-icon" aria-hidden="true"/>
    <div className="search-input-wrap"><label className="sr-only" htmlFor="q">搜索网页、应用、剪贴板或命令备忘</label>
      <div className="search-input-box"><input id="q" className="fh-input" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="搜索网页、应用、剪贴板或命令备忘" placeholder={placeholder} role="combobox" aria-autocomplete="list" aria-expanded={Boolean(snapshot?.items.length)} aria-controls="search-results" aria-activedescendant={activeRendered?`search-result-${activeIndex}`:undefined} onInput={dispatch('input:input')} onCompositionStart={dispatch('input:compositionstart')} onCompositionEnd={dispatch('input:compositionend')}/>
      {state?.query?<button type="button" className="search-clear" aria-label="清除搜索内容" onMouseDown={event=>event.preventDefault()} onClick={clearSearch}>×</button>:null}<Tooltip content={`搜索历史与补全（${shortcutKeys.format('CommandOrControl+Shift+H')}）`}><Button className="search-history-button" variant="ghost" size="icon-sm" aria-label="搜索历史与补全" aria-haspopup="dialog" aria-expanded={historyOpen} aria-keyshortcuts={shortcutKeys.isMac()?'Meta+Shift+H':'Control+Shift+H'} disabled={!snapshot?.state.config || Boolean(state?.editingClipboard || state?.deletingClipboard)} onClick={()=>controller.current?.requestQueryHistory()}><History aria-hidden="true"/></Button></Tooltip></div>
    </div>
    {readonly?<span className="search-preview-badge">{new URLSearchParams(location.search).get('preview')==='demo'?'只读演示':'只读预览'}</span>:null}
    <div className="search-header-actions flex items-center gap-1"><Tooltip content={`查找页面、设置与插件（${shortcutKeys.format('CommandOrControl+Shift+P')}）`}><Button id="commandsBtn" variant="ghost" size="sm" aria-label="查找 FlowHub 命令" aria-keyshortcuts={shortcutKeys.isMac()?'Meta+Shift+P':'Control+Shift+P'} aria-haspopup="dialog" aria-expanded={commandsOpen} disabled={!snapshot?.state.config || Boolean(state?.editingClipboard || state?.deletingClipboard)} onClick={()=>controller.current?.requestCommands()}><Command aria-hidden="true"/><span>命令</span></Button></Tooltip><Tooltip content="返回搜索框（⌘K）"><Button id="returnSearchBtn" variant="ghost" size="icon-sm" aria-label="返回搜索框" aria-keyshortcuts="Meta+K" onClick={()=>controller.current?.returnToSearch()}><CornerUpLeft aria-hidden="true"/></Button></Tooltip><Tooltip content={snapshot?.launcherPinned?'取消固定搜索窗口':'固定搜索窗口'}><Button id="pinBtn" variant="ghost" size="icon-sm" aria-label={snapshot?.launcherPinned?'取消固定搜索窗口':'固定搜索窗口'} aria-pressed={snapshot?.launcherPinned || false} disabled={!host.weborg?.setLauncherPinned || pinBusy} onClick={async()=>{setPinBusy(true);try{await controller.current?.togglePin();}finally{setPinBusy(false);}}}>{snapshot?.launcherPinned?<PinOff aria-hidden="true"/>:<Pin aria-hidden="true"/>}</Button></Tooltip><Tooltip content={`打开 FlowHub 设置${version?` · v${version}`:''}${hasUpdate?' · 有新版本':''}`}><Button id="settingsBtn" variant="ghost" size="icon-sm" aria-label="打开 FlowHub 设置" onClick={()=>host.weborg.openSettings()}><Settings2 aria-hidden="true"/></Button></Tooltip></div>
    </header>
    <nav id="scopeRow" aria-label="搜索范围" className="search-scopes flex gap-1 overflow-x-auto">{[{id:'all',name:'全部'},...(state?.plugins || []).filter((p:{searchable:boolean})=>p.searchable)].map((p:{id:string;name:string})=><Button key={p.id} data-scope={p.id} className={`scope-button ${state?.scope===p.id?'active':''}`} aria-pressed={state?.scope===p.id} onMouseDown={press} onClick={activate}>{p.name}</Button>)}</nav>
    {state?.scope==='clipboard' && snapshot?<ClipboardFilters snapshot={snapshot} onKind={kind=>controller.current?.setClipboardKind(kind)} onFilter={(source,pinnedOnly)=>controller.current?.setClipboardFilters({source,pinnedOnly})} onReset={()=>{controller.current?.setClipboardFilters({kind:'all',source:null,pinnedOnly:false});controller.current?.returnToSearch();}} onReturn={()=>controller.current?.returnToSearch()}/>:null}
    <div className="search-workbench" data-has-preview={Boolean(previewable)} data-preview-open={previewVisible} data-detail-open={detailOpen}>
      <div id="results" className="search-result-pane min-h-0 overflow-y-auto" onScroll={dispatch('results:scroll')} onClick={dispatch('results:click')} onDoubleClick={dispatch('results:dblclick')} onMouseMove={dispatch('results:mousemove')} onMouseDown={dispatch('results:mousedown')} onContextMenu={contextMenu}>
        {snapshot?<Results snapshot={snapshot} onPreview={openPreview} onClear={clearSearch} onSearchAll={()=>controller.current?.setScope('all')}/>:<p className="search-empty" role="status">配置加载中…</p>}
      </div>
      {previewVisible && selected && snapshot?<Preview item={selected} index={activeIndex} snapshot={snapshot} onAction={dispatch('results:click')} onBack={closePreview} onNavigate={direction=>{const next=previewNeighbor(snapshot.items,activeIndex,direction);if(next>=0)openPreview(next,true);}}/>:null}
    </div>
    {actionItem?<ActionPanel key={actionKey} item={actionItem} onClose={closeActions} onChoose={chooseAction}/>:null}
    {commandsOpen && snapshot?<CommandPalette snapshot={snapshot} previewable={Boolean(previewable)} previewOpen={previewVisible} onClose={closeActions} onExecute={executeCommand}/>:null}
    {historyOpen && snapshot?<QueryHistory snapshot={snapshot} onClose={closeActions} onRecall={recallHistory}/>:null}
    {noteTarget?<ClipboardNoteEditor key={noteTarget.id} target={noteTarget} onClose={closeNote} onSaved={()=>void controller.current?.refreshClipboard()}/>:null}
    <footer className="search-footer" onClick={dispatch('results:click')}>
      <div className="search-footer-message"><span id="actionStatus" role="status">{snapshot?.statusText}</span>{!snapshot?.statusText?<KeyboardHint selected={selected} usageNavigation={Boolean(selected?.usageSection && state?.query==='')}/>:null}</div>
      <div className="search-footer-actions">
        {previewable?<Button variant="ghost" size="sm" aria-label={previewVisible?'收起预览':'展开预览'} aria-expanded={previewVisible} aria-controls={previewVisible?'search-preview':undefined} aria-keyshortcuts="Meta+I" onClick={()=>previewVisible?closePreview():openPreview(activeIndex)}>{previewVisible?<PanelRightClose data-icon="inline-start"/>:<PanelRight data-icon="inline-start"/>}<span className="preview-toggle-label">{previewVisible?'收起预览':'预览'}</span><kbd>⌘I</kbd></Button>:null}
        {selected && availableActions(selected,readonly).length?<Tooltip content="搜索当前结果的操作；F6 也可进入"><Button id="resultActionsBtn" variant="ghost" size="sm" aria-label="搜索当前结果的操作" aria-haspopup="dialog" aria-expanded={Boolean(actionItem)} disabled={Boolean(state?.editingClipboard || state?.deletingClipboard)} onClick={openActions}>操作<MoreHorizontal data-icon="inline-end"/></Button></Tooltip>:null}
        {selected?<Button id="activateResultBtn" className="tool-action" variant="default" size="sm" data-result-action="open" data-result-index={activeIndex} disabled={Boolean(state?.editingClipboard || state?.deletingClipboard || readonly && ['clipboard','memo'].includes(selected.type))}>{primaryLabel(selected)}<CornerDownLeft data-icon="inline-end"/></Button>:null}
      </div>
    </footer>
  </div>;
}
const mounted = new WeakMap<HTMLElement,Root>();
export function mountSearch(root:HTMLElement) {
  mounted.get(root)?.unmount();
  const reactRoot=createRoot(root); mounted.set(root,reactRoot); reactRoot.render(<Search/>);
  return ()=>{if(mounted.get(root)===reactRoot){reactRoot.unmount();mounted.delete(root);}};
}
