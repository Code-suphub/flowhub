import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlusIcon, MoreHorizontalIcon, RefreshCwIcon, SearchIcon, SlidersHorizontalIcon } from 'lucide-react';
import { Button, Dialog, Input, Tabs } from '../shared/ui';
import { Select } from '../shared/controls';
import { ActionMenu } from '../shared/ActionMenu';
import { Badge } from '../components/ui/badge';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { CatalogCard, InstalledRow } from './PluginItems';
import { SourceDialog, type SourceState } from './SourceDialog';
import { OfficialCollection } from './OfficialCollection';
import { PluginDetails } from './PluginDetails';
import { hasOfficialKey, isOfficialSource, missingOfficialSources } from './official';
import { api, available, refreshNavigation, type Candidate, type Installed, type Manifest, type Source } from './api';
import './market.css';

type Confirmation = { title:string; detail:string; warning?:string; install?:boolean; action:()=>Promise<void> };
const names = new Intl.Collator('zh-CN');
const capabilities=[{value:'all',label:'全部功能'},{value:'searchable',label:'搜索入口'},{value:'widget',label:'桌面组件'},{value:'statusSurface',label:'状态面板'}] as const;
function MarketEmpty({title,description,children}: {title:string;description:string;children?:React.ReactNode}) {
  return <Empty className="fh-market-empty"><EmptyHeader><EmptyMedia variant="icon"><SearchIcon aria-hidden="true"/></EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader>{children?<EmptyContent className="flex-row flex-wrap justify-center">{children}</EmptyContent>:null}</Empty>;
}

