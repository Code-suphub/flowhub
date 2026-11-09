import {useEffect,useRef,useState} from 'react';
import {ShieldQuestion,X,ArrowUpRight} from 'lucide-react';
import {Button} from '../shared/ui';
import {invoke,nativeHost} from '../shared/native';
type AlertContext = {sourceNames: string; requestApp?: string | null; preview: boolean};
export function ScriptAlert(){
  const [data,setData]=useState<AlertContext | null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true),pending=useRef(false);
  useEffect(()=>{
    alive.current=true;let sequence=0;
    const read=async()=>{const request=++sequence;try{const value=await invoke<AlertContext | null>('script_alert_api',{action:'context'});if(alive.current&&request===sequence)setData(value);}catch(reason){if(alive.current)setError(String(reason));}};
    const update=()=>void read();window.addEventListener('flowhub:script-alert',update);void read();
    return()=>{alive.current=false;window.removeEventListener('flowhub:script-alert',update);};
  },[]);
  async function act(action:'open'|'dismiss'){
    if(pending.current)return;pending.current=true;setBusy(true);setError('');
    try{await invoke('script_alert_api',{action});}
    catch(reason){if(alive.current)setError(String(reason));}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  const isBrowser = !nativeHost();
  return <main className="fh-script-alert">
    <header>
      <ShieldQuestion className="fh-script-alert-mark" size={16} aria-hidden="true"/>
      <h1>FlowHub · 认证窗口</h1>
      {data?.preview ? <span className="fh-script-alert-preview">预览</span> : null}
      <Button className="fh-script-alert-close" variant="ghost" size="icon-xs" aria-label="关闭提示" disabled={busy||isBrowser} onClick={()=>void act('dismiss')}><X size={14}/></Button>
    </header>
    <div className="fh-script-alert-body">
      <div className="fh-script-alert-content">
        <p className="fh-script-alert-summary" role="status">{data?.requestApp ? <>钥匙串 · <strong>{data.requestApp}</strong></> : data?.sourceNames ? <>线索 · <strong>{data.sourceNames}</strong></> : '来源待确认'}</p>
        {error ? <p className="fh-script-alert-error" role="alert">{error}</p> : null}
      </div>
      <Button size="sm" disabled={busy||isBrowser||!data} onClick={()=>void act('open')}>查看来源 <ArrowUpRight size={12}/></Button>
    </div>
  </main>;
}
