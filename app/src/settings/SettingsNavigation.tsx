import { useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { ChevronDownIcon, SearchIcon, XIcon } from 'lucide-react';
import { FeatureIcon, FlowHubLogo, type IconTone } from '../shared/FeatureIcon';
import { Button, Input } from '../shared/ui';
import { matchingNavigation, type PageId } from './navigation';
import { useViewMemory, useViewScroll, useViewState } from './view-state';
import { scrollElementWithin } from '../shared/scroll';
const tones:Record<string,IconTone>={search:'sky',menubar:'blue',core:'slate',web:'blue',app:'blue',clipboard:'orange',memo:'amber',tools:'teal',canvas:'green',data:'teal',updates:'blue'};

export function Navigation({page,busy,preview,installedCount,useGlobalSearch=false,onNavigate}: {page:PageId;busy:boolean;preview:boolean;installedCount:number;useGlobalSearch?:boolean;onNavigate:(id:string)=>boolean}) {
  const [query,setQuery]=useViewState('navigation:query',''), memory=useViewMemory();
  const [collapsed,setCollapsed]=useViewState<Partial<Record<string,boolean>>>('navigation:collapsed',{});
  const revealGroup=useRef<string | undefined>(undefined);
  const groupId=useId();
  const scroll=useViewScroll('navigation:scroll');
  useLayoutEffect(()=>{
    const pane=scroll.ref.current,current=pane?.querySelector<HTMLElement>('[aria-current="page"],[data-current-group]');
    if(pane && revealGroup.current){
      const last=document.getElementById(`${groupId}-${revealGroup.current}`)?.lastElementChild;
      revealGroup.current=undefined;
      if(last instanceof HTMLElement)scrollElementWithin(pane,last);
    }
    if(memory?.get('navigation:page')!==page && pane && current){scrollElementWithin(pane,current);memory?.set('navigation:page',page);}
  },[page,memory,collapsed,groupId,scroll.ref]);
  const groups=matchingNavigation(useGlobalSearch ? '' : query),matches=groups.flatMap(group=>group.items);
  const go=(id:string)=>{if(onNavigate(id))setQuery('');};
  function move(event:KeyboardEvent<HTMLElement>) {
    if(event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.nativeEvent.isComposing)return;
    if(!(event.target instanceof HTMLElement) || !event.target.matches('button[data-page],button[data-nav-group]'))return;
    const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:is([data-page],[data-nav-group]):not(:disabled)')].filter(button=>!button.closest('[hidden]')),index=items.indexOf(event.target as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?Math.min(index+1,items.length-1):event.key==='ArrowUp'?Math.max(index-1,0):-1;
    if(next<0)return;event.preventDefault();const target=items[next];
    target?.focus({preventScroll:true});if(scroll.ref.current && target)scrollElementWithin(scroll.ref.current,target);
  }
  return <nav className="settings-sidebar flex flex-col" aria-label="设置模块" onKeyDown={move}>
    <div className="settings-brand"><FlowHubLogo/>FlowHub</div>
    {!useGlobalSearch && <div className="settings-navigation-search"><SearchIcon aria-hidden="true"/><Input aria-label="查找页面" type="search" placeholder="查找页面…" value={query} disabled={busy} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{
      if(event.nativeEvent.isComposing || event.nativeEvent.keyCode===229)return;
      if(event.key==='Escape' && query){event.preventDefault();event.stopPropagation();setQuery('');}
      if(event.key==='Enter' && matches.length===1){event.preventDefault();go(matches[0].id);}
    }}/>{query?<Button size="icon-xs" variant="ghost" aria-label="清除页面查找" onClick={()=>setQuery('')}><XIcon/></Button>:null}</div>}
    <div ref={scroll.ref} onScroll={scroll.onScroll} className="settings-navigation-scroll">
      {groups.map(group=>{
        const id=`${groupId}-${group.id}`;
        const expanded=Boolean(query.trim()) || !collapsed[group.id];
        const current=expanded ? undefined : group.items.find(item=>item.id===page);
        return <div className="settings-nav-group" key={group.id}>
          <Button id={`${id}-label`} data-nav-group={group.id} data-current-group={current ? '' : undefined}
            aria-controls={id} aria-expanded={expanded} aria-disabled={Boolean(query.trim()) || undefined} onClick={()=>{
              if(query.trim())return;
              revealGroup.current=expanded ? undefined : group.id;
              setCollapsed({...collapsed,[group.id]:expanded});
            }}>
            <span>{group.label}{current ? ` · ${current.label}` : ''}</span><ChevronDownIcon aria-hidden="true"/>
          </Button>
          <div id={id} role="group" aria-labelledby={`${id}-label`} className="settings-nav-items" hidden={!expanded}>
            {group.items.map(({id,label,Icon})=><Button key={id} data-page={id} aria-current={page===id?'page':undefined} disabled={busy} onClick={()=>go(id)}>
              {useGlobalSearch ? <Icon aria-hidden="true" /> : <FeatureIcon icon={Icon} tone={tones[id]} size="small"/>}
              {label}{id==='plugins-installed' && !preview && <span className="settings-plugin-count">{installedCount}</span>}
            </Button>)}
          </div>
        </div>;
      })}
      {!matches.length?<div className="settings-navigation-empty"><p role="status">没有匹配页面，试试“快捷键”或“备份”。</p><Button variant="ghost" size="sm" onClick={()=>{setQuery('');document.querySelector<HTMLInputElement>('[aria-label="查找页面"]')?.focus();}}>显示全部页面</Button></div>:null}
    </div>
    {!useGlobalSearch && <div className="settings-sidebar-bottom"><span className="settings-local-status"><i/>{preview?'浏览器预览 · 不会保存配置':'本地工作空间'}</span></div>}
  </nav>;
}
