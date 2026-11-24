import { useEffect, useRef, type RefObject } from 'react';
import { CircleCheckIcon, CircleDotIcon, LoaderCircleIcon, Redo2Icon, TriangleAlertIcon, Undo2Icon } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../shared/ui';
import { Help, Tooltip } from '../shared/controls';
import { shortcutKeys } from '../shared/shortcuts';
import { readonly } from './api';
import { SettingsStore, useSettings } from './store';

export function SettingsFooter({store,onReview,onReset,reviewTrigger,compact=false}: {store:SettingsStore;onReview():void;onReset():void;reviewTrigger:RefObject<HTMLButtonElement|null>;compact?:boolean}) {
  const s=useSettings(store),preview=readonly(),dirty=store.dirty;
  const statusRef = useRef<HTMLParagraphElement>(null);
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
  if (compact && state === 'saved' && s.config && !s.notice && !s.error && !s.redo.length) return null;
  const status=!s.config?(s.busy?'正在读取配置…':'配置未能加载'):s.busy?'正在处理配置…':s.conflict?'配置来源冲突，源草稿已保留':preview?'浏览器预览 · 不会保存配置':dirty?'有未保存修改':compact && !s.error && s.notice ? s.notice : '已保存';
  const Icon=s.busy?LoaderCircleIcon:s.conflict?TriangleAlertIcon:dirty?CircleDotIcon:CircleCheckIcon;
  const showNotice=s.notice && s.notice!==status;
  const showActions=!compact || (!preview && (dirty || s.redo.length > 0));
  async function save() {
    const trigger = document.activeElement;
    await store.run(()=>store.save());
    if (compact && !store.dirty) requestAnimationFrame(()=>{
      if (document.activeElement === trigger || document.activeElement === document.body) statusRef.current?.focus({preventScroll:true});
    });
  }
  return <footer aria-label="配置保存与状态" data-save-state={state} className="settings-footer flex flex-wrap items-center justify-between gap-3">
    <div className="settings-save-status"><Icon aria-hidden="true" className={s.busy?'settings-busy-icon':undefined} /><p ref={statusRef} role="status" tabIndex={compact ? -1 : undefined}>{status}</p>{dirty&&!preview?<Button ref={reviewTrigger} variant="ghost" size="sm" className="settings-review-trigger" aria-label="查看未保存修改" disabled={s.busy} onClick={onReview}>查看修改</Button>:null}{!compact && <Help label="草稿与保存">切换设置页时保留草稿。</Help>}</div>
    {showActions && <div className="settings-footer-actions flex flex-wrap gap-2">
      <Tooltip content={compact ? '撤销' : undefined}><Button size={compact ? 'icon-sm' : undefined} aria-label="撤销" disabled={preview || s.busy || !s.undo.length || s.conflict} onClick={()=>store.travel('undo')}>{compact ? <Undo2Icon aria-hidden="true"/> : '撤销'}</Button></Tooltip>
      <Tooltip content={compact ? '重做' : undefined}><Button size={compact ? 'icon-sm' : undefined} aria-label="重做" disabled={preview || s.busy || !s.redo.length || s.conflict} onClick={()=>store.travel('redo')}>{compact ? <Redo2Icon aria-hidden="true"/> : '重做'}</Button></Tooltip>
      {(!compact || dirty) && <><Button size={compact ? 'sm' : undefined} disabled={s.busy || !dirty} onClick={onReset}>重置未保存</Button><Tooltip content={`保存配置（${shortcutKeys.format('CommandOrControl+S')}）`}><Button size={compact ? 'sm' : undefined} aria-keyshortcuts={shortcutKeys.isMac()?'Meta+S':'Control+S'} className="primary settings-save-button" disabled={preview || s.busy || !dirty || s.conflict} onClick={()=>void save()}>{s.busy?'处理中…':'保存'}</Button></Tooltip></>}
    </div>}
    {s.error?<Alert variant="destructive" className="settings-footer-notice" tabIndex={0}><AlertDescription>{s.notice || '操作未完成，请重试。'}</AlertDescription></Alert>:showNotice?<p role="status" className="settings-footer-note">{s.notice}</p>:null}
  </footer>;
}
