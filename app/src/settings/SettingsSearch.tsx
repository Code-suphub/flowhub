import { useMemo, useRef, useState } from 'react';
import { ArrowUpRightIcon, PuzzleIcon } from 'lucide-react';
import { Dialog } from '../shared/ui';
import { CommandSearch } from '../shared/CommandSearch';
import { Badge } from '../components/ui/badge';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../components/ui/empty';
import { navigationItems } from './navigation';
import { findSettings, type SettingsSearchEntry } from './settings-search';
import './settings-search.css';

export function SettingsSearch({onClose,onChoose}: {onClose():void;onChoose(entry:SettingsSearchEntry):{ok:boolean;error?:string}}) {
  const [query,setQuery]=useState(''),[error,setError]=useState('');
  const input=useRef<HTMLInputElement>(null),matches=useMemo(()=>findSettings(query),[query]);
  return <Dialog title="搜索设置" busy={false} onClose={onClose} initialFocus={input} notice={error} className="settings-search-dialog">
    <CommandSearch label="搜索设置项" placeholder="搜索设置、页面或操作入口…" inputRef={input} value={query} onValueChange={value=>{setQuery(value);setError('');}} items={matches} groupLabel={query.trim()?`${matches.length} 个匹配结果`:'常用设置与页面'} onChoose={entry=>{const result=onChoose(entry);if(!result.ok)setError(result.error || '当前无法切换，请先处理未完成的配置编辑。');}} renderItem={item=>{
      const page=navigationItems.find(page=>page.id===item.page),Icon=page?.Icon || PuzzleIcon;
      return <><span className="settings-search-result-icon"><Icon aria-hidden="true" /></span><span className="settings-search-result-copy"><strong>{item.label}</strong><small>{item.description ? `${item.kind==='页面'?'':`${page?.label} · `}${item.description}` : `${page?.group} / ${page?.label}`}</small></span><Badge variant="outline">{item.kind}</Badge><ArrowUpRightIcon className="settings-search-result-arrow" aria-hidden="true" /></>;
    }} empty={<Empty className="settings-search-empty"><EmptyHeader><EmptyTitle>没有匹配的设置</EmptyTitle><EmptyDescription>试试“留存天数”“开机启动”或“主题”。</EmptyDescription></EmptyHeader></Empty>} />
    <div className="settings-search-help flex flex-wrap items-center justify-between gap-2"><span><kbd>↑ ↓</kbd> 选择 <kbd>↵</kbd> 前往 <kbd>Esc</kbd> 关闭</span><span>仅定位，不自动执行操作</span></div>
  </Dialog>;
}
