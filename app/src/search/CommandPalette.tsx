import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, PanelTop, Puzzle, Search, Settings2 } from 'lucide-react';
import { CommandDialog } from '../shared/CommandDialog';
import { CommandSearch } from '../shared/CommandSearch';
import { Button } from '../shared/ui';
import { Badge } from '../components/ui/badge';
import { findLauncherCommands, launcherCommands, type LauncherCommand, type LauncherPlugin } from './commands';
import { host, type SearchSnapshot } from './types';
import './command-palette.css';

export function CommandPalette({snapshot,previewable,previewOpen,onClose,onExecute}: {snapshot:SearchSnapshot;previewable:boolean;previewOpen:boolean;onClose():void;onExecute(command:LauncherCommand):Promise<void|'handled'>}) {
  const [query,setQuery]=useState(''),[plugins,setPlugins]=useState<LauncherPlugin[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0);
  const input=useRef<HTMLInputElement>(null),mounted=useRef(true),pending=useRef(false);
  const readonly=document.documentElement.dataset.weborgReadonly==='true';
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    let active=true;setLoading(true);setLoadError('');
    void Promise.resolve().then(()=>host.weborg.listLauncherPlugins?.() || []).then(value=>{if(active)setPlugins(Array.isArray(value)?value:[]);}).catch(error=>{if(active)setLoadError(String(error?.message || error));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[attempt]);
  const commands=useMemo(()=>launcherCommands(snapshot,{plugins,readonly,previewable,previewOpen,pinAvailable:Boolean(host.weborg.setLauncherPinned)}),[snapshot,plugins,readonly,previewable,previewOpen]);
  const matches=useMemo(()=>findLauncherCommands(commands,query),[commands,query]);
  async function choose(command:LauncherCommand) {
    if(pending.current || command.disabled)return;
    pending.current=true;setBusy(true);setError('');
    try {const result=await onExecute(command);if(result!=='handled' && mounted.current)onClose();}
    catch(error) {if(mounted.current){setError(String((error as Error)?.message || error));input.current?.focus();}}
    finally {pending.current=false;if(mounted.current)setBusy(false);}
  }
  return <CommandDialog title="查找命令" initialFocus={input} onClose={onClose} busy={busy} notice={error} className="launcher-commands-dialog">
    <CommandSearch label="搜索 FlowHub 命令" placeholder="搜索页面、设置或插件，如主题、快捷键…" listLabel="FlowHub 命令" clearLabel="清除命令搜索" inputRef={input} value={query} onValueChange={value=>{setQuery(value);setError('');}} items={matches} groupLabel={query.trim()?`${matches.length} 个匹配命令`:'页面、插件与常用操作'} isItemDisabled={command=>Boolean(busy || command.disabled)} onChoose={command=>void choose(command)} renderItem={command=>{
      const Icon=command.kind==='插件'?Puzzle:command.kind==='搜索范围'?Search:command.kind==='窗口'?PanelTop:Settings2;
      return <><span className="launcher-command-icon"><Icon aria-hidden="true"/></span><span className="launcher-command-copy min-w-0 flex-1"><strong>{command.label}</strong><small>{command.description}</small></span><Badge variant="outline">{command.kind}</Badge>{command.shortcut?<kbd>{command.shortcut}</kbd>:<ArrowUpRight className="launcher-command-arrow" aria-hidden="true"/>}</>;
    }} empty={<p className="search-action-empty" role="status">没有匹配命令，试试“主题”“剪贴板”或“插件”。</p>}/>
    {loadError?<div className="launcher-command-load-error flex items-center justify-between gap-2" role="alert"><span>已安装插件读取失败：{loadError}</span><Button size="sm" variant="ghost" disabled={loading || busy} onClick={()=>setAttempt(value=>value+1)}>重试</Button></div>:null}
    <div className="search-action-help flex flex-wrap items-center justify-between gap-2"><span><kbd>↑↓</kbd> 选择 <kbd>↵</kbd> 前往／执行 <kbd>Esc</kbd> 返回</span><span>{loading?'正在读取已安装插件…':readonly?'只读预览 · 设置修改不保存':'仅在确认选择后前往或执行'}</span></div>
  </CommandDialog>;
}
