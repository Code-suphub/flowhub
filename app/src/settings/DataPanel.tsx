import { useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveIcon, DatabaseIcon, FileCogIcon, HistoryIcon, ActivityIcon, RefreshCwIcon, FolderOpenIcon } from 'lucide-react';
import { Button, Dialog, Input } from '../shared/ui';
import { Help } from '../shared/controls';
import { Badge } from '../components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Choice, Toggle } from './fields';
import { call, host, readonly, write } from './api';
import { clone, imported, same, type Bag, type Config } from './model';
import { historyConfiguration } from './config-changes';
import { ConfigChanges } from './ConfigChanges';
import { SettingsStore, useSettings } from './store';
import './data.css';

const names: Record<string,string> = { all:'全部配置', core:'全局设置', web:'网页目录设置', app:'应用', clipboard:'剪贴板', memo:'备忘录', tools:'工具' };
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const stamp = (value: unknown) => { const date=new Date(Number(value));return Number.isFinite(date.getTime()) ? date.toLocaleString() : '未知时间'; };
const size = (value: unknown) => { const bytes=Number(value)||0;return bytes<1024?`${bytes} B`:`${(bytes/1024).toFixed(bytes%1024?1:0)} KB`; };

export function PathControl({ store, storage = false }: { store: SettingsStore; storage?: boolean }) {
  const s=useSettings(store), preview=readonly(), info=storage?s.storage:s.configPath;
  const value=String(storage?s.config!.plugins.clipboard.settings.storagePath || '':s.config!.core.configPath || '');
  const savedValue=String(info.configuredPath ?? (storage?s.saved?.plugins.clipboard.settings.storagePath:s.saved?.core.configPath) ?? '');
  const changed=value!==savedValue, current=info.activePath || info.resolvedPath || info.defaultPath || '默认位置';
  const [choosing,setChoosing]=useState(false), [error,setError]=useState('');
  const pending=useRef(false), alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function choose() {
    if(preview || pending.current || s.busy || s.conflict)return;
    const before=store.snapshot().config;pending.current=true;setChoosing(true);setError('');
    try {
      const result=await write(storage?'chooseClipboardStorage':'chooseConfigPath');
      if(!alive.current)return;
      if(store.snapshot().config!==before)throw Error('配置已改变，请重新选择位置');
      if(!result.canceled && result.path)store.edit(c=>{if(storage)c.plugins.clipboard.settings.storagePath=result.path;else c.core.configPath=result.path;});
    } catch(reason){if(alive.current)setError(message(reason));}
    finally{pending.current=false;if(alive.current)setChoosing(false);}
  }
  const disabled=preview || s.busy || s.conflict || choosing;
  return <section className="settings-storage-control flex min-w-0 flex-col gap-3" data-storage-kind={storage?'database':'config'} aria-label={storage?'数据库与剪贴板目录':'配置文件位置'}>
    <header className="flex flex-wrap items-center gap-2">{storage?<DatabaseIcon aria-hidden="true" />:<FileCogIcon aria-hidden="true" />}<h3>{storage?'数据库与剪贴板目录':'配置文件位置'}</h3><Badge variant={changed?'secondary':'outline'}>{preview?'只读预览':changed?'待保存':'当前生效'}</Badge></header>
    <div className="settings-storage-path"><span>当前使用</span><code>{current}</code></div>
    {changed?<><div className="settings-storage-path"><label htmlFor={storage?'settings-database-target':'settings-config-target'}>保存后使用</label><Input id={storage?'settings-database-target':'settings-config-target'} aria-label={storage?'数据目录目标位置':'配置文件目标位置'} value={value || info.defaultPath || '默认位置（保存时解析）'} readOnly /></div><Alert variant="warning" role="status"><AlertDescription>{storage?'保存后切换数据目录。空目录接收当前全部数据；已有数据库会加载目标数据，源网页草稿不合并。':'保存后切换配置文件，原文件保留。'}</AlertDescription></Alert></>:null}
    <div className="flex flex-wrap gap-2"><Button disabled={disabled} onClick={()=>void choose()}>{choosing?'正在选择…':'选择位置…'}</Button><Button disabled={preview || s.busy || choosing} onClick={()=>void store.run(async()=>{await write(storage?'openClipboardStorage':'openConfigPath');})}><FolderOpenIcon data-icon="inline-start" />打开当前</Button><Button variant="ghost" disabled={disabled || !value} onClick={()=>store.edit(c=>{
      if(storage){if(s.saved?.plugins.clipboard.settings.storagePath===undefined)delete c.plugins.clipboard.settings.storagePath;else c.plugins.clipboard.settings.storagePath='';}
      else if(s.saved?.core.configPath===undefined)delete c.core.configPath;else c.core.configPath='';
    })}>恢复默认</Button></div>
    {error?<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>:null}
  </section>;
}

