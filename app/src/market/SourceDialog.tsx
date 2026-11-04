import { useRef, useState } from 'react';
import { FolderIcon, GlobeIcon } from 'lucide-react';
import { Button, Dialog, Input } from '../shared/ui';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../components/ui/field';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import type { Source } from './api';

export type SourceState = {loading?:boolean;count?:number;warnings?:string[];error?:string};
const blank = ():Source => ({id:'',name:'',kind:'local',location:'',key:''});
type Props = {sources:Source[];states:Record<string,SourceState>;available:boolean;busy:boolean;locking:boolean;error:string;onClose:()=>void;onScan:(source:Source)=>void;onSave:(source:Source)=>Promise<boolean>;onRemove:(source:Source)=>Promise<boolean>;onChoose:()=>Promise<string|null>};
export function SourceDialog({sources,states,available,busy,locking,error,onClose,onScan,onSave,onRemove,onChoose}:Props) {
  const [editing,setEditing]=useState<Source|null>(available && !sources.length?blank:null), [removing,setRemoving]=useState<string|null>(null);
  const origin=useRef<HTMLElement|null>(null), section=useRef<HTMLDivElement>(null);
  const edit=(source:Source,trigger:HTMLElement)=>{origin.current=trigger;setRemoving(null);setEditing({...source});};
  const closeEditor=()=>{setEditing(null);requestAnimationFrame(()=>{if(origin.current?.isConnected && document.hasFocus())origin.current.focus();});};
  return <Dialog title="插件来源" className="fh-market-dialog market-sources-dialog" busy={locking} onClose={onClose}>
    <div ref={section} className="market-sources-content">
      {error && !editing?<Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>:null}
      <div className="market-source-heading"><p className="market-meta">插件库决定“发现”中可安装的内容。移除来源会保留已安装插件。</p>{available?<Button size="sm" disabled={busy || Boolean(editing)} onClick={e=>edit(blank(),e.currentTarget)}>添加来源</Button>:null}</div>
      <div className="market-source-list">{sources.map(source=>{
        const status=states[source.id],Icon=source.kind==='local'?FolderIcon:GlobeIcon;
        return <article key={source.id} className="market-source-row" aria-label={source.name}><div className="market-source-identity"><Icon aria-hidden="true"/><div className="min-w-0"><h3>{source.name}</h3><p className="market-meta">{source.kind==='local'?'本地目录':'HTTPS 仓库'} · {status?.loading?'刷新中…':status?.error?'刷新失败':status?.count!==undefined?`${status.count} 个插件`:'尚未刷新'}</p></div></div>
          <details className="market-location"><summary>来源位置</summary><code>{source.location}</code></details>
          {status?.error?<p role="alert" className="market-source-error">{status.error}</p>:null}
          {status?.warnings?.length?<details className="market-location"><summary>{status.warnings.length} 条来源提示</summary>{status.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>:null}
          {available?<div className="market-source-actions"><Button size="sm" disabled={busy || Boolean(editing)} onClick={()=>onScan(source)}>刷新</Button><Button size="sm" disabled={busy || Boolean(editing)} onClick={e=>edit(source,e.currentTarget)}>编辑</Button><Button variant="ghost" size="sm" disabled={busy || Boolean(editing)} onClick={()=>setRemoving(source.id)}>移除</Button></div>:null}
          {removing===source.id?<Alert variant="warning"><AlertTitle>移除 {source.name}？</AlertTitle><AlertDescription>不会卸载已经安装的插件。</AlertDescription><div className="flex justify-end gap-2"><Button size="sm" disabled={busy} onClick={()=>setRemoving(null)}>取消</Button><Button size="sm" variant="destructive" disabled={busy} onClick={async()=>{if(await onRemove(source)){setRemoving(null);requestAnimationFrame(()=>section.current?.querySelector<HTMLButtonElement>('.market-source-heading button')?.focus());}}}>确认移除</Button></div></Alert>:null}
        </article>;
      })}</div>
      {!sources.length && !editing?<Empty><EmptyHeader><EmptyTitle>还没有插件来源</EmptyTitle><EmptyDescription>{available?'添加本地目录或 HTTPS 插件库。':'请在桌面 App 添加来源。'}</EmptyDescription></EmptyHeader></Empty>:null}
      {editing?<form className="market-source-form" aria-label={editing.id?'编辑来源':'添加来源'} onSubmit={async e=>{e.preventDefault();if(await onSave({...editing,name:editing.name.trim(),location:editing.location.trim(),key:editing.kind==='https'?editing.key.trim():''}))closeEditor();}}>
        <h3>{editing.id?'编辑来源':'添加来源'}</h3>{error?<Alert variant="destructive"><AlertTitle>来源未保存</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>:null}<FieldGroup className="gap-4">
          <Field data-disabled={busy}><FieldLabel htmlFor="source-name">名称</FieldLabel><Input id="source-name" autoFocus required maxLength={100} disabled={busy} value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})}/></Field>
          <FieldSet className="border-0 p-0 m-0 gap-0"><FieldLegend variant="label">来源类型</FieldLegend><RadioGroup className="flex gap-4" value={editing.kind} disabled={busy} onValueChange={kind=>setEditing({...editing,kind:kind as Source['kind']})}>{(['local','https'] as const).map(kind=><div key={kind} className="flex items-center gap-2"><RadioGroupItem id={`source-kind-${kind}`} value={kind}/><FieldLabel htmlFor={`source-kind-${kind}`}>{kind==='local'?'本地目录':'HTTPS 仓库'}</FieldLabel></div>)}</RadioGroup></FieldSet>
          <Field data-disabled={busy}><FieldLabel htmlFor="source-location">{editing.kind==='local'?'目录':'仓库索引地址'}</FieldLabel><Input id="source-location" required disabled={busy} value={editing.location} onChange={e=>setEditing({...editing,location:e.target.value})}/></Field>
          {editing.kind==='local'?<Button disabled={busy} onClick={async()=>{const path=await onChoose();if(path)setEditing(old=>old?{...old,location:path}:null);}}>选择目录</Button>:<Field data-disabled={busy}><FieldLabel htmlFor="source-key">仓库签名公钥</FieldLabel><Input id="source-key" required disabled={busy} value={editing.key} onChange={e=>setEditing({...editing,key:e.target.value})} placeholder="minisign 公钥"/></Field>}
        </FieldGroup><div className="flex justify-end gap-2 mt-4"><Button disabled={busy} onClick={closeEditor}>取消</Button><Button variant="default" type="submit" disabled={busy}>保存来源</Button></div>
      </form>:null}
    </div>
  </Dialog>;
}
