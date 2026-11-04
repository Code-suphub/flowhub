import { useEffect, type RefObject } from 'react';
import { CircleCheckIcon, CircleDotIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../shared/ui';
import { Help, Tooltip } from '../shared/controls';
import { shortcutKeys } from '../shared/shortcuts';
import { readonly } from './api';
import { SettingsStore, useSettings } from './store';

export function SettingsFooter({store,onReview,onReset,reviewTrigger}: {store:SettingsStore;onReview():void;onReset():void;reviewTrigger:RefObject<HTMLButtonElement|null>}) {
  const s=useSettings(store),preview=readonly(),dirty=store.dirty;
  useEffect(()=>{
    const save=(event:KeyboardEvent)=>{
      if(event.defaultPrevented || event.isComposing || event.keyCode===229 || !event.metaKey && !event.ctrlKey || !shortcutKeys.matches(event,'CommandOrControl+S'))return;
      event.preventDefault();
      const current=store.snapshot();
      if(event.repeat || readonly() || current.busy || current.conflict || !current.config || !store.dirty || document.querySelector('[role=dialog]'))return;
      if([...document.querySelectorAll<HTMLElement>('[role=menu],[role=listbox]')].some(popup=>popup.getClientRects().length && getComputedStyle(popup).visibility!=='hidden'))return;
      void store.run(()=>store.save());
    };
    window.addEventListener('keydown',save);return()=>window.removeEventListener('keydown',save);
  },[store]);
  const state=s.busy?'busy':s.conflict?'conflict':preview?'preview':dirty?'dirty':'saved';
  const status=!s.config?(s.busy?'正在读取配置…':'配置未能加载'):s.busy?'正在处理配置…':s.conflict?'配置来源冲突，源草稿已保留':preview?'浏览器预览 · 不会保存配置':dirty?'有未保存修改':'已保存';
  const Icon=s.busy?LoaderCircleIcon:s.conflict?TriangleAlertIcon:dirty?CircleDotIcon:CircleCheckIcon;
  const showNotice=s.notice && s.notice!==status;
  return <footer aria-label="配置保存与状态" data-save-state={state} className="settings-footer flex flex-wrap items-center justify-between gap-3">
    <div className="settings-save-status"><Icon aria-hidden="true" className={s.busy?'settings-busy-icon':undefined} /><p role="status">{status}</p>{dirty&&!preview?<Button ref={reviewTrigger} variant="ghost" size="sm" className="settings-review-trigger" aria-label="查看未保存修改" disabled={s.busy} onClick={onReview}>查看修改</Button>:null}<Help label="草稿与保存">切换页面会保留未保存的配置草稿，保存后生效。使用 {shortcutKeys.format('CommandOrControl+S')} 保存；弹窗或快捷键录入期间不会触发全局保存。</Help></div>
    <div className="settings-footer-actions flex flex-wrap gap-2"><Button disabled={preview || s.busy || !s.undo.length || s.conflict} onClick={()=>store.travel('undo')}>撤销</Button><Button disabled={preview || s.busy || !s.redo.length || s.conflict} onClick={()=>store.travel('redo')}>重做</Button><Button disabled={s.busy || !dirty} onClick={onReset}>重置未保存</Button><Tooltip content={`保存配置（${shortcutKeys.format('CommandOrControl+S')}）`}><Button aria-keyshortcuts={shortcutKeys.isMac()?'Meta+S':'Control+S'} className="primary settings-save-button" disabled={preview || s.busy || !dirty || s.conflict} onClick={()=>void store.run(()=>store.save())}>{s.busy?'处理中…':'保存'}</Button></Tooltip></div>
    {s.error?<Alert variant="destructive" className="settings-footer-notice" tabIndex={0}><AlertDescription>{s.notice || '操作未完成，请重试。'}</AlertDescription></Alert>:showNotice?<p role="status" className="settings-footer-note">{s.notice}</p>:null}
  </footer>;
}