interface HistoryReview { entry: Bag; restore: boolean; base: Config; target: Config | null; loading: boolean; error: string }
interface ImportReview { payload: Bag; base: Config }

export function DataPanel({ store }: { store: SettingsStore }) {
  const s=useSettings(store), preview=readonly();
  const [scope,setScope]=useState('all'), [pending,setPending]=useState<ImportReview|null>(null), [mode,setMode]=useState('merge'), [transferError,setTransferError]=useState(''), [transferring,setTransferring]=useState(false);
  const [history,setHistory]=useState<HistoryReview|null>(null), [refreshing,setRefreshing]=useState(false);
  const [report,setReport]=useState(''), [clearSampling,setClearSampling]=useState(false), [diagnosing,setDiagnosing]=useState(false), [diagnosticError,setDiagnosticError]=useState('');
  const alive=useRef(true), historyRequest=useRef(0), refreshingRef=useRef(false), transferRef=useRef(false), diagnosticRef=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;historyRequest.current++;};},[]);
  const plan=useMemo(()=>{
    if(!pending)return {config:null,error:''};
    try{return {config:imported(pending.base,pending.payload,mode as 'merge'|'replace'),error:''};}
    catch(reason){return {config:null,error:message(reason)};}
  },[pending,mode]);
  async function refreshHistory() {
    if(refreshingRef.current || s.busy)return;
    refreshingRef.current=true;setRefreshing(true);
    try{await store.refreshHistory();}finally{refreshingRef.current=false;if(alive.current)setRefreshing(false);}
  }
  function closeHistory(){historyRequest.current++;setHistory(null);}
  async function openHistory(entry: Bag, restore=false) {
    if(s.busy || restore && (preview || s.conflict))return;
    const request=++historyRequest.current, base=clone(store.snapshot().config!);
    setHistory({entry,restore,base,target:null,loading:true,error:''});
    try {
      const result=await call('previewConfigHistory',entry.id);
      if(!alive.current || request!==historyRequest.current)return;
      const target=historyConfiguration(base,result.config);
      setHistory({entry,restore,base,target,loading:false,error:same(store.snapshot().config,base)?'':'当前草稿已变化，请重新读取差异。'});
    }catch(reason){if(alive.current && request===historyRequest.current)setHistory({entry,restore,base,target:null,loading:false,error:message(reason)});}
  }
  async function restoreHistory() {
    if(!history?.target || history.loading || history.error || preview || s.busy || s.conflict)return;
    if(!same(store.snapshot().config,history.base)){setHistory({...history,error:'当前草稿已变化，请重新读取差异后再恢复。'});return;}
    try{await store.restoreHistory(history.entry.id);if(alive.current)closeHistory();}
    catch(reason){store.notice(message(reason),true);if(alive.current)setHistory({...history,error:message(reason)});}
  }
  async function retryHistory() {
    if(!history || s.busy)return;
    if(!s.conflict){await openHistory(history.entry,history.restore);return;}
    try{await store.reset();if(alive.current)closeHistory();}
    catch(reason){if(alive.current)setHistory({...history,error:message(reason)});}
  }
  async function transfer(kind:'import'|'export') {
    if(preview || transferRef.current || s.busy || s.conflict)return;
    transferRef.current=true;setTransferring(true);setTransferError('');
    const base=store.snapshot().config!;
    try {
      if(kind==='export'){
        const result=await write('exportConfig',scope);store.notice(result.canceled?'已取消导出':`已导出到 ${result.path}`);
      }else{
        const result=await write('pickConfigImport');
        if(!alive.current || result.canceled)return;
        if(store.snapshot().config!==base)throw Error('配置已改变，请重新选择导入文件');
        setPending({payload:result,base:clone(base)});setMode('merge');
      }
    }catch(reason){if(alive.current)setTransferError(message(reason));}
    finally{transferRef.current=false;if(alive.current)setTransferring(false);}
  }
  function applyImport() {
    if(!pending || !plan.config || preview || s.busy || s.conflict)return;
    if(!same(store.snapshot().config,pending.base)){setTransferError('当前草稿已变化，请关闭并重新导入。');return;}
    store.replace(plan.config);setPending(null);setTransferError('');
  }
  async function diagnose(action:()=>Promise<void>) {
    if(preview || diagnosticRef.current || s.busy)return;
    diagnosticRef.current=true;setDiagnosing(true);setDiagnosticError('');
    try{await action();}catch(reason){if(alive.current)setDiagnosticError(message(reason));}
    finally{diagnosticRef.current=false;if(alive.current)setDiagnosing(false);}
  }
  return <div className="settings-data-panel flex min-w-0 flex-col gap-7">
    <section className="settings-group" aria-labelledby="settings-storage-title">
      <header className="settings-data-heading flex flex-wrap items-center gap-2"><DatabaseIcon aria-hidden="true" /><h2 id="settings-storage-title">存储位置</h2><Help label="存储位置说明">位置修改先进入草稿，点击全局保存后生效。配置备份不包含 SQLite 中的网页目录和剪贴板记录。</Help></header>
      <div className="settings-storage-list grid min-w-0 grid-cols-1 gap-5"><PathControl store={store} /><PathControl store={store} storage /></div>
    </section>
    <section className="settings-group" aria-labelledby="settings-history-title">
      <header className="settings-data-heading flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><HistoryIcon aria-hidden="true" /><h2 id="settings-history-title">配置历史</h2><Help label="配置历史说明">每次保存前自动备份上一版配置，最多保留 20 份。恢复前会再次备份；网页目录和剪贴板记录不随配置历史回退。</Help></div><Button disabled={s.busy || refreshing || s.history.available===false} onClick={()=>void refreshHistory()}><RefreshCwIcon data-icon="inline-start" />{refreshing?'正在刷新…':'刷新历史'}</Button></header>
      {s.history.demo?<p className="settings-review-context">只读示例 · 实际配置历史请在桌面 App 中查看</p>:null}
      {s.history.error?<Alert variant="destructive"><AlertDescription>{s.history.error}</AlertDescription></Alert>:null}
      {!s.history.entries?.length?<Empty className="settings-history-empty"><EmptyHeader><EmptyMedia variant="icon"><ArchiveIcon /></EmptyMedia><EmptyTitle>{s.history.available===false?'浏览器预览不提供配置历史':'暂无历史版本'}</EmptyTitle></EmptyHeader></Empty>:<ul className="settings-history-list">{(s.history.entries as Bag[]).map(entry=><li key={entry.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3>{stamp(entry.created_at)}</h3><span>{entry.catalog_count || 0} 项网页 · {size(entry.bytes)}</span></div><div className="flex flex-wrap gap-2"><Button disabled={s.busy} onClick={()=>void openHistory(entry)}>查看差异</Button><Button variant="ghost" disabled={preview || s.busy || s.conflict} onClick={()=>void openHistory(entry,true)}>恢复</Button></div></li>)}</ul>}
    </section>
    <section className="settings-group" aria-labelledby="settings-transfer-title">
      <header className="settings-data-heading flex items-center gap-2"><ArchiveIcon aria-hidden="true" /><h2 id="settings-transfer-title">导入与导出</h2><Help label="配置传输说明">导出当前已保存的配置；导入会先展示差异，应用为草稿后仍需保存。网页目录数据继续使用当前数据库。</Help></header>
      <Choice label="导出范围" value={scope} options={[{value:'all',label:'全部配置'},{value:'core',label:'全局设置'},...Object.keys(s.config!.plugins).sort().map(value=>({value,label:names[value] || value}))]} onChange={setScope} />
      <div className="flex flex-wrap gap-2 pt-3"><Button disabled={preview || transferring || s.busy || s.conflict} onClick={()=>void transfer('export')}>导出配置…</Button><Button disabled={preview || transferring || s.busy || s.conflict} onClick={()=>void transfer('import')}>{transferring?'正在处理…':'导入配置…'}</Button></div>
      {store.dirty?<p className="settings-export-note" role="status">导出使用已保存配置；当前草稿需先保存。</p>:null}
      {transferError && !pending?<Alert className="mt-3" variant="destructive"><AlertDescription>{transferError}</AlertDescription></Alert>:null}
    </section>
    <section className="settings-group" aria-labelledby="settings-diagnostics-title">
      <header className="settings-data-heading flex items-center gap-2"><ActivityIcon aria-hidden="true" /><h2 id="settings-diagnostics-title">本地诊断</h2><Badge variant="outline">立即生效</Badge><Help label="本地诊断说明">只记录本机 FlowHub 与 WebKit 的资源使用，不上传网络。诊断操作独立于配置草稿。</Help></header>
      <Toggle label="性能采样" checked={s.diagnostics.enabled===true} disabled={preview || diagnosing || s.busy} onChange={enabled=>void diagnose(async()=>{const result=await write('setDiagnosticsEnabled',enabled);store.patch({diagnostics:{...store.snapshot().diagnostics,...result,enabled}});host().flowhubPerformance?.enable(enabled);})} />
      <p className="settings-diagnostic-path">{s.diagnostics.path || '仅桌面 App 可用'}</p><div className="flex flex-wrap gap-2"><Button disabled={preview || diagnosing || s.busy} onClick={()=>void diagnose(async()=>{const result=await write('sampleDiagnostics');store.notice(result.reason || '已记录性能采样');})}>采样一次</Button><Button disabled={preview || diagnosing || s.busy} onClick={()=>{setDiagnosticError('');setClearSampling(true);}}>清理采样</Button><Button onClick={()=>setReport(JSON.stringify(host().flowhubPerformance?.report() || {},null,2))}>界面测量</Button><Button variant="ghost" onClick={()=>{host().flowhubPerformance?.reset();setReport('');}}>重置测量</Button></div>
      {diagnosticError && !clearSampling?<Alert className="mt-3" variant="destructive"><AlertDescription>{diagnosticError}</AlertDescription></Alert>:null}{report?<pre className="settings-code settings-diagnostic-report">{report}</pre>:null}
    </section>
    {history?<Dialog title={history.restore?'恢复配置历史':'历史差异'} busy={s.busy} onClose={closeHistory} notice={history.error} className="settings-review-dialog">
      <p className="settings-review-context">{stamp(history.entry.created_at)} · 与当前编辑草稿比较</p>
      {history.loading?<p role="status">正在读取历史配置…</p>:history.target?<><ConfigChanges before={history.base} after={history.target} />{history.restore?<Alert variant="warning" role="status" className="mt-4"><AlertTitle>恢复会立即替换已保存配置</AlertTitle><AlertDescription>未保存草稿会放弃；当前已保存配置会先备份。网页目录与剪贴板记录保持当前数据，系统集成及备份中的数据位置可能需要重启。</AlertDescription></Alert>:null}</>:null}
      <div className="settings-dialog-actions"><Button disabled={s.busy} onClick={closeHistory}>取消</Button>{history.error?<Button disabled={s.busy} onClick={()=>void retryHistory()}>{s.conflict?'重新加载当前配置':'重新读取差异'}</Button>:null}{!history.restore?<Button disabled={preview || history.loading || !history.target || Boolean(history.error) || s.busy || s.conflict} onClick={()=>setHistory({...history,restore:true})}>恢复此版本…</Button>:<Button variant="destructive" disabled={preview || history.loading || !history.target || Boolean(history.error) || s.busy || s.conflict} onClick={()=>void restoreHistory()}>确认恢复</Button>}</div>
    </Dialog>:null}
    {pending?<Dialog title="核对导入差异" busy={s.busy} onClose={()=>{setPending(null);setTransferError('');}} notice={transferError || plan.error} className="settings-review-dialog">
      <p className="settings-review-context">{pending.payload.path} · 范围 {names[pending.payload.scope || 'all'] || pending.payload.scope}</p>
      {pending.payload.appVersion && pending.payload.currentAppVersion!==pending.payload.appVersion?<Alert variant="warning" role="status" className="mb-4"><AlertDescription>导出版本 {pending.payload.appVersion} 与当前版本不同，请核对字段。</AlertDescription></Alert>:null}
      <Choice label="导入方式" value={mode} options={[{value:'merge',label:'递归合并（数组替换）'},{value:'replace',label:'替换所选范围'}]} onChange={setMode} />
      {plan.config?<ConfigChanges before={pending.base} after={plan.config} />:null}
      <div className="settings-dialog-actions"><Button disabled={s.busy} onClick={()=>{setPending(null);setTransferError('');}}>取消</Button><Button variant="default" disabled={preview || !plan.config || Boolean(plan.error) || Boolean(transferError) || s.busy || s.conflict || same(pending.base,plan.config)} onClick={applyImport}>应用为草稿</Button></div>
    </Dialog>:null}
    {clearSampling?<Dialog title="清理性能采样" busy={diagnosing} onClose={()=>setClearSampling(false)} notice={diagnosticError}><p>只清理本机性能记录，不影响网页、剪贴板或备忘录数据。</p><div className="settings-dialog-actions"><Button disabled={diagnosing} onClick={()=>setClearSampling(false)}>取消</Button><Button variant="destructive" disabled={diagnosing} onClick={()=>void diagnose(async()=>{await write('clearDiagnostics');if(alive.current)setClearSampling(false);store.notice('性能数据已清理');})}>确认清理</Button></div></Dialog>:null}
  </div>;
}
