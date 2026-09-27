import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Button, Dialog } from '../shared/ui';
import { Results } from './Results';
import { host, type SearchController, type SearchSnapshot, type SearchItem } from './types';
import './search.css';

function KeyboardHint({selected,scope}: {selected?:SearchItem;scope?:string}) {
  const hints=['↑↓ 选择结果',`⏎ ${selected?.type==='memo' || selected?.type==='clipboard'?'粘贴':selected?.type==='twofa'?'复制验证码':'打开'}`];
  if(scope==='all') hints.unshift('←→ 常用/最近');
  if(selected?.type==='clipboard') {
    hints.push('右键 更多操作');
    if(selected.kind!=='image')hints.push('⇧⏎ 纯文本粘贴');
    hints.push('⌘D 置顶');
    if(selected.kind==='text')hints.push('⌘E 编辑副本');
    if(document.documentElement.dataset.weborgReadonly!=='true')hints.push('⌥⌫ 删除');
  }
  if(selected && !selected.usageSection && (selected.toolId || ['page','web','app','memo','twofa','web-add','calculation','timestamp','jwt','dns','ip'].includes(selected.type)))hints.push('F6 操作按钮');
  hints.push('Tab 范围','⌘K 回到搜索框');
  return <span id="keyboardHint">{hints.join(' · ')}</span>;
}

