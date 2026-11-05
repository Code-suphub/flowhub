import { useRef, type ComponentProps, type ReactNode } from 'react';
import { Dialog } from './ui';

// Both launcher palettes isolate input from the search controller and protect
// composition commits before the shared autocomplete handles Enter.
export function CommandDialog({title,onClose,initialFocus,className,children,notice,busy=false}: {
  title:string;onClose():void;initialFocus:ComponentProps<typeof Dialog>['initialFocus'];className?:string;children:ReactNode;notice?:string;busy?:boolean;
}) {
  const composing=useRef(false),compositionEnded=useRef(-Infinity);
  return <Dialog title={title} onClose={onClose} initialFocus={initialFocus} restoreFocus={false} className={`fh-command-dialog ${className || ''}`} notice={notice} busy={busy}>
    <div data-command-surface className="flex min-h-0 flex-1 flex-col" onCompositionStartCapture={()=>{composing.current=true;}} onCompositionEndCapture={()=>{composing.current=false;compositionEnded.current=performance.now();}} onKeyDownCapture={event=>{
      if(composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode===229 || event.key==='Process' || event.key==='Enter' && performance.now()-compositionEnded.current<80){event.stopPropagation();return;}
      if(event.key==='Enter' && (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)){event.preventDefault();event.stopPropagation();}
    }} onKeyDown={event=>{
      event.stopPropagation();
      if(event.key==='Escape' || event.key==='F6' || event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.code==='KeyK' || event.key.toLowerCase()==='k')){event.preventDefault();if(!busy)onClose();}
    }}>{children}</div>
  </Dialog>;
}
