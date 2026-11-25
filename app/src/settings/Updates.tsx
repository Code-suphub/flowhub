import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../shared/ui';
import { readonly, write } from './api';
import { Toggle } from './fields';
import { useSettings, type SettingsStore } from './store';
import { ViewDetails } from './view-state';
import './updates.css';

const statusNames: Record<string, string> = {
  unsupported: '当前环境不支持更新',
  idle: '尚未检查',
  checking: '正在检查',
  available: '发现新版本',
  downloaded: '已下载，等待重启',
  downloading: '正在下载',
  installing: '正在安装',
  'not-available': '暂无可用更新',
  'up-to-date': '已是最新版本',
  error: '更新失败',
};
const dateFormat=new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'short',hour12:false});

export function Updates({store, install}: {store:SettingsStore; install:()=>Promise<void>}) {
  const s=useSettings(store), core=s.config!.core, update=s.update;
  const preview=readonly();
  const [checking,setChecking]=useState(false), [actionError,setActionError]=useState('');
  const checkPending=useRef(false);
  const unsupported=update.status==='unsupported' || update.supported===false;
  const status=unsupported?'unsupported':checking?'checking':update.status;
  const downloading=status==='downloading', installing=status==='installing';
  const canInstall=status==='available' || status==='downloaded';
  const running=status==='checking' || downloading || installing;
  const actionsDisabled=preview || unsupported || running || s.busy || s.conflict;
  const dirty=store.dirty;
  const autoCheck=core.autoUpdateCheck!==false, autoInstall=core.autoUpdateInstall===true;
  const preferencesDirty=autoCheck!==(s.saved?.core.autoUpdateCheck!==false)
    || autoInstall!==(s.saved?.core.autoUpdateInstall===true);
  const percent=downloading && update.total!==0 && Number.isFinite(update.percent)
    ? Math.round(Math.min(100,Math.max(0,update.percent))) : undefined;
  const checkedAt=typeof update.checkedAt==='string'?Date.parse(update.checkedAt):NaN;
  const currentVersion=typeof update.currentVersion==='string' && update.currentVersion || '预览版';
  const [baseVersion,buildTag]=currentVersion.split(/-(.+)/);
  const version=typeof update.availableVersion==='string'?update.availableVersion:'';
  const showVersion=version && (canInstall || downloading || installing);
  const notes=typeof update.releaseNotes==='string' ? update.releaseNotes.trim() : '';
  const error=!running && (actionError || update.error);
  const retainedDownload=status==='downloaded' && Boolean(update.error);
  const statusText=retainedDownload?'安装未完成，已保留下载包':statusNames[status] || '尚未检查';

  async function check() {
    if (actionsDisabled || checkPending.current || store.snapshot().busy) return;
    checkPending.current=true;
    setChecking(true);
    setActionError('');
    try {
      const result=await write('checkForUpdates');
      if(result.state)store.patch({update:result.state});
    } catch(reason) {
      setActionError(reason instanceof Error?reason.message:String(reason));
    } finally {
      checkPending.current=false;
      setChecking(false);
    }
  }

  async function runInstall() {
    if (actionsDisabled || dirty) return;
    setActionError('');
    try { await install(); }
    catch(reason) { setActionError(reason instanceof Error?reason.message:String(reason)); }
  }

  return <div className="settings-updates">
    <div className="settings-updates-grid">
      <section className="settings-update-card" aria-label="版本状态" data-setting-label="版本状态" tabIndex={-1}>
        <div className="settings-update-head">
          <div>
            <h2>当前版本</h2>
            <div className="settings-update-ver-row">
              <span className="settings-update-version">{baseVersion}</span>
              {buildTag && <code className="settings-update-build" title={currentVersion}>-{buildTag}</code>}
            </div>
          </div>
          <p className="settings-update-state" data-state={retainedDownload?'error':status} role="status">
            {statusText}{showVersion && <span>{version}</span>}
          </p>
        </div>
        {(downloading || installing) && <div className="settings-update-progress">
          <progress aria-label={downloading?'更新进度':'安装进度'} max={100} value={percent}/>
          {downloading && <span>{percent===undefined?'进度未知':`${percent}%`}</span>}
        </div>}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {canInstall && <p className="settings-update-note">{dirty?'请先保存或放弃修改，再安装更新。':'安装完成后会重启 FlowHub。'}</p>}
        {Number.isFinite(checkedAt) && <p className="settings-update-note">上次检查 <time dateTime={update.checkedAt}>{dateFormat.format(checkedAt)}</time></p>}
        <div className="settings-update-actions">
          {canInstall && <Button variant="default" disabled={actionsDisabled || dirty} onClick={()=>void runInstall()}>
            {retainedDownload?'重试安装':status==='downloaded'?'重启安装':'下载并安装'}
          </Button>}
          <Button variant={canInstall?'ghost':error?'default':'outline'} disabled={actionsDisabled} onClick={()=>void check()}>检查更新</Button>
        </div>
        {showVersion && notes && <ViewDetails memoryKey={`updates:notes:${version}`} className="settings-update-notes">
          <summary>发布说明 <span>{version}</span></summary>
          <div>{notes}</div>
        </ViewDetails>}
      </section>
      <section className="settings-update-card settings-update-preferences" aria-labelledby="update-preferences">
        <div className="settings-update-preferences-heading">
          <h2 id="update-preferences">自动更新</h2>
          {!preview && <span className="settings-update-save-tag" data-dirty={preferencesDirty || undefined}>
            {preferencesDirty?'未保存 · 保存后生效':'保存后生效'}
          </span>}
        </div>
        <Toggle label="自动检查正式版" checked={autoCheck} disabled={preview}
          onChange={value=>store.edit(c=>{c.core.autoUpdateCheck=value;})} help="每 10 分钟检查正式版。" />
        <Toggle label="自动下载并重启安装" checked={autoInstall} disabled={preview}
          onChange={value=>store.edit(c=>{c.core.autoUpdateInstall=value;})}
          note={!autoCheck && autoInstall ? '启用自动检查后才会自动安装。' : undefined}/>
      </section>
    </div>
  </div>;
}