export function Market() {
  const [view,setView]=useState('discover'), [installed,setInstalled]=useState<Installed[]>([]), [sources,setSources]=useState<Source[]>([]), [found,setFound]=useState<Candidate[]>([]);
  const [query,setQuery]=useState(''), [notice,setNotice]=useState(''), [noticeError,setNoticeError]=useState(false), [operation,setOperation]=useState('');
  const [loaded,setLoaded]=useState(!available), [sourcesOpen,setSourcesOpen]=useState(false), [sourceStates,setSourceStates]=useState<Record<string,SourceState>>({});
  const [confirmation,setConfirmation]=useState<Confirmation|null>(null), [page,setPage]=useState({key:'',limit:24});
  const [capability,setCapability]=useState('all'), [sourceFilter,setSourceFilter]=useState('all'), [details,setDetails]=useState<Candidate|null>(null);
  const root=useRef<HTMLElement>(null), lock=useRef(false), alive=useRef(true), focusAfterInstall=useRef(false);
  const busy=Boolean(operation), disabled=busy || !available;
  const embedded=typeof window!=='undefined' && window.parent!==window;

  async function refresh(notify=true) {
    const [plugins,catalog]=await Promise.all([api<Installed[]>('list'),api<Source[]>('sources')]);
    if(alive.current){setInstalled(plugins);setSources(catalog);setLoaded(true);if(notify)await refreshNavigation();}
    return catalog;
  }
  async function run(action:()=>Promise<void>,reload=true,kind='mutation') {
    if(lock.current || !available)return false;
    const origin=document.activeElement as HTMLElement|null;
    lock.current=true;setOperation(kind);setNotice('');setNoticeError(false);
    try {await action();if(alive.current && reload)await refresh();return true;}
    catch(error){if(alive.current){setNotice(String(error));setNoticeError(true);}return false;}
    finally {
      lock.current=false;
      if(alive.current){
        setOperation('');
        requestAnimationFrame(()=>{
          const installedTarget=focusAfterInstall.current;focusAfterInstall.current=false;
          if(!alive.current || !document.hasFocus())return;
          if(installedTarget && !document.querySelector('[role="dialog"]') && !document.activeElement?.closest('input,textarea,[contenteditable="true"]'))root.current?.querySelector<HTMLElement>('#tab-installed')?.focus();
          else if(origin?.isConnected && document.activeElement===document.body && !origin.matches(':disabled'))origin.focus({preventScroll:true});
        });
      }
    }
  }
  async function scan(list:Source[]) {
    const queue=list.slice();
    // Read independent sources concurrently, with a small bound. A failed
    // repository cannot hide the successful results from the other sources.
    await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{
      while(queue.length && alive.current){
        const source=queue.shift()!;
        setSourceStates(old=>({...old,[source.id]:{...old[source.id],loading:true,error:undefined}}));
        try {
          const result=await api<{plugins:Candidate[];warnings:string[]}>('scanSource',{id:source.id});
          if(!alive.current)return;
          setFound(old=>[...old.filter(item=>item.source!==source.id),...result.plugins]);
          setSourceStates(old=>({...old,[source.id]:{count:result.plugins.length,warnings:result.warnings}}));
        } catch(error) {
          if(!alive.current)return;
          setFound(old=>old.filter(item=>item.source!==source.id));
          setSourceStates(old=>({...old,[source.id]:{error:String(error)}}));
        }
      }
    }));
  }
  const initialize=()=>run(async()=>{const catalog=await refresh(false);if(alive.current){setOperation('scan');await scan(catalog);}},false,'load');
  useEffect(()=>{alive.current=true;if(available)void initialize();return()=>{alive.current=false;};},[]);

  function install(manifest:Manifest,action:()=>Promise<unknown>,sourceName?:string) {
    const previous=installed.find(item=>item.manifest.id===manifest.id);
    setConfirmation({title:previous?(previous.manifest.version===manifest.version?'重新安装插件':'更换插件版本'):'安装插件',detail:`${manifest.name} · v${manifest.version}${previous?`（当前已安装 v${previous.manifest.version}）`:''}${sourceName?` · 来源：${sourceName}`:''}`,warning:'将在本机运行插件进程，可访问当前用户文件和网络。仅安装可信来源的插件。',install:true,action:async()=>{
      await action();if(!alive.current)return;
      setView('installed');setQuery('');setNotice(`已安装 ${manifest.name}，入口已加入插件栏。`);focusAfterInstall.current=true;
    }});
  }
  const installLocal=()=>void run(async()=>{const selected=await api<{manifest:Manifest;directory:string}|null>('choose');if(selected && alive.current)install(selected.manifest,()=>api('install',{directory:selected.directory}),'本地目录');},false);
  const clearSearch=()=>{setQuery('');root.current?.querySelector<HTMLInputElement>('#market-query')?.focus({preventScroll:true});};
  const changeSources=(action:'saveSource'|'removeSource',payload:Record<string,unknown>,message:string)=>run(async()=>{
    const catalog=await api<Source[]>(action,payload);
    if(!alive.current)return;
    // The native source API invalidates every candidate token after a source
    // change. Refresh all sources so no stale install buttons remain usable.
    setSources(catalog);setFound([]);setDetails(null);setSourceStates({});setOperation('scan');await scan(catalog);setNotice(message);
  },false);
  const connectOfficial=()=>void run(async()=>{
    // Re-read before adding: another window may have changed the source list.
    let catalog=await api<Source[]>('sources');
    const missing=missingOfficialSources(catalog), errors:string[]=[];
    setFound([]);setDetails(null);setSourceStates({});
    try {
      for(const preset of missing){
        const existing=catalog.filter(source=>source.kind==='https' && source.location===preset.location);
        if(existing.some(source=>!hasOfficialKey(source.key))){errors.push(`${preset.name}：已有来源使用不同公钥，请在来源设置中检查。`);continue;}
        try {catalog=await api<Source[]>('saveSource',{...preset});}
        catch(error){errors.push(`${preset.name}：${String(error)}`);}
      }
    } finally {
      // Any successful save invalidates ALL tokens, including custom sources.
      // Recover from partial writes before unlocking install actions.
      if(alive.current){catalog=await api<Source[]>('sources');setSources(catalog);setOperation('scan');await scan(catalog);}
    }
    if(errors.length)throw new Error(`部分官方来源未连接，已成功添加的来源会保留。\n${errors.join('\n')}`);
    setNotice('官方库已连接，可按需安装。目录固定到当前公开版本，刷新不会自动升级插件。');
  },false,'connect');
  const sourcesById=useMemo(()=>new Map(sources.map(source=>[source.id,source])),[sources]);
  const installedById=useMemo(()=>new Map(installed.map(plugin=>[plugin.manifest.id,plugin])),[installed]);
  const catalogIndex=useMemo(()=>{
    const rank=new Map(sources.map((source,index)=>[source.id,index]));
    return [...found].sort((a,b)=>(rank.get(a.source)??0)-(rank.get(b.source)??0) || names.compare(a.manifest.name,b.manifest.name) || names.compare(a.manifest.id,b.manifest.id))
      .map(item=>({item,text:[item.manifest.name,item.manifest.id,item.manifest.description,sourcesById.get(item.source)?.name].join(' ').toLocaleLowerCase()}));
  },[found,sources,sourcesById]);
  const installedIndex=useMemo(()=>installed.map(item=>({item,text:[item.manifest.name,item.manifest.id,item.manifest.description].join(' ').toLocaleLowerCase()})),[installed]);
  const needle=query.trim().toLocaleLowerCase();
  const selectedSource=sources.some(source=>source.id===sourceFilter)?sourceFilter:'all';
  const candidates=catalogIndex.filter(({item,text})=>text.includes(needle) && (selectedSource==='all' || item.source===selectedSource) && (capability==='all' || Boolean(item.manifest[capability as keyof Manifest]))).map(entry=>entry.item);
  const plugins=installedIndex.filter(entry=>entry.text.includes(needle)).map(entry=>entry.item);
  const issues=sources.filter(source=>sourceStates[source.id]?.error || sourceStates[source.id]?.warnings?.length);
  const items=view==='discover'?candidates:plugins, pageKey=JSON.stringify([view,query,selectedSource,capability]), limit=page.key===pageKey?page.limit:24;
  const noResults=loaded && !items.length, searched=Boolean(query.trim()), filtered=capability!=='all' || selectedSource!=='all';
  const missingOfficial=missingOfficialSources(sources);
  const detailItem=details?found.find(item=>item.source===details.source && item.manifest.id===details.manifest.id):undefined;
  const manage=(manifest:Manifest)=>{setDetails(null);setView('installed');setQuery(manifest.name);};
  const sourcesButton=<Button size="sm" disabled={!loaded} onClick={()=>setSourcesOpen(true)}><SlidersHorizontalIcon data-icon="inline-start"/>来源设置</Button>;
  return <main ref={root} className={`fh-root fh-market${embedded?' fh-market-embedded':''}`} aria-busy={busy}>
    <header className="fh-market-toolbar">{!embedded?<div className="market-heading"><h1>插件市场</h1>{!available?<Badge variant="outline">只读预览</Badge>:null}</div>:<span/>}<div className="market-toolbar-actions">{sourcesButton}{available?<ActionMenu label="插件市场更多操作" icon={<MoreHorizontalIcon/>} disabled={busy} popupClassName="fh-market-menu" items={[{id:'local',label:'安装本地插件',onSelect:installLocal}]}/>:null}</div></header>
    <div className="market-navigation"><Tabs items={[{id:'discover',label:'发现'},{id:'installed',label:`已安装 (${installed.length})`}]} value={view} onChange={setView} label="插件市场"/>
      <div className="market-search"><label className="sr-only" htmlFor="market-query">搜索插件</label><SearchIcon aria-hidden="true"/><Input id="market-query" type="search" aria-label="搜索插件" placeholder={view==='discover'?'搜索插件名称、功能或来源':'搜索已安装插件'} value={query} onChange={e=>setQuery(e.target.value)}/></div>
    </div>
    {notice?<Alert role={noticeError?'alert':'status'} variant={noticeError?'destructive':'default'}><AlertTitle>{noticeError?'操作未完成':'操作完成'}</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>:null}
    {view==='discover' && issues.length?<Alert variant="warning"><AlertTitle>{issues.length} 个来源需要处理</AlertTitle><AlertDescription>可用来源的插件仍会显示。<Button size="sm" variant="ghost" onClick={()=>setSourcesOpen(true)}>查看来源问题</Button></AlertDescription></Alert>:null}
    <section className="fh-market-panel" id={`panel-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`}>
      {view==='discover' && loaded && missingOfficial.length && !searched && !filtered?<OfficialCollection available={available} disabled={disabled} missing={missingOfficial.length} onConnect={connectOfficial}/>:null}
      {view==='discover' && sources.length?<div className="market-filters"><Select label="按功能筛选" value={capability} options={capabilities} onChange={setCapability}/><Select label="按来源筛选" value={selectedSource} options={[{value:'all',label:'全部来源'},...sources.map(source=>({value:source.id,label:source.name}))]} onChange={setSourceFilter}/>{filtered?<Button variant="ghost" size="sm" onClick={()=>{setCapability('all');setSourceFilter('all');}}>重置筛选</Button>:null}</div>:null}
      <div className="market-results-heading"><p className="market-meta" role={busy?'status':undefined}>{!loaded?'正在读取插件…':view==='discover'?`${candidates.length} 个插件 · ${sources.length} 个来源${operation==='scan'?' · 正在刷新…':''}`:`${plugins.length} 个插件 · ${plugins.filter(item=>item.enabled).length} 个已启用`}</p>{view==='discover' && sources.length && available?<Button size="sm" variant="ghost" disabled={disabled} onClick={()=>void run(()=>scan(sources),false,'scan')}><RefreshCwIcon data-icon="inline-start" className={operation==='scan'?'motion-safe:animate-spin':undefined}/>{operation==='scan'?'刷新中…':'刷新插件'}</Button>:null}</div>
      {!loaded && !busy?<MarketEmpty title="插件列表暂不可用" description="请重新加载后再试。"><Button onClick={()=>void initialize()}>重新加载</Button></MarketEmpty>:null}
      {!loaded && busy?<MarketEmpty title="正在读取插件…" description="稍后即可浏览和管理插件。"/>:null}
      {view==='discover'?<div className="market-catalog-grid">{candidates.slice(0,limit).map(item=><CatalogCard key={`${item.source}:${item.token}`} item={item} sourceName={sourcesById.get(item.source)?.name || '未知来源'} official={isOfficialSource(sourcesById.get(item.source))} installed={installedById.get(item.manifest.id)} disabled={disabled} onDetails={()=>setDetails(item)} onInstall={()=>install(item.manifest,()=>api('installCandidate',{token:item.token}),sourcesById.get(item.source)?.name)} onManage={()=>manage(item.manifest)}/>)}</div>:<div className="market-installed-list">{plugins.slice(0,limit).map(item=><InstalledRow key={item.manifest.id} item={item} disabled={disabled} onToggle={()=>void run(async()=>{await api('enable',{id:item.manifest.id,enabled:!item.enabled});setNotice(item.enabled?`已停用 ${item.manifest.name}`:`已启用 ${item.manifest.name}`);})} onReload={()=>void run(async()=>{await api('reload',{id:item.manifest.id});setNotice('重新加载完成');})} onUninstall={()=>setConfirmation({title:'卸载插件',detail:`确认卸载 ${item.manifest.name}？`,action:async()=>{await api('uninstall',{id:item.manifest.id});setNotice(`已卸载 ${item.manifest.name}`);}})}/>)}</div>}
      {noResults ? operation==='scan' && view==='discover'?<MarketEmpty title="正在查找插件…" description="正在读取已配置的插件来源。"/>:searched || (view==='discover' && filtered)?<MarketEmpty title="没有匹配的插件" description="试试其他关键词，或放宽筛选条件。"><Button size="sm" onClick={()=>{setCapability('all');setSourceFilter('all');clearSearch();}}>清除搜索与筛选</Button></MarketEmpty>:view==='installed'?<MarketEmpty title="尚未安装插件" description="在发现中选择需要的插件，安装后会显示在这里。"><Button size="sm" onClick={()=>setView('discover')}>发现插件</Button></MarketEmpty>:!sources.length?<div className="market-custom-source"><p className="market-meta">{available?'已有其他插件库或本地开发插件？':'在桌面 App 中连接插件库后，即可浏览和安装。'}</p>{available?<><Button size="sm" onClick={()=>setSourcesOpen(true)}>添加来源</Button><Button size="sm" variant="ghost" onClick={installLocal}><FolderPlusIcon data-icon="inline-start"/>安装本地插件</Button></>:null}</div>:<MarketEmpty title={issues.length?'暂时没有可用插件':'来源中暂无可安装插件'} description={issues.length?'查看来源问题，处理后可以重新刷新。':'检查来源是否包含适用于当前设备的插件。'}><Button size="sm" onClick={()=>setSourcesOpen(true)}>检查来源</Button></MarketEmpty>:null}
      {items.length>limit?<div className="market-more-results"><span className="market-meta">已显示 {limit} / {items.length}</span><Button size="sm" onClick={()=>setPage({key:pageKey,limit:limit+24})}>显示更多</Button></div>:null}
    </section>
    {detailItem?<PluginDetails item={detailItem} source={sourcesById.get(detailItem.source)} installed={installedById.get(detailItem.manifest.id)} disabled={disabled} onClose={()=>setDetails(null)} onManage={()=>manage(detailItem.manifest)} onInstall={()=>{setDetails(null);install(detailItem.manifest,()=>api('installCandidate',{token:detailItem.token}),sourcesById.get(detailItem.source)?.name);}}/>:null}
    {sourcesOpen?<SourceDialog sources={sources} states={sourceStates} available={available} busy={busy} locking={busy && operation!=='scan'} error={noticeError?notice:''} onClose={()=>setSourcesOpen(false)} onScan={source=>void run(()=>scan([source]),false,'scan')} onSave={source=>changeSources('saveSource',{...source},'来源已保存，插件列表已刷新。')} onRemove={source=>changeSources('removeSource',{id:source.id},'来源已移除，已安装插件保留。')} onChoose={async()=>{let selected:string|null=null;await run(async()=>{selected=await api<string|null>('chooseSource');},false);return selected;}}/>:null}
    {confirmation?<Dialog className="fh-market-dialog" notice={noticeError?notice:undefined} title={confirmation.title} busy={busy} onClose={()=>setConfirmation(null)}><p>{confirmation.detail}</p>{confirmation.warning?<Alert variant="warning"><AlertTitle>运行权限提醒</AlertTitle><AlertDescription>{confirmation.warning}</AlertDescription></Alert>:null}<div className="flex justify-end gap-2 mt-4"><Button disabled={busy} onClick={()=>setConfirmation(null)}>取消</Button><Button variant={confirmation.install?'default':'destructive'} disabled={busy} onClick={()=>void run(async()=>{await confirmation.action();if(alive.current)setConfirmation(null);})}>确认</Button></div></Dialog>:null}
  </main>;
}
