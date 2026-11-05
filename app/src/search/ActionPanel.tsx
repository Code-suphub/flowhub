import { useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Clipboard, Copy, FilePenLine, Pin, PinOff, Trash2 } from 'lucide-react';
import { CommandDialog } from '../shared/CommandDialog';
import { CommandSearch } from '../shared/CommandSearch';
import { resultActions, resultKind } from './Results';
import type { SearchItem } from './types';
import './action-panel.css';

export type ResultAction = {id:string;label:string;action:string;kind:'result'|'clipboard';shortcut?:string;keywords:string;disabled?:boolean};
export const actionIdentity=(item:SearchItem)=>JSON.stringify([item.type,item.id ?? null,item.path ?? null,item.url ?? null,item.usageSection ?? null]);

export function availableActions(item:SearchItem,readonly:boolean):ResultAction[] {
  if(item.type==='clipboard')return [
    {id:'clipboard:open',label:'粘贴',action:'open',kind:'result',shortcut:'↵',keywords:'paste 粘贴 原格式',disabled:readonly},
    ...(item.kind!=='image'?[{id:'result:copy',label:item.kind==='file'?'复制文件名':'复制全文',action:'copy',kind:'result' as const,keywords:'copy text filename 复制 文本 文件名',disabled:readonly}]:[]),
    {id:'clipboard:pin',label:item.pinnedAt?'取消置顶':'置顶',action:'pin',kind:'clipboard',shortcut:'⌘D',keywords:'pin unpin 固定 收藏 置顶',disabled:readonly},
    {id:'clipboard:note',label:item.note?'编辑备注':'添加备注',action:'note',kind:'clipboard',keywords:'note annotation 备注 标注 整理',disabled:readonly},
    ...(['text','file'].includes(item.kind)?[{id:'clipboard:plain',label:'纯文本粘贴',action:'plain',kind:'clipboard' as const,shortcut:'⇧↵',keywords:'paste plain 粘贴 纯文本',disabled:readonly}]:[]),
    ...(item.kind==='text'?[{id:'clipboard:edit',label:'编辑副本',action:'edit',kind:'clipboard' as const,shortcut:'⌘E',keywords:'edit 编辑 修改 副本',disabled:readonly}]:[]),
    ...(!readonly?[{id:'clipboard:delete',label:'删除记录…',action:'delete',kind:'clipboard' as const,shortcut:'⌥⌫',keywords:'delete remove 删除 清除 历史'}]:[]),
  ];
  return resultActions(item).map(([action,label])=>({id:`result:${action}`,label,action,kind:'result',shortcut:action==='open' || item.type==='twofa'?'↵':undefined,keywords:action==='copy'?'copy 复制':action==='copy-query'?'copy command 查询 命令':action==='edit'?'edit 编辑 修改':'open activate 打开 粘贴',disabled:readonly}));
}

export function ActionPanel({item,onClose,onChoose}: {item:SearchItem;onClose():void;onChoose(action:ResultAction):void}) {
  const [query,setQuery]=useState(''),input=useRef<HTMLInputElement>(null);
  const readonly=document.documentElement.dataset.weborgReadonly==='true';
  const actions=useMemo(()=>availableActions(item,readonly),[item,readonly]);
  const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches=actions.filter(action=>terms.every(term=>`${action.label} ${action.keywords}`.toLocaleLowerCase().includes(term)));
  const title=String(item.title || (item.type==='clipboard'?item.kind==='image'?'图片':item.kind==='file'?(item.fileNames || []).join('、'):item.content:'') || resultKind(item)).slice(0,180).replace(/\s+/g,' ');
  return <CommandDialog title="结果操作" onClose={onClose} initialFocus={input} className="search-actions-dialog">
      <div className="search-action-target flex min-w-0 items-center gap-2"><span>{resultKind(item)}</span><strong>{title}</strong></div>
      <CommandSearch label="搜索结果操作" placeholder="搜索操作，如复制、置顶…" listLabel="可用结果操作" clearLabel="清除操作搜索" inputRef={input} value={query} onValueChange={setQuery} items={matches} groupLabel={query.trim()?`${matches.length} 个匹配操作`:'当前结果的操作'} isItemDisabled={action=>Boolean(action.disabled)} onChoose={onChoose} renderItem={action=>{
        const Icon=action.action==='pin'?(item.pinnedAt?PinOff:Pin):action.action==='delete'?Trash2:action.action==='edit'?FilePenLine:action.action==='open'?ArrowUpRight:action.action==='plain'?Clipboard:Copy;
        return <><Icon aria-hidden="true"/><span className="min-w-0 flex-1">{action.label}</span>{action.shortcut?<kbd aria-label={`搜索框快捷键 ${action.shortcut}`}>{action.shortcut}</kbd>:null}</>;
      }} empty={<p className="search-action-empty" role="status">没有匹配的操作，试试“复制”或清空搜索。</p>}/>
      <div className="search-action-help flex flex-wrap items-center justify-between gap-2"><span><kbd>↑↓</kbd> 选择 <kbd>↵</kbd> 执行 <kbd>Esc</kbd> 返回</span>{readonly?<span>只读预览，操作不可执行</span>:<span>右侧快捷键在搜索框使用</span>}</div>
  </CommandDialog>;
}
