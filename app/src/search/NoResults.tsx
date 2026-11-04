import { SearchX } from 'lucide-react';
import { Button } from '../shared/ui';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import type { SearchSnapshot } from './types';

export function NoResults({snapshot, onClear, onSearchAll}: {snapshot: SearchSnapshot; onClear: () => void; onSearchAll: () => void}) {
  const query = String(snapshot.state.query || ''), scope = snapshot.state.scope;
  const scopeName = snapshot.state.plugins.find((plugin: {id: string}) => plugin.id === scope)?.name || '当前范围';
  const loading = Boolean(snapshot.paging.loading);
  return <Empty className="search-no-results" role="status">
    <EmptyHeader><EmptyMedia><SearchX aria-hidden="true"/></EmptyMedia><EmptyTitle>{loading ? '正在搜索…' : '没有匹配项'}</EmptyTitle>
      <EmptyDescription>{loading ? '搜索结果会在这里显示。' : scope === 'all' ? '试试更短的关键词，或清除搜索重新开始。' : `在${scopeName}中没有找到结果，可以保留关键词搜索全部范围。`}</EmptyDescription>
    </EmptyHeader>
    {!loading ? <EmptyContent className="search-recovery flex-row justify-center">
      {query ? <Button variant="outline" size="sm" className="tool-action" onClick={onClear}>清除搜索</Button> : null}
      {scope !== 'all' ? <Button variant="default" size="sm" className="tool-action" onClick={onSearchAll}>搜索全部范围</Button> : null}
    </EmptyContent> : null}
  </Empty>;
}
