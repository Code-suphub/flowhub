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
import { connectedOfficial, hasOfficialKey, isOfficialSource, officialSource } from './official';
import { InstallStatus } from './InstallStatus';
import { availableUpdates, compareVersions } from './versions';
import { useMarketNavigation } from './useMarketNavigation';
import { api, available, installCandidate, openPlugin, refreshNavigation, type Candidate, type Installed, type InstallProgress, type Manifest, type Source } from './api';
import './market.css';

type Confirmation = { title:string; detail:string; warning?:string; install?:boolean; action:()=>Promise<void> };
const names = new Intl.Collator('zh-CN');
const candidateKey=(item:Candidate)=>JSON.stringify([item.source,item.manifest.id,item.manifest.version]);
const capabilities=[{value:'all',label:'全部功能'},{value:'searchable',label:'搜索入口'},{value:'widget',label:'桌面组件'},{value:'statusSurface',label:'状态面板'}] as const;
function MarketEmpty({title,description,children}: {title:string;description:string;children?:React.ReactNode}) {
  return <Empty className="fh-market-empty"><EmptyHeader><EmptyMedia variant="icon"><SearchIcon aria-hidden="true"/></EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader>{children?<EmptyContent className="flex-row flex-wrap justify-center">{children}</EmptyContent>:null}</Empty>;
}

