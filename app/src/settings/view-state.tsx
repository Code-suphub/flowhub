import { createContext, useContext, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

// Per-window presentation memory. It is never serialized into user configuration
// or shared between settings windows / different data locations.
export type ViewMemory=Map<string,unknown>;
export const ViewStateContext=createContext<ViewMemory|null>(null);
export const useViewMemory=()=>useContext(ViewStateContext);
export function useViewState<T>(key:string,initial:T|(()=>T)):[T,Dispatch<SetStateAction<T>>] {
  const memory=useViewMemory();
  const [value,setValue]=useState<T>(()=>memory?.has(key)?memory.get(key) as T:typeof initial==='function'?(initial as ()=>T)():initial);
  useLayoutEffect(()=>{memory?.set(key,value);},[memory,key,value]);
  return [value,setValue];
}
export function useViewScroll(key:string) {
  const memory=useViewMemory(), ref=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{if(ref.current)ref.current.scrollTop=(memory?.get(key) as number) || 0;},[memory,key]);
  return {ref,onScroll:()=>{if(ref.current)memory?.set(key,ref.current.scrollTop);}};
}
