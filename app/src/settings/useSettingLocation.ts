import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { PageId } from './navigation';
import type { SettingTarget } from './settings-search';

export function locateSetting(main: HTMLElement, target: SettingTarget): HTMLElement | null {
  return [...main.querySelectorAll<HTMLElement>('[data-setting-label]')].find(row=>row.dataset.settingLabel===target.label) || null;
}
export function settingControl(row: HTMLElement, label?: string): HTMLElement {
  const controls=[...(label?row:row.querySelector(':scope > [data-setting-control]') || row).querySelectorAll<HTMLElement>('input,textarea,button,[role=switch],[role=combobox]')].filter(control=>!control.matches(':disabled,[aria-disabled=true],[data-disabled],input[type=hidden]') && control.getClientRects().length);
  const named=label?controls.find(control=>(control.getAttribute('aria-label') || control.textContent?.trim())===label):controls[0];
  return named || row;
}

// Two frames allow the shared Dialog to restore its trigger first. A newer
// pointer/key action cancels this explicit jump instead of stealing focus.
export function useSettingLocation(main: RefObject<HTMLElement|null>, page: PageId, ready: boolean, source: string) {
  const pending=useRef<{page:PageId;target?:SettingTarget;source:string;interaction:number}|null>(null), interaction=useRef(0);
  const [request,setRequest]=useState(0);
  useEffect(()=>{
    const advance=()=>{interaction.current++;};
    window.addEventListener('pointerdown',advance,true);window.addEventListener('keydown',advance,true);
    return()=>{window.removeEventListener('pointerdown',advance,true);window.removeEventListener('keydown',advance,true);};
  },[]);
  useLayoutEffect(()=>{
    const next=pending.current;
    if(!next || !ready)return;
    if(next.page!==page || next.source!==source){pending.current=null;return;}
    let row:HTMLElement|null=null,timer:number|undefined,frame=0;
    frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>{
      pending.current=null;
      if(next.interaction!==interaction.current || !main.current)return;
      if(!next.target){main.current.focus({preventScroll:true});return;}
      row=locateSetting(main.current,next.target);
      if(!row){main.current.focus({preventScroll:true});return;}
      for(let parent:HTMLElement|null=row;parent && main.current.contains(parent);parent=parent.parentElement)if(parent.tagName==='DETAILS')(parent as HTMLDetailsElement).open=true;
      row.dataset.settingHighlight='true';
      const control=settingControl(row,next.target.control);
      control.focus({preventScroll:true});control.scrollIntoView?.({block:'center',inline:'nearest'});
      timer=window.setTimeout(()=>{if(row)delete row.dataset.settingHighlight;},4000);
    });});
    return()=>{cancelAnimationFrame(frame);if(timer!==undefined)window.clearTimeout(timer);if(row)delete row.dataset.settingHighlight;};
  },[request,page,ready,source,main]);
  return (destination:PageId,target?:SettingTarget)=>{pending.current={page:destination,target,source,interaction:interaction.current};setRequest(value=>value+1);};
}
