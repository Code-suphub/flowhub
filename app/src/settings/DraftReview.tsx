import { useRef, useState } from 'react';
import { Button, Dialog } from '../shared/ui';
import { Alert, AlertDescription } from '../components/ui/alert';
import { ConfigChanges } from './ConfigChanges';
import { SettingsStore, useSettings } from './store';
import type { PageId } from './navigation';

export function DraftReview({ store, onClose, onNavigate }: { store: SettingsStore; onClose(): void; onNavigate(page: PageId): void }) {
  const s=useSettings(store), saving=useRef(false), [error,setError]=useState('');
  async function save() {
    if(saving.current || s.busy || s.conflict || !store.dirty)return;
    saving.current=true;setError('');
    try{await store.save();if(!store.dirty)onClose();}
    catch(reason){const text=reason instanceof Error?reason.message:String(reason);setError(text);store.notice(text,true);}
    finally{saving.current=false;}
  }
  return <Dialog title="未保存的修改" onClose={onClose} busy={s.busy} notice={error || (s.conflict?s.notice:undefined)} className="settings-review-dialog">
    <ConfigChanges before={s.saved} after={s.config} disabled={s.busy} onNavigate={onNavigate} />
    <Alert className="mt-4" role="status"><AlertDescription>修改保留在当前草稿中，保存后生效；关闭审阅可以继续编辑。</AlertDescription></Alert>
    <div className="settings-dialog-actions"><Button disabled={s.busy} onClick={onClose}>继续编辑</Button><Button variant="default" disabled={s.busy || !store.dirty || s.conflict} onClick={()=>void save()}>{s.busy?'正在保存…':'保存全部修改'}</Button></div>
  </Dialog>;
}