export function Market() {
  const [view,setView]=useState('discover'), [installed,setInstalled]=useState<Installed[]>([]), [sources,setSources]=useState<Source[]>([]), [found,setFound]=useState<Candidate[]>([]);
  const [query,setQuery]=useState(''), [notice,setNotice]=useState(''), [noticeError,setNoticeError]=useState(false), [operation,setOperation]=useState('');
  const [loaded,setLoaded]=useState(!available), [sourcesOpen,setSourcesOpen]=useState(false), [sourceStates,setSourceStates]=useState<Record<string,SourceState>>({});
  const [confirmation,setConfirmation]=useState<Confirmation|null>(null), [pages,setPages]=useState<Record<string,{key:string;limit:number}>>({});
  const [capability,setCapability]=useState('all'), [sourceFilter,setSourceFilter]=useState('all'), [details,setDetails]=useState<Candidate|null>(null);
  const [installedFilter,setInstalledFilter]=useState('all'), [progress,setProgress]=useState<InstallProgress|null>(null), [completed,setCompleted]=useState<{id:string;name:string}|null>(null), [checkedAt,setCheckedAt]=useState<number|null>(null);
  const root=useRef<HTMLElement>(null), lock=useRef(false), alive=useRef(true), focusAfterInstall=useRef(false);
  const detailOrigin=useRef<{context:string;key:string}|null>(null), manageTarget=useRef<string|null>(null);
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
    lock.current=true;setOperation(kind);setNotice('');setNoticeError(false);setCompleted(null);
    let actionDone=false;
    try {await action();actionDone=true;if(alive.current && reload)await refresh();return true;}
    catch(error){if(alive.current){setNotice(actionDone && reload?`操作已完成，但刷新界面失败：${String(error)}。请重新加载列表。`:String(error));setNoticeError(true);}return false;}
    finally {
      lock.current=false;
      if(alive.current){
        setOperation('');setProgress(null);
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
    if(alive.current)setCheckedAt(Date.now());
  }
  const initialize=()=>run(async()=>{const catalog=await refresh(false);if(alive.current){setOperation('scan');await scan(catalog);}},false,'load');
  useEffect(()=>{alive.current=true;if(available)void initialize();return()=>{alive.current=false;};},[]);

  function install(manifest:Manifest,action:()=>Promise<unknown>,sourceName?:string) {
    const previous=installed.find(item=>item.manifest.id===manifest.id);
    const relation=previous?compareVersions(manifest.version,previous.manifest.version):null;
    setNotice('');setNoticeError(false);setProgress(null);
    const warning=`将在本机运行插件进程，可访问当前用户文件和网络。${manifest.permissions?.includes('system-service-control')?'该插件可请求安装常驻系统服务。管理员授权后，已核验的采集插件可以读取进程资源、结束所选第三方 root 进程，并暂停或恢复明确确认的第三方后台服务。停止后台服务可能中断连接、同步和服务管理的子进程；不改变永久自启配置。系统核心服务、宿主和采集器自身受保护。更新后可能需重新授权，安装、升级和卸载由 macOS 认证。':manifest.permissions?.includes('system-process-control')?'该插件可请求安装常驻系统进程服务。管理员授权升级后，已核验的采集插件可以结束你确认选择的第三方 root 进程；系统核心进程、宿主和采集器本身继续受保护，不执行任意管理员命令。升级宿主或采集插件后可能需要重新授权。安装、升级和卸载均由 macOS 认证。':manifest.permissions?.includes('system-process-monitor')?'该插件还可请求安装以 root 身份运行的系统级只读采集服务；启用后会读取所有用户进程的 PID、名称、路径、UID、父进程、RSS、内存足迹和 CPU 时间，不读取命令行或环境变量，也不能结束进程。安装和卸载服务时，macOS 会请求管理员认证。':''}仅安装可信来源的插件。${previous?'更新或回退会保留插件数据与启停状态。':''}`;
    setConfirmation({title:previous?(relation===0?'重新安装插件':relation===1?'更新插件':relation===-1?'回退插件版本':'更换插件版本'):'安装插件',detail:`${manifest.name} · v${manifest.version}${previous?`（当前已安装 v${previous.manifest.version}）`:''}${sourceName?` · 来源：${sourceName}`:''}`,warning,install:true,action:async()=>{
      setProgress({phase:'preparing'});
      await action();if(!alive.current)return;
      setView('installed');setInstalledFilter('all');setQuery('');setNotice(`${previous?'已更换':'已安装'} ${manifest.name} 至 v${manifest.version}。${previous && !previous.enabled?'插件保持停用，可在列表中启用。':'可从插件栏或下方按钮打开。'}`);setCompleted({id:manifest.id,name:manifest.name});focusAfterInstall.current=true;
    }});
  }
  const installFromCatalog=(item:Candidate)=>install(item.manifest,()=>installCandidate(item.token,value=>{if(alive.current)setProgress(value);}),sources.find(source=>source.id===item.source)?.name);
  const installLocal=(expectedId?:string)=>void run(async()=>{const selected=await api<{manifest:Manifest;directory:string}|null>('choose');if(selected && alive.current){if(expectedId && selected.manifest.id!==expectedId)throw Error('选择的目录属于其他插件，请选择当前插件的新目录。');install(selected.manifest,()=>api('install',{directory:selected.directory}),'本地目录');}},false);
  const updateFromDirectory=(item:Installed)=>void run(async()=>{
    let candidate:Installed;
    try{candidate=await api<Installed>('inspect',{directory:item.directory});}
    catch(error){throw Error(`无法读取原安装目录，请先完成构建；目录已移动时可在管理菜单选择“更换安装目录”。${String(error)}`);}
    if(candidate.manifest.id!==item.manifest.id)throw Error('原目录的插件 ID 已变化，未更新当前插件。');
    const permissions=candidate.manifest.permissions || [];
    const addedPermissions=permissions.some(permission=>!item.manifest.permissions?.includes(permission));
    const downgrade=compareVersions(candidate.manifest.version,item.manifest.version)===-1;
    const payload={id:item.manifest.id,expectedManifest:candidate.manifest,...(addedPermissions?{confirmedPermissions:permissions}:{})};
    const apply=async()=>{try{return await api('reload',payload);}catch(error){await refresh().catch(()=>{});throw error;}};
    if(addedPermissions || downgrade){install(candidate.manifest,apply,'原安装目录');return;}
    await apply();
    if(alive.current){setNotice(`已从原安装目录更新 ${candidate.manifest.name} 至 v${candidate.manifest.version}。${item.enabled?'已重新启动插件。':'插件保持停用。'}`);setCompleted({id:item.manifest.id,name:candidate.manifest.name});}
  });
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
    setFound([]);setDetails(null);setSourceStates({});
    try {
      const existing=catalog.filter(source=>source.kind==='https' && source.location===officialSource.location);
      if(existing.some(source=>!hasOfficialKey(source.key)))throw Error('官方库地址已有不同公钥，请在来源设置中检查。');
      if(!connectedOfficial(catalog))catalog=await api<Source[]>('saveSource',{...officialSource});
    } finally {
      // Any successful save invalidates ALL tokens, including custom sources.
      // Recover from partial writes before unlocking install actions.
      if(alive.current){catalog=await api<Source[]>('sources');setSources(catalog);setOperation('scan');await scan(catalog);}
    }
    setNotice('统一官方库已连接，已检查适用于当前设备的公开稳定版本。现有来源保留，安装与更新需要单独确认。');
  },false,'connect');
  const sourcesById=useMemo(()=>new Map(sources.map(source=>[source.id,source])),[sources]);
  const installedById=useMemo(()=>new Map(installed.map(plugin=>[plugin.manifest.id,plugin])),[installed]);
  const catalogIndex=useMemo(()=>{
    const rank=new Map(sources.map((source,index)=>[source.id,index]));
    const aggregate=(id:string)=>sourcesById.get(id)?.location===officialSource.location && isOfficialSource(sourcesById.get(id));
    return [...found].sort((a,b)=>Number(aggregate(b.source))-Number(aggregate(a.source)) || (rank.get(a.source)??0)-(rank.get(b.source)??0) || names.compare(a.manifest.name,b.manifest.name) || names.compare(a.manifest.id,b.manifest.id))
      .map(item=>({item,text:[item.manifest.name,item.manifest.id,item.manifest.description,sourcesById.get(item.source)?.name].join(' ').toLocaleLowerCase()}));
  },[found,sources,sourcesById]);
  const installedIndex=useMemo(()=>installed.map(item=>({item,text:[item.manifest.name,item.manifest.id,item.manifest.description].join(' ').toLocaleLowerCase()})),[installed]);
  const needle=query.trim().toLocaleLowerCase();
  const selectedSource=sources.some(source=>source.id===sourceFilter)?sourceFilter:'all';
  const seen=new Set<string>();
  const candidates=catalogIndex.filter(({item,text})=>text.includes(needle) && (selectedSource==='all' || item.source===selectedSource) && (capability==='all' || Boolean(item.manifest[capability as keyof Manifest]))).map(entry=>entry.item).filter(item=>{const key=JSON.stringify([item.manifest.id,item.manifest.version]);if(seen.has(key))return false;seen.add(key);return true;});
  const updates=useMemo(()=>{
    const result=new Map<string,Candidate>();
    for(const item of installed){
      if(item.origin?.kind==='directory')continue;
      const candidates=catalogIndex.map(entry=>entry.item).filter(candidate=>!item.origin?.source || candidate.source===item.origin.source);
      const update=availableUpdates([item],candidates).get(item.manifest.id);if(update)result.set(item.manifest.id,update);
    }
    return result;
  },[installed,catalogIndex]);
  const plugins=installedIndex.filter(entry=>entry.text.includes(needle) && (installedFilter!=='updates' || updates.has(entry.item.manifest.id))).map(entry=>entry.item);
  const issues=sources.filter(source=>sourceStates[source.id]?.error || sourceStates[source.id]?.warnings?.length);
  const items=view==='discover'?candidates:plugins, pageKey=JSON.stringify([view,query,view==='discover'?selectedSource:null,view==='discover'?capability:installedFilter]), limit=pages[view]?.key===pageKey?pages[view].limit:24;
  const reveal=(limit:number)=>setPages(old=>({...old,[view]:{key:pageKey,limit}}));
  const navigation=useMarketNavigation({view,context:pageKey,keys:view==='discover'?candidates.map(candidateKey):plugins.map(item=>item.manifest.id),limit,onReveal:reveal});
  const noResults=loaded && !items.length, searched=Boolean(query.trim()), filtered=capability!=='all' || selectedSource!=='all';
  const hasOfficial=connectedOfficial(sources);
  const detailItem=details?found.find(item=>candidateKey(item)===candidateKey(details)):undefined;
  const showDetails=(item:Candidate)=>{detailOrigin.current={context:pageKey,key:view==='discover'?candidateKey(item):item.manifest.id};setDetails(item);};
  useEffect(()=>{
    if(details && !detailItem)setDetails(null);
    if(!details && !confirmation && detailOrigin.current){const origin=detailOrigin.current;detailOrigin.current=null;navigation.restore(origin);}
  },[details,detailItem,confirmation]);
  useEffect(()=>{if(view==='installed' && manageTarget.current){const index=plugins.findIndex(item=>item.manifest.id===manageTarget.current);if(index>=0){manageTarget.current=null;navigation.focusAt(index,false);}}},[view,query,plugins.map(item=>item.manifest.id).join('\0')]);
  const manage=(manifest:Manifest)=>{manageTarget.current=manifest.id;setDetails(null);setView('installed');setInstalledFilter('all');setQuery(manifest.name);};
  const sourcesButton=<Button size="sm" disabled={!loaded} onClick={()=>setSourcesOpen(true)}><SlidersHorizontalIcon data-icon="inline-start"/>来源设置</Button>;
  return <main ref={root} className={`fh-root fh-market${embedded?' fh-market-embedded':''}`} aria-busy={busy}>
    <header className="fh-market-toolbar">{!embedded?<div className="market-heading"><h1>插件市场</h1>{!available?<Badge variant="outline">只读预览</Badge>:null}</div>:<span/>}<div className="market-toolbar-actions">{sourcesButton}{available?<ActionMenu label="插件市场更多操作" icon={<MoreHorizontalIcon/>} disabled={busy} popupClassName="fh-market-menu" items={[{id:'local',label:'安装本地插件',onSelect:installLocal}]}/>:null}</div></header>
    <div className="market-navigation"><Tabs items={[{id:'discover',label:'发现'},{id:'installed',label:`已安装 (${installed.length})`}]} value={view} onChange={setView} label="插件市场"/>
      <div className="market-search"><label className="sr-only" htmlFor="market-query">搜索插件</label><SearchIcon aria-hidden="true"/><Input id="market-query" type="search" aria-label="搜索插件" aria-describedby="market-browse-hint" placeholder={view==='discover'?'搜索插件名称、功能或来源':'搜索已安装插件'} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={navigation.searchKeyDown}/></div>
    </div>
    {notice?<Alert role={noticeError?'alert':'status'} variant={noticeError?'destructive':'default'}><AlertTitle>{noticeError?'操作未完成':'操作完成'}</AlertTitle><AlertDescription>{notice}{completed && installedById.get(completed.id)?.enabled?<Button size="sm" onClick={()=>void run(()=>openPlugin(completed.id),false)}>打开 {completed.name}</Button>:null}{noticeError && !confirmation?<Button size="sm" onClick={()=>void initialize()}>重新加载列表</Button>:null}</AlertDescription></Alert>:null}
    {issues.length?<Alert variant="warning"><AlertTitle>{issues.length} 个来源需要处理</AlertTitle><AlertDescription>可用来源的插件仍会显示。<Button size="sm" variant="ghost" onClick={()=>setSourcesOpen(true)}>查看来源问题</Button></AlertDescription></Alert>:null}
    <section className="fh-market-panel" id={`panel-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`}>
      {view==='discover' && loaded && !hasOfficial && !searched && !filtered?<OfficialCollection available={available} disabled={disabled} onConnect={connectOfficial}/>:null}
      {view==='discover' && sources.length?<div className="market-filters"><Select label="按功能筛选" value={capability} options={capabilities} onChange={setCapability}/><Select label="按来源筛选" value={selectedSource} options={[{value:'all',label:'全部来源'},...sources.map(source=>({value:source.id,label:source.name}))]} onChange={setSourceFilter}/>{filtered?<Button variant="ghost" size="sm" onClick={()=>{setCapability('all');setSourceFilter('all');}}>重置筛选</Button>:null}</div>:null}
      {view==='installed'?<div className="market-filters"><Select label="安装状态筛选" value={installedFilter} options={[{value:'all',label:'全部已安装'},{value:'updates',label:`可更新 (${updates.size})`}]} onChange={setInstalledFilter}/>{checkedAt?<p className="market-meta">{issues.length?'部分来源未完成检查':'最近检查'} · {new Date(checkedAt).toLocaleTimeString()}</p>:null}</div>:null}
      <div className="market-results-heading"><p className="market-meta" role={busy?'status':undefined}>{!loaded?'正在读取插件…':view==='discover'?`${candidates.length} 个插件 · ${sources.length} 个来源${operation==='scan'?' · 正在刷新…':''}`:`${plugins.length} 个插件 · ${plugins.filter(item=>item.enabled).length} 个已启用${updates.size?` · ${updates.size} 个可更新`:''}`}</p>{available && loaded && (sources.length || view==='installed')?<Button size="sm" variant="ghost" disabled={disabled} onClick={()=>sources.length?void run(()=>scan(sources),false,'scan'):connectOfficial()}><RefreshCwIcon data-icon="inline-start" className={operation==='scan'?'motion-safe:animate-spin':undefined}/>{operation==='scan'?'刷新中…':view==='installed'?(sources.length?'检查更新':'连接官方库'):'刷新插件'}</Button>:null}</div>
      {!loaded && !busy?<MarketEmpty title="插件列表暂不可用" description="请重新加载后再试。"><Button onClick={()=>void initialize()}>重新加载</Button></MarketEmpty>:null}
      {!loaded && busy?<MarketEmpty title="正在读取插件…" description="稍后即可浏览和管理插件。"/>:null}
      <p id="market-browse-hint" className="market-browse-hint market-meta">↓ 进入结果 · 方向键浏览 · {view==='discover'?'Enter 查看详情':'Enter 查看详情或进入操作'} · Esc 返回搜索<span className="sr-only">；Tab 访问当前插件操作，Home／End 到当前页首尾，Page Up／Down 翻页。</span></p>
      {view==='discover'?<div ref={navigation.list} onBlurCapture={navigation.blur} className="market-catalog-grid">{candidates.slice(0,limit).map(item=><CatalogCard key={candidateKey(item)} navigation={navigation.item(candidateKey(item),()=>showDetails(item))} item={item} sourceName={sourcesById.get(item.source)?.name || '未知来源'} official={isOfficialSource(sourcesById.get(item.source))} installed={installedById.get(item.manifest.id)} disabled={disabled} onDetails={()=>showDetails(item)} onInstall={()=>installFromCatalog(item)} onManage={()=>manage(item.manifest)}/>)}</div>:<div ref={navigation.list} onBlurCapture={navigation.blur} className="market-installed-list">{plugins.slice(0,limit).map(item=>{
        const update=updates.get(item.manifest.id), detail=update || catalogIndex.find(entry=>entry.item.manifest.id===item.manifest.id)?.item;
        const directoryUpdate=item.origin?.kind==='directory' || (!item.origin && !update);
        return <InstalledRow key={item.manifest.id} navigation={navigation.item(item.manifest.id,()=>{if(detail)showDetails(detail);else navigation.focusActions(item.manifest.id);})} item={item} update={update} sourceName={item.origin?.source?sourcesById.get(item.origin.source)?.name:undefined} canUpdate={directoryUpdate || Boolean(update)} disabled={disabled} onOpen={()=>void run(()=>openPlugin(item.manifest.id),false)} onDetails={detail?()=>showDetails(detail):undefined} onUpdate={()=>{if(directoryUpdate)updateFromDirectory(item);else if(update)installFromCatalog(update);}} onToggle={()=>void run(async()=>{await api('enable',{id:item.manifest.id,enabled:!item.enabled});setNotice(item.enabled?`已停用 ${item.manifest.name}`:`已启用 ${item.manifest.name}`);})} onChooseDirectory={()=>installLocal(item.manifest.id)} onUninstall={()=>{setNotice('');setNoticeError(false);setConfirmation({title:'卸载插件',detail:`确认卸载 ${item.manifest.name}？将停止插件进程并移除入口，插件配置与历史数据保留。`,action:async()=>{await api('uninstall',{id:item.manifest.id});setNotice(`已卸载 ${item.manifest.name}，配置与历史数据保留。`);}});}}/>;
      })}</div>}
      {noResults ? operation==='scan' && view==='discover'?<MarketEmpty title="正在查找插件…" description="正在读取已配置的插件来源。"/>:searched || (view==='discover' && filtered)?<MarketEmpty title="没有匹配的插件" description="试试其他关键词，或放宽筛选条件。"><Button size="sm" onClick={()=>{setCapability('all');setSourceFilter('all');setInstalledFilter('all');clearSearch();}}>清除搜索与筛选</Button></MarketEmpty>:view==='installed' && installedFilter==='updates'?<MarketEmpty title={busy?'正在检查更新…':issues.length?'部分来源未完成检查':'暂无可用更新'} description={issues.length?'修复来源问题后重试，当前检查尚不完整。':'仅比较已连接来源中适用于当前设备的版本。'}><Button size="sm" onClick={()=>setInstalledFilter('all')}>查看全部已安装</Button></MarketEmpty>:view==='installed'?<MarketEmpty title="尚未安装插件" description="在发现中选择需要的插件，安装后会显示在这里。"><Button size="sm" onClick={()=>setView('discover')}>发现插件</Button></MarketEmpty>:!sources.length?<div className="market-custom-source"><p className="market-meta">{available?'已有其他插件库或本地开发插件？':'在桌面 App 中连接插件库后，即可浏览和安装。'}</p>{available?<><Button size="sm" onClick={()=>setSourcesOpen(true)}>添加来源</Button><Button size="sm" variant="ghost" onClick={()=>installLocal()}><FolderPlusIcon data-icon="inline-start"/>安装本地插件</Button></>:null}</div>:<MarketEmpty title={issues.length?'暂时没有可用插件':'来源中暂无可安装插件'} description={issues.length?'查看来源问题，处理后可以重新刷新。':'检查来源是否包含适用于当前设备的插件。'}><Button size="sm" onClick={()=>setSourcesOpen(true)}>检查来源</Button></MarketEmpty>:null}
      {items.length>limit?<div className="market-more-results"><span className="market-meta">已显示 {limit} / {items.length}</span><Button size="sm" onClick={()=>navigation.focusAt(limit)}>显示更多</Button></div>:null}
    </section>
    {detailItem?<PluginDetails item={detailItem} source={sourcesById.get(detailItem.source)} installed={installedById.get(detailItem.manifest.id)} disabled={disabled} onClose={()=>setDetails(null)} onManage={()=>manage(detailItem.manifest)} onInstall={()=>{setDetails(null);installFromCatalog(detailItem);}}/>:null}
    {sourcesOpen?<SourceDialog sources={sources} states={sourceStates} available={available} busy={busy} locking={busy && operation!=='scan'} error={noticeError?notice:''} onClose={()=>setSourcesOpen(false)} onScan={source=>void run(()=>scan([source]),false,'scan')} onSave={source=>changeSources('saveSource',{...source},'来源已保存，插件列表已刷新。')} onRemove={source=>changeSources('removeSource',{id:source.id},'来源已移除，已安装插件保留。')} onChoose={async()=>{let selected:string|null=null;await run(async()=>{selected=await api<string|null>('chooseSource');},false);return selected;}}/>:null}
    {confirmation?<Dialog className="fh-market-dialog" notice={noticeError?notice:undefined} title={confirmation.title} busy={busy} onClose={()=>setConfirmation(null)}><p>{confirmation.detail}</p>{confirmation.warning?<Alert variant="warning"><AlertTitle>运行权限提醒</AlertTitle><AlertDescription>{confirmation.warning}</AlertDescription></Alert>:null}{progress?<InstallStatus progress={progress}/>:null}<div className="flex flex-wrap justify-end gap-2 mt-4">{noticeError && confirmation.install?<Button disabled={busy} onClick={()=>void run(async()=>{const catalog=await refresh(false);await scan(catalog);setConfirmation(null);setNotice('目录已重新读取，请再次核对插件版本后安装。');},false,'scan')}>刷新目录</Button>:null}<Button disabled={busy} onClick={()=>setConfirmation(null)}>取消</Button><Button variant={confirmation.install?'default':'destructive'} disabled={busy} onClick={()=>void run(async()=>{await confirmation.action();if(alive.current)setConfirmation(null);})}>{busy && confirmation.install?'正在安装…':noticeError && confirmation.install?'重试安装':'确认'}</Button></div></Dialog>:null}
  </main>;
}