function Search() {
  const root=useRef<HTMLDivElement>(null), controller=useRef<SearchController | null>(null);
  const [snapshot,setSnapshot]=useState<SearchSnapshot | null>(null), [pinBusy,setPinBusy]=useState(false);
  const [clipboardMenu,setClipboardMenu]=useState<{id:number;x:number;y:number}|null>(null);
  useEffect(()=>{
    const c=host.createFlowHubSearchController(root.current!,setSnapshot); controller.current=c;
    return ()=>{controller.current=null;c.dispose();};
  },[]);
  useLayoutEffect(()=>{
    if(snapshot?.timing) host.flowhubSearchTiming?.commit(snapshot.timing.run,snapshot.timing.startedAt);
  },[snapshot]);
  // Measure only windowed rows after a commit; ordinary input renders do not
  // synchronously read geometry or scroll. ResizeObserver catches expansion.
  useLayoutEffect(()=>{
    const plan=snapshot?.plan, c=controller.current;
    if(!plan || !c || typeof ResizeObserver==='undefined') return;
    const observer=new ResizeObserver(entries=>{
      for(const entry of entries) {
        const id=(entry.target as HTMLElement).dataset.measureKey;
        if(id)c.resultWindow.heights.set(id,entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height);
      }
    });
    for(const group of plan.groups) {
      const row=root.current?.querySelector<HTMLElement>(`.result[data-i="${group.start}"]`);
      const element=row?.closest<HTMLElement>('[data-group]') || row;
      if(element){element.dataset.measureKey=group.id;observer.observe(element);}
    }
    return ()=>observer.disconnect();
  },[snapshot?.plan]);
  const dispatch=(name:string)=>(event:React.SyntheticEvent)=>controller.current?.handlers[name]?.(event);
  useEffect(()=>{
    if(!clipboardMenu)return;
    const close=(event?:PointerEvent)=>{if(event?.target instanceof Element && event.target.closest('.search-context-menu'))return;setClipboardMenu(null);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};
    document.addEventListener('pointerdown',close);
    document.addEventListener('keydown',escape);
    return ()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[clipboardMenu]);
  function contextMenu(event:React.MouseEvent<HTMLDivElement>) {
    const row=(event.target as HTMLElement).closest<HTMLElement>('.result');
    const item=row && snapshot?.items[Number(row.dataset.i)];
    if(item?.type!=='clipboard') {setClipboardMenu(null);controller.current?.handlers['results:contextmenu']?.(event);return;}
    event.preventDefault();
    setClipboardMenu({id:Number(item.id),x:Math.max(8,Math.min(event.clientX,window.innerWidth-220)),y:Math.max(8,Math.min(event.clientY,window.innerHeight-176))});
  }
  const activate=(event:React.MouseEvent<HTMLButtonElement>)=>controller.current?.activateScopeControl(event.currentTarget);
  const press=(event:React.MouseEvent)=>controller.current?.preserveSearchFocus(event);
  const state=snapshot?.state, selected=snapshot?.items[state?.index || 0];
  const version=String(snapshot?.updateState?.currentVersion || ''), hasUpdate=['available','downloaded'].includes(snapshot?.updateState?.status || '');
  return <div ref={root} className="fh-root search-shell flex flex-col h-full">
    {state?.deletingClipboard?<Dialog title="删除剪贴板记录" busy={state.deletingClipboard.busy} notice={state.deletingClipboard.error} onClose={()=>controller.current?.cancelClipboardDelete()}>
      <p>确定删除这条剪贴板记录吗？只会删除历史记录和图片副本，不会删除原始文件。</p>
      <div className="flex justify-end gap-2 mt-4"><Button autoFocus disabled={state.deletingClipboard.busy} onClick={()=>controller.current?.cancelClipboardDelete()}>取消</Button><Button className="danger" disabled={state.deletingClipboard.busy} onClick={()=>void controller.current?.confirmClipboardDelete()}>确认删除</Button></div>
    </Dialog>:null}
    <header className="search-header flex items-center justify-between gap-2"><strong>FlowHub</strong><div className="flex items-center gap-2"><Button id="settingsBtn" aria-label="打开 FlowHub 设置" onClick={()=>host.weborg.openSettings()}>设置</Button><Button id="pinBtn" aria-pressed={snapshot?.launcherPinned || false} disabled={!host.weborg?.setLauncherPinned || pinBusy} onClick={async()=>{setPinBusy(true);try{await controller.current?.togglePin();}finally{setPinBusy(false);}}}>{snapshot?.launcherPinned?'取消固定':'固定'}</Button><span id="versionBadge" className={hasUpdate?'search-update':''} title={hasUpdate?`发现正式版 v${snapshot?.updateState?.availableVersion || '新版本'}`:`当前应用版本：${version || '浏览器预览'}`}>{version?`v${version.split('-')[0]}${version.includes('-local')?' · 本地版':''}`:'浏览器预览'}</span></div></header>
    <div className="search-input-wrap grid gap-2"><div className="flex items-center justify-between"><label htmlFor="q">快速检索</label><Button id="returnSearchBtn" aria-keyshortcuts="Meta+K" onClick={()=>controller.current?.returnToSearch()}>返回搜索 ⌘K</Button></div>
      <input id="q" className="fh-input" autoComplete="off" aria-label="搜索网页、应用、剪贴板或命令备忘" placeholder="搜索网页、应用、剪贴板或命令备忘…" role="combobox" aria-autocomplete="list" aria-expanded={Boolean(snapshot?.items.length)} aria-controls="results" aria-activedescendant={selected?`search-result-${state?.index || 0}`:undefined} onInput={dispatch('input:input')} onCompositionStart={dispatch('input:compositionstart')} onCompositionEnd={dispatch('input:compositionend')}/>
    </div>
    <nav id="scopeRow" aria-label="搜索范围" className="search-scopes flex gap-1 overflow-x-auto">{[{id:'all',name:'全部'},...(state?.plugins || []).filter((p:{searchable:boolean})=>p.searchable)].map((p:{id:string;name:string})=><Button key={p.id} data-scope={p.id} className={`scope-button ${state?.scope===p.id?'active':''}`} aria-pressed={state?.scope===p.id} onMouseDown={press} onClick={activate}>{p.name}</Button>)}</nav>
    {state?.scope==='clipboard'?<div id="clipboardKindRow" className="search-scopes flex gap-1" aria-label="剪贴板类型筛选">{[['all','全部'],['text','文本'],['image','图片'],['file','文件']].map(([kind,label])=><Button key={kind} data-clipboard-kind={kind} aria-pressed={state.clipboardKind===kind} onMouseDown={press} onClick={activate}>{label}</Button>)}</div>:null}
    <div id="results" role="listbox" aria-label="搜索结果" aria-busy={snapshot?.paging.loading || false} className="flex-1 min-h-0 overflow-y-auto" onScroll={dispatch('results:scroll')} onClick={dispatch('results:click')} onMouseMove={dispatch('results:mousemove')} onMouseDown={dispatch('results:mousedown')} onMouseUp={dispatch('results:mouseup')} onContextMenu={contextMenu} onLoadCapture={dispatch('results:load')} onErrorCapture={dispatch('results:error')}>{snapshot?<Results snapshot={snapshot}/>:<p className="search-empty">配置加载中…</p>}{clipboardMenu && snapshot?.items.some(item=>item.type==='clipboard' && Number(item.id)===clipboardMenu.id) ? <div className="search-context-menu" role="menu" aria-label="剪贴板操作" style={{left:clipboardMenu.x,top:clipboardMenu.y}} onClickCapture={()=>setClipboardMenu(null)}>{(()=>{const item=snapshot.items.find(item=>item.type==='clipboard' && Number(item.id)===clipboardMenu.id)!;return <><Button role="menuitem" data-clipboard-action="pin" data-clipboard-id={item.id}>{item.pinnedAt?'取消置顶（⌘D）':'置顶（⌘D）'}</Button>{['text','file'].includes(item.kind)?<Button role="menuitem" data-clipboard-action="plain" data-clipboard-id={item.id}>纯文本粘贴（⇧↩）</Button>:null}{item.kind==='text'?<Button role="menuitem" data-clipboard-action="edit" data-clipboard-id={item.id}>编辑副本（⌘E）</Button>:null}{document.documentElement.dataset.weborgReadonly!=='true'?<Button role="menuitem" data-clipboard-action="delete" data-clipboard-id={item.id}>删除记录（⌥⌫）</Button>:null}</>;})()}</div> : null}</div>
    <footer className="search-footer flex flex-wrap justify-between gap-2"><KeyboardHint selected={selected} scope={state?.scope}/><span id="actionStatus" role="status">{snapshot?.statusText}</span><span id="runtimeMode">{document.documentElement.dataset.weborgReadonly==='true'?'只读预览':'FlowHub'}</span></footer>
  </div>;
}
const mounted = new WeakMap<HTMLElement,Root>();
export function mountSearch(root:HTMLElement) {
  mounted.get(root)?.unmount();
  const reactRoot=createRoot(root); mounted.set(root,reactRoot); reactRoot.render(<Search/>);
  return ()=>{if(mounted.get(root)===reactRoot){reactRoot.unmount();mounted.delete(root);}};
}
