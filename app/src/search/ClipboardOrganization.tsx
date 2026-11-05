import { useEffect, useRef, useState } from 'react';
import { Pin, Settings2 } from 'lucide-react';
import { Button, Dialog } from '../shared/ui';
import { Help, Select, Tooltip } from '../shared/controls';
import { Textarea } from '../components/ui/textarea';
import { host, type SearchSnapshot } from './types';
import './clipboard-organization.css';

export interface ClipboardNoteTarget {id:number;note:string;summary:string}
export function ClipboardFilters({snapshot,onKind,onFilter,onReset,onReturn}: {snapshot:SearchSnapshot;onKind(kind:string):void;onFilter(source:string|null,pinned:boolean):void;onReset():void;onReturn():void}) {
  const {state}=snapshot,[sources,setSources]=useState<{name:string;count:number}[]>([]),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let alive=true,version=0;
    const load=async()=>{const request=++version;try{const rows=await host.weborg.listClipboardSources?.() || [];if(alive && request===version){setSources(rows);setError('');}}catch(error){if(alive && request===version)setError(String((error as Error).message || error));}};
    void load();return()=>{alive=false;};
  },[attempt,state.clipboardSourceRevision]);
  const source=state.clipboardSource ?? null,pinned=state.clipboardPinnedOnly===true;
  const options=[{value:'all',label:'全部来源'},{value:'source:',label:'未标注来源'},...sources.filter(item=>item.name).map(item=>({value:`source:${item.name}`,label:item.name}))];
  if(source && !sources.some(item=>item.name===source))options.push({value:`source:${source}`,label:`${source}（无匹配记录）`});
  return <div id="clipboardKindRow" data-clipboard-filters className="search-scopes clipboard-filters flex flex-wrap items-center gap-2" aria-label="剪贴板筛选" onKeyDown={event=>{
    if(['Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Enter',' '].includes(event.key))event.stopPropagation();
    if(event.key==='Escape'){event.stopPropagation();if(!event.defaultPrevented){event.preventDefault();onReturn();}}
  }}>
    <div className="flex items-center gap-1" aria-label="剪贴板类型筛选">{[['all','全部'],['text','文本'],['image','图片'],['file','文件']].map(([kind,label])=><Button key={kind} data-clipboard-kind={kind} aria-pressed={state.clipboardKind===kind} onMouseDown={event=>event.preventDefault()} onClick={()=>onKind(kind)}>{label}</Button>)}</div>
    <Button variant="ghost" size="sm" aria-label="只看置顶记录" aria-pressed={pinned} onMouseDown={event=>event.preventDefault()} onClick={()=>onFilter(source,!pinned)}><Pin aria-hidden="true"/>只看置顶</Button>
    <div className="clipboard-source-select"><Select label="按已保存来源筛选" value={source===null?'all':`source:${source}`} options={options} onChange={value=>onFilter(value==='all'?null:value.slice(7),pinned)} popupClassName="clipboard-source-popup" finalFocus={()=>document.getElementById('q')}/></div>
    <Help label="来源筛选说明">仅按记录中已保存的来源筛选，未标注的记录归入“未标注来源”。当前采集不会猜测来源应用；来源不能作为隐私排除的依据。</Help>
    {source!==null || pinned || state.clipboardKind!=='all'?<Button variant="ghost" size="sm" onClick={onReset}>重置筛选</Button>:null}
    <Tooltip content="打开剪贴板采集与留存设置"><Button variant="ghost" size="icon-sm" aria-label="剪贴板采集设置" onClick={()=>void host.weborg.openSettings({initialModule:'clipboard'})}><Settings2 aria-hidden="true"/></Button></Tooltip>
    {error?<div className="clipboard-filter-error flex items-center gap-2" role="alert"><span>来源读取失败</span><Button size="sm" variant="ghost" onClick={()=>setAttempt(value=>value+1)}>重试来源</Button></div>:null}
  </div>;
}

export function ClipboardNoteEditor({target,onClose,onSaved}: {target:ClipboardNoteTarget;onClose():void;onSaved():void}) {
  const [note,setNote]=useState(target.note),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const input=useRef<HTMLTextAreaElement>(null),pending=useRef(false),mounted=useRef(true),composing=useRef(false),ended=useRef(-Infinity);
  useEffect(()=>()=>{mounted.current=false;},[]);
  async function save(){
    if(pending.current)return;
    if(document.documentElement.dataset.weborgReadonly==='true'){setError('只读预览不能修改备注');return;}
    if(note.trim()===target.note){onClose();return;}
    pending.current=true;setBusy(true);setError('');
    try{const result=await host.weborg.setClipboardNote(target.id,note,target.note);if(result?.ok===false)throw Error(result.reason || '备注保存失败');if(mounted.current){onSaved();onClose();}}
    catch(error){if(mounted.current)setError(String((error as Error).message || error));}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  }
  return <Dialog title="编辑剪贴板备注" className="clipboard-note-dialog" initialFocus={input} restoreFocus={false} busy={busy} notice={error} onClose={onClose}>
    <div data-clipboard-note-editor onCompositionStartCapture={()=>{composing.current=true;}} onCompositionEndCapture={()=>{composing.current=false;ended.current=performance.now();}} onKeyDownCapture={event=>{if(composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode===229 || event.key==='Enter' && performance.now()-ended.current<80){event.stopPropagation();return;}}} onKeyDown={event=>{if(event.key==='Enter' && (event.metaKey || event.ctrlKey)){event.preventDefault();event.stopPropagation();void save();}}}>
      <p className="clipboard-note-target">{target.summary}</p><label htmlFor="clipboard-note">备注</label>
      <Textarea id="clipboard-note" ref={input} aria-label="剪贴板备注" value={note} maxLength={500} disabled={busy} placeholder="例如：部署步骤、报销资料…" onChange={event=>setNote(event.target.value)}/>
      <div className="clipboard-note-help flex items-center justify-between gap-2"><span>备注可搜索，不改变复制或粘贴的原文。</span><span>{note.length}/500</span></div>
      <div className="flex justify-end gap-2 mt-4"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="default" disabled={busy} onClick={()=>void save()}>保存备注</Button></div>
    </div>
  </Dialog>;
}
