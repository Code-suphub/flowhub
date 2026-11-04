import { useLayoutEffect, type KeyboardEvent } from 'react';
import { Layers2Icon, PuzzleIcon, SearchIcon, SquareArrowOutUpRightIcon, XIcon } from 'lucide-react';
import { Button, Input } from '../shared/ui';
import { Tooltip } from '../shared/controls';
import { matchingNavigation, type PageId } from './navigation';
import { useViewMemory, useViewScroll, useViewState } from './view-state';

export function Navigation({page,busy,preview,onNavigate}: {page:PageId;busy:boolean;preview:boolean;onNavigate:(id:string)=>boolean}) {
  const [query,setQuery]=useViewState('navigation:query',''), memory=useViewMemory();
  const scroll=useViewScroll('navigation:scroll');
  useLayoutEffect(()=>{
    if(memory?.get('navigation:page')!==page)scroll.ref.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({block:'nearest'});
    memory?.set('navigation:page',page);
  },[page,memory,scroll.ref]);
  const groups=matchingNavigation(query),matches=groups.flatMap(group=>group.items);
  const go=(id:string)=>{if(onNavigate(id))setQuery('');};
  function move(event:KeyboardEvent<HTMLElement>) {
    if(event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.nativeEvent.isComposing)return;
    if(!(event.target instanceof HTMLElement) || !event.target.matches('button[data-page]'))return;
    const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-page]:not(:disabled)')],index=items.indexOf(event.target as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?Math.min(index+1,items.length-1):event.key==='ArrowUp'?Math.max(index-1,0):-1;
    if(next<0)return;event.preventDefault();items[next]?.focus();items[next]?.scrollIntoView?.({block:'nearest'});
  }
  return <nav className="settings-sidebar flex flex-col" aria-label="设置模块" onKeyDown={move}>
    <div className="settings-brand"><span><Layers2Icon aria-hidden="true"/></span>FlowHub</div>
    <div className="settings-navigation-search"><SearchIcon aria-hidden="true"/><Input aria-label="查找页面" type="search" placeholder="查找页面…" value={query} disabled={busy} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{
      if(event.nativeEvent.isComposing || event.nativeEvent.keyCode===229)return;
      if(event.key==='Escape' && query){event.preventDefault();event.stopPropagation();setQuery('');}
      if(event.key==='Enter' && matches.length===1){event.preventDefault();go(matches[0].id);}
    }}/>{query?<Button size="icon-xs" variant="ghost" aria-label="清除页面查找" onClick={()=>setQuery('')}><XIcon/></Button>:null}</div>
    <div ref={scroll.ref} onScroll={scroll.onScroll} className="settings-navigation-scroll">{groups.map(group=><div className="settings-nav-group flex flex-col" key={group.label}><span className="settings-nav-heading">{group.label}</span>{group.items.map(({id,label,Icon})=><Button key={id} data-page={id} aria-current={page===id?'page':undefined} disabled={busy} onClick={()=>go(id)}><Icon data-icon="inline-start" aria-hidden="true"/>{label}</Button>)}</div>)}{!matches.length?<div className="settings-navigation-empty"><p role="status">没有匹配页面，试试“快捷键”或“备份”。</p><Button variant="ghost" size="sm" onClick={()=>{setQuery('');document.querySelector<HTMLInputElement>('[aria-label="查找页面"]')?.focus();}}>显示全部页面</Button></div>:null}</div>
    <div className="settings-sidebar-bottom"><Tooltip content="在独立插件工作区打开，当前页面的草稿会保留。"><Button aria-label="打开插件市场" disabled={busy} onClick={()=>go('extensions')}><PuzzleIcon data-icon="inline-start"/>插件市场<SquareArrowOutUpRightIcon className="settings-external-icon" aria-hidden="true"/></Button></Tooltip><span className="settings-local-status"><i/>{preview?'浏览器预览 · 不会保存配置':'本地工作空间'}</span></div>
  </nav>;
}
