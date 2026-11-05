import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CornerUpLeft, History, Trash2 } from 'lucide-react';
import { CommandDialog } from '../shared/CommandDialog';
import { CommandSearch } from '../shared/CommandSearch';
import { Button } from '../shared/ui';
import { Badge } from '../components/ui/badge';
import { getQueryHistory, matchingQueries, type QueryHistoryEntry } from './query-history';
import type { SearchSnapshot } from './types';
import './query-history.css';

export function QueryHistory({snapshot,onClose,onRecall}: {snapshot:SearchSnapshot;onClose():void;onRecall(entry:QueryHistoryEntry):void}) {
  const store=getQueryHistory(),entries=useSyncExternalStore(store.subscribe,store.snapshot,store.snapshot);
  const [query,setQuery]=useState(snapshot.state.query || ''),[clearing,setClearing]=useState(false),input=useRef<HTMLInputElement>(null);
  const highlighted=useRef<string|undefined>(undefined);
  const readonly=document.documentElement.dataset.weborgReadonly==='true';
  useEffect(()=>{store.refresh();const changed=(event:StorageEvent)=>{if(event.key===null || event.key==='flowhub.search.queryHistory.v1')store.refresh();};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[store]);
  const matches=useMemo(()=>matchingQueries(entries,query),[entries,query]);
  const scopeName=(entry:QueryHistoryEntry)=>entry.scope==='all'?'全部':snapshot.state.plugins.find((plugin:{id:string})=>plugin.id===entry.scope)?.name || '全部（原来源停用）';
  const historyState=readonly?'只读预览':snapshot.state.config?.core?.searchHistoryEnabled===false?'已暂停记录':store.sessionOnly()?'历史仅保留在当前会话':'仅保存在本机 · 最多 100 条';
  return <CommandDialog title="搜索历史与补全" initialFocus={input} onClose={onClose} className="query-history-dialog">
    <CommandSearch label="筛选搜索历史" placeholder="输入部分关键词，选择完整查询回填…" listLabel="历史查询" clearLabel="清除历史筛选" inputRef={input} value={query} onValueChange={value=>{setQuery(value);setClearing(false);}} onHighlight={entry=>{if(entry)highlighted.current=entry.id;}} items={matches} groupLabel={query.trim()?`${matches.length} 条匹配查询`:'最近使用的查询'} onChoose={onRecall} renderItem={entry=><><History aria-hidden="true"/><span className="query-history-copy min-w-0 flex-1"><strong>{entry.query}</strong><small>{new Date(entry.at).toLocaleString()}{entry.scope==='clipboard' && entry.clipboardKind!=='all'?` · ${{text:'文本',image:'图片',file:'文件'}[entry.clipboardKind]}`:''}</small></span><Badge variant="outline">{scopeName(entry)}</Badge><CornerUpLeft className="query-history-recall" aria-label="回填查询"/></>} empty={<div className="query-history-empty"><p role="status">{entries.length?'没有匹配的历史查询。':'暂无搜索历史，执行搜索结果后会记录查询。'}</p>{query && entries.length?<Button size="sm" variant="ghost" onClick={()=>setQuery('')}>显示全部历史</Button>:null}</div>}/>
    {!readonly && matches.length?<div className="query-history-management flex flex-wrap items-center gap-2"><Button size="sm" variant="ghost" onClick={()=>{const selected=matches.find(entry=>entry.id===highlighted.current) || matches[0];if(selected)store.forget(selected.id);input.current?.focus();}}>移除选中查询</Button><Button size="sm" variant="ghost" onClick={()=>setClearing(true)}><Trash2 aria-hidden="true"/>清空全部</Button></div>:null}
    {clearing?<div className="query-history-confirm flex flex-wrap items-center gap-2" role="group" aria-label="确认清空搜索历史" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setClearing(false);input.current?.focus();}}}><span>清空全部 {entries.length} 条查询？</span><Button size="sm" onClick={()=>{setClearing(false);input.current?.focus();}}>取消</Button><Button size="sm" className="danger" onClick={()=>{store.clear();setClearing(false);input.current?.focus();}}>确认清空</Button></div>:null}
    <div className="search-action-help flex flex-wrap items-center justify-between gap-2"><span><kbd>↑↓</kbd> 选择 <kbd>↵</kbd> 回填 <kbd>Esc</kbd> 返回</span><span>{historyState}</span></div>
    <p className="query-history-note">只回填搜索条件，执行结果需再次确认。可在搜索设置中暂停记录。</p>
  </CommandDialog>;
}
