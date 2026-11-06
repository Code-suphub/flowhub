import { useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent } from 'react';

export type MarketItemNavigation = Pick<HTMLAttributes<HTMLElement>, 'tabIndex' | 'onFocusCapture' | 'onPointerDownCapture' | 'onKeyDown' | 'aria-describedby'> & {'data-market-key':string};
type Selection = {context:string;key:string;index:number};

/** One card is a tab stop. Its actions remain reachable with Tab; arrows never run them. */
export function useMarketNavigation({view,context,keys,limit,onReveal}: {view:string;context:string;keys:string[];limit:number;onReveal(limit:number):void}) {
  const list=useRef<HTMLDivElement>(null), pending=useRef<{context:string;key:string;scroll:boolean}|null>(null);
  const focused=useRef(false), column=useRef<number|null>(null), frame=useRef<number|undefined>(undefined);
  const [selections,setSelections]=useState<Record<string,Selection>>({});
  const saved=selections[view], savedIndex=saved?.context===context?keys.indexOf(saved.key):-1;
  const index=savedIndex>=0?savedIndex:saved?.context===context?Math.min(saved.index,keys.length-1):0;
  const activeKey=keys[Math.max(0,index)];
  const current=useRef({context,keys,activeKey});current.current={context,keys,activeKey};
  const element=(key:string)=>Array.from(list.current?.querySelectorAll<HTMLElement>('[data-market-key]') || []).find(node=>node.dataset.marketKey===key);
  function select(key:string) {
    const index=keys.indexOf(key);if(index<0)return;
    setSelections(old=>old[view]?.context===context && old[view].key===key?old:{...old,[view]:{context,key,index}});
  }
  function focusAt(index:number,scroll=true) {
    if(!keys.length)return;
    const target=Math.max(0,Math.min(keys.length-1,index)),key=keys[target];
    pending.current={context,key,scroll};
    if(target>=limit)onReveal(Math.ceil((target+1)/24)*24);
    select(key);
    // The target may already be active; a render is not required in that case.
    const node=element(key);
    if(node){pending.current=null;node.focus({preventScroll:true});if(scroll)node.scrollIntoView({block:'nearest',inline:'nearest'});}
  }
  useLayoutEffect(()=>{
    const target=pending.current;
    if(target?.context!==context){pending.current=null;return;}
    const node=element(target.key);
    if(node){pending.current=null;node.focus({preventScroll:true});if(target.scroll)node.scrollIntoView({block:'nearest',inline:'nearest'});}
  });
  useLayoutEffect(()=>{
    // A refresh can remove the focused record. Keep the nearest surviving card,
    // without moving focus out of a search field, menu or dialog.
    if(focused.current && document.activeElement===document.body){
      const node=activeKey && element(activeKey);if(node)node.focus({preventScroll:true});
      else document.getElementById('market-query')?.focus({preventScroll:true});
    }
  },[activeKey,context,keys.join('\0')]);
  useLayoutEffect(()=>()=>{if(frame.current!==undefined)cancelAnimationFrame(frame.current);},[]);
  function restore(origin:{context:string;key:string}) {
    if(frame.current!==undefined)cancelAnimationFrame(frame.current);
    frame.current=requestAnimationFrame(()=>{
      frame.current=undefined;
      if(current.current.context!==origin.context || document.querySelector('[role="dialog"]'))return;
      const active=document.activeElement;
      if(active!==document.body && !active?.hasAttribute('data-base-ui-focus-guard'))return;
      const node=element(origin.key) || (current.current.activeKey && element(current.current.activeKey));
      (node || document.getElementById('market-query'))?.focus({preventScroll:true});
    });
  }
  function navigate(event:KeyboardEvent<HTMLElement>,key:string,onEnter:()=>void) {
    if(event.target!==event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode===229)return;
    const index=keys.indexOf(key);if(index<0)return;
    if(event.key==='Enter'){event.preventDefault();event.stopPropagation();if(!event.repeat)onEnter();return;}
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();document.getElementById('market-query')?.focus();return;}
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    // Layout is read only for an explicit navigation key, never while typing.
    const columns=view==='discover'?Math.max(1,(getComputedStyle(list.current!).gridTemplateColumns || '').split(/\s+/).filter(value=>value && value!=='none').length):1;
    const row=Math.floor(index/columns), lastRow=Math.floor((keys.length-1)/columns), preferred=Math.min(columns-1,column.current ?? index%columns);
    let next=index;
    if(event.key==='Home')next=0;
    if(event.key==='End')next=Math.min(limit,keys.length)-1;
    if(event.key==='PageDown')next=Math.min(keys.length-1,index+24);
    if(event.key==='PageUp')next=Math.max(0,index-24);
    if(event.key==='ArrowLeft' && index%columns>0)next=index-1;
    if(event.key==='ArrowRight' && index%columns<columns-1)next=Math.min(keys.length-1,index+1);
    if(event.key==='ArrowDown' && row<lastRow)next=Math.min(keys.length-1,(row+1)*columns+preferred);
    if(event.key==='ArrowUp' && row>0)next=(row-1)*columns+preferred;
    if(['ArrowDown','ArrowUp'].includes(event.key))column.current ??=index%columns;else column.current=next%columns;
    focusAt(next);
  }
  return {list,activeKey,restore,focusAt,focusActions:(key:string)=>element(key)?.querySelector<HTMLElement>('button:not(:disabled),summary')?.focus({preventScroll:true}),
    searchKeyDown:(event:KeyboardEvent<HTMLInputElement>)=>{
      if(event.key!=='ArrowDown' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode===229 || !keys.length)return;
      event.preventDefault();column.current=null;focusAt(Math.max(0,keys.indexOf(activeKey)));
    },
    blur:(event:React.FocusEvent)=>{if(!list.current?.contains(event.relatedTarget as Node|null))focused.current=false;},
    item:(key:string,onEnter:()=>void):MarketItemNavigation=>({'data-market-key':key,tabIndex:key===activeKey?0:-1,'aria-describedby':'market-browse-hint',onPointerDownCapture:()=>{column.current=null;},onFocusCapture:event=>{if(!list.current?.contains(event.relatedTarget as Node|null))column.current=null;focused.current=true;select(key);},onKeyDown:event=>navigate(event,key,onEnter)}),
  };
}
