import { useMemo, useState } from 'react';
import { CheckIcon, ArrowUpRightIcon } from 'lucide-react';
import { Button } from '../shared/ui';
import { Badge } from '../components/ui/badge';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { configChanges, changeGroup, changeLabel, changeValue, collectionChangeSummary } from './config-changes';
import type { PageId } from './navigation';
import './changes.css';

export function ConfigChanges({ before, after, onNavigate, disabled = false }: { before: unknown; after: unknown; onNavigate?(page: PageId): void; disabled?: boolean }) {
  const changes = useMemo(() => configChanges(before, after), [before, after]);
  const [limit, setLimit] = useState(100);
  const groups = useMemo(() => {
    const groups = new Map<string, { page: PageId | null; changes: typeof changes }>();
    for (const change of changes.slice(0,limit)) {
      const group = changeGroup(change.path), entry = groups.get(group.label) || { page:group.page, changes:[] };
      entry.changes.push(change); groups.set(group.label,entry);
    }
    return groups;
  }, [changes,limit]);
  if (!changes.length) return <Empty className="settings-changes-empty"><EmptyHeader><EmptyMedia variant="icon"><CheckIcon /></EmptyMedia><EmptyTitle>没有配置差异</EmptyTitle></EmptyHeader></Empty>;
  return <div className="settings-changes flex min-w-0 flex-col gap-5">
    <p className="settings-changes-count">{changes.length} 项变更 · {new Set(changes.map(change=>changeGroup(change.path).label)).size} 个分组</p>
    {[...groups].map(([label,group])=><section key={label} className="settings-changes-group" aria-label={`${label}的变更`}>
      <header className="flex flex-wrap items-center justify-between gap-2"><h3>{label}</h3>{group.page && onNavigate ? <Button disabled={disabled} variant="ghost" size="sm" onClick={()=>onNavigate(group.page!)}>前往{label}<ArrowUpRightIcon data-icon="inline-end" /></Button>:null}</header>
      <ul className="settings-changes-list">{group.changes.map(change=><li key={JSON.stringify(change.path)}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><strong>{changeLabel(change.path)}</strong><Badge variant="outline">{change.kind==='add'?'新增':change.kind==='remove'?'移除':'修改'}</Badge></div>
        <code className="settings-change-path">{change.path.join('.') || '(根)'}</code>
        <dl className="settings-change-values grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2"><div><dt>原值</dt><dd>{changeValue(change.before,change.path)}</dd></div><div><dt>新值</dt><dd>{changeValue(change.after,change.path)}</dd></div></dl>
        {collectionChangeSummary(change) ? <p className="settings-collection-change">{collectionChangeSummary(change)}</p> : null}
      </li>)}</ul>
    </section>)}
    {changes.length>limit ? <Button onClick={()=>setLimit(limit+100)}>显示更多（剩余 {changes.length-limit} 项）</Button>:null}
  </div>;
}
