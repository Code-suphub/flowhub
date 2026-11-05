import { useMemo, type ReactNode, type RefObject } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { SearchIcon, XIcon } from 'lucide-react';
import { Button, Input } from './ui';
import './command-search.css';

export function CommandSearch<T extends {id:string;label:string}>({items,value,onValueChange,onChoose,inputRef,label,placeholder,groupLabel,renderItem,empty,listLabel='设置搜索结果',clearLabel='清除设置搜索',isItemDisabled,onHighlight}: {
  items:readonly T[];value:string;onValueChange(value:string):void;onChoose(item:T):void;inputRef:RefObject<HTMLInputElement|null>;
  label:string;placeholder:string;groupLabel:string;renderItem(item:T):ReactNode;empty:ReactNode;
  listLabel?:string;clearLabel?:string;isItemDisabled?(item:T):boolean;
  onHighlight?(item:T|undefined):void;
}) {
  const groups=useMemo(()=>[{label:groupLabel,items}],[groupLabel,items]);
  return <Autocomplete.Root items={groups} inline open mode="none" autoHighlight="always" highlightItemOnHover={false} keepHighlight value={value} onItemHighlighted={onHighlight} onValueChange={(next,details)=>{if(details.reason!=='item-press')onValueChange(next);}} itemToStringValue={item=>item.label}>
    <Autocomplete.InputGroup className="fh-command-input flex min-w-0 items-center gap-2"><SearchIcon aria-hidden="true" /><Autocomplete.Input ref={inputRef} render={<Input />} aria-label={label} placeholder={placeholder} autoComplete="off" spellCheck={false} onKeyDownCapture={event=>{if((event.nativeEvent.isComposing || event.nativeEvent.keyCode===229) && event.key==='Enter')event.stopPropagation();}} />{value?<Button variant="ghost" size="icon-sm" aria-label={clearLabel} onClick={()=>{onValueChange('');inputRef.current?.focus();}}><XIcon /></Button>:null}</Autocomplete.InputGroup>
    <Autocomplete.List className="fh-command-list" aria-label={listLabel}><Autocomplete.Group items={items}><Autocomplete.GroupLabel className="fh-command-group-label">{groupLabel}</Autocomplete.GroupLabel><Autocomplete.Collection>{(item:T,index:number)=><Autocomplete.Item key={item.id} value={item} index={index} disabled={isItemDisabled?.(item)} data-command-id={item.id} className="fh-command-item" onClick={event=>{event.preventDefault();if(!isItemDisabled?.(item))onChoose(item);}}>{renderItem(item)}</Autocomplete.Item>}</Autocomplete.Collection></Autocomplete.Group>{!items.length?empty:null}</Autocomplete.List>
  </Autocomplete.Root>;
}
