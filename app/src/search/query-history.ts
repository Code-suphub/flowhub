export const queryHistoryKey='flowhub.search.queryHistory.v1';
export interface QueryConditions {query:string;scope:string;clipboardKind:string;clipboardSource?:string|null;clipboardPinnedOnly?:boolean}
export interface QueryHistoryEntry extends QueryConditions {id:string;at:number;label:string}
const limit=100;
const sensitive=/(?:\b(?:password|passwd|secret|access[_-]?token|api[_-]?key|authorization|cookie)\s*[:=]|\b(?:bearer|basic)\s+\S+|:\/\/[^\s/@]+:[^\s/@]*@|[?&](?:token|access_token|api[_-]?key|apikey|key|secret|password|passwd|pwd|auth|authorization|signature|sig|session|cookie)=|(?:^|\s)(?:-u|--user|--password|--token|--api-key)\b|\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.)/i;
export function safeQuery(query:unknown):query is string {
  return typeof query==='string' && query.trim().length>0 && query.length<=256 && !/[\r\n\u0000-\u001f]/.test(query) && !sensitive.test(query);
}
const identity=(entry:QueryConditions)=>JSON.stringify([entry.scope,entry.clipboardKind,entry.query,entry.clipboardSource ?? null,entry.clipboardPinnedOnly===true]);
export function createQueryHistory({storage=()=>window.localStorage,readonly=()=>document.documentElement.dataset.weborgReadonly==='true'}: {storage?:()=>Pick<Storage,'getItem'|'setItem'>;readonly?:()=>boolean}={}) {
  let entries:QueryHistoryEntry[]|undefined,sessionOnly=false;
  const listeners=new Set<()=>void>();
  function read() {
    if(sessionOnly)return entries || [];
    try {
      const raw=storage().getItem(queryHistoryKey) || '[]';
      const parsed=raw.length<=200_000?JSON.parse(raw):[];
      const seen=new Set<string>(),ids=new Set<string>();
      return (Array.isArray(parsed)?parsed:[]).filter(entry=>entry && typeof entry.id==='string' && /^[a-z0-9_-]{1,80}$/i.test(entry.id) && safeQuery(entry.query) && typeof entry.scope==='string' && /^[a-z0-9_-]{1,80}$/i.test(entry.scope) && ['all','text','image','file'].includes(entry.clipboardKind) && Number.isFinite(entry.at) && entry.at>0)
        .map(entry=>({id:entry.id,query:entry.query.trim(),label:entry.query.trim(),scope:entry.scope,clipboardKind:entry.clipboardKind,at:entry.at,clipboardSource:entry.scope==='clipboard' && typeof entry.clipboardSource==='string' && entry.clipboardSource.length<=512?entry.clipboardSource.trim():null,clipboardPinnedOnly:entry.scope==='clipboard' && entry.clipboardPinnedOnly===true}))
        .sort((a,b)=>b.at-a.at).filter(entry=>{const key=identity(entry);if(seen.has(key)||ids.has(entry.id))return false;seen.add(key);ids.add(entry.id);return true;}).slice(0,limit) as QueryHistoryEntry[];
    } catch {sessionOnly=true;return entries || [];}
  }
  const snapshot=()=>entries ?? (entries=read());
  const publish=()=>listeners.forEach(listener=>listener());
  function write(next:QueryHistoryEntry[]) {
    entries=next;
    try {storage().setItem(queryHistoryKey,JSON.stringify(next));sessionOnly=false;}catch{sessionOnly=true;}
    publish();
  }
  return {
    snapshot,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    refresh(){entries=read();publish();},
    sessionOnly:()=>sessionOnly,
    record(conditions:QueryConditions) {
      if(readonly() || !safeQuery(conditions.query))return;
      const query=conditions.query.trim();
      if(!/^[a-z0-9_-]{1,80}$/i.test(conditions.scope) || !['all','text','image','file'].includes(conditions.clipboardKind))return;
      const value={query,scope:conditions.scope,clipboardKind:conditions.clipboardKind,clipboardSource:conditions.scope==='clipboard' && typeof conditions.clipboardSource==='string' && conditions.clipboardSource.length<=512?conditions.clipboardSource.trim():null,clipboardPinnedOnly:conditions.scope==='clipboard' && conditions.clipboardPinnedOnly===true},previous=read(),existing=previous.find(entry=>identity(entry)===identity(value));
      write([{...value,id:existing?.id || crypto.randomUUID(),at:Date.now(),label:query},...previous.filter(entry=>identity(entry)!==identity(value))].slice(0,limit));
    },
    forget(id:string){if(!readonly())write(read().filter(entry=>entry.id!==id));},
    clear(){if(!readonly())write([]);},
  };
}
let store:ReturnType<typeof createQueryHistory>|undefined;
export const getQueryHistory=()=>store ?? (store=createQueryHistory());
export function matchingQueries(entries:readonly QueryHistoryEntry[],query:string) {
  const text=query.slice(0,256).normalize('NFKC').toLocaleLowerCase().trim(),terms=text.split(/\s+/).filter(Boolean);
  const normalized=(entry:QueryHistoryEntry)=>entry.query.normalize('NFKC').toLocaleLowerCase();
  return entries.filter(entry=>terms.every(term=>normalized(entry).includes(term))).map((entry,index)=>({entry,index,score:!text?0:normalized(entry)===text?0:normalized(entry).startsWith(text)?1:2})).sort((a,b)=>a.score-b.score || a.index-b.index).map(value=>value.entry);
}
