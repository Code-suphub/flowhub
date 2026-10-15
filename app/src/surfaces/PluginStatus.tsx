import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { Button } from '../shared/ui';
import { Switch } from '../shared/controls';
import { Checkbox } from '../components/ui/checkbox';
import { Badge } from '../components/ui/badge';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../components/ui/field';
import { invoke, nativeHost } from '../shared/native';
import { collectedAt, demoStatus, initialOrder, keyMetric, labels, metric, refreshOrders, relativeTime, rowStatus, statusVariant, type Orders, type Preferences, type RowStatus, type Scope, type Status } from './status-model';

const scopes: Record<Scope, string> = { overview: '概览', all: '全部', favorites: '关注' };
export function PluginStatus() {
  const params = new URLSearchParams(location.search), id = params.get('id'), native = Boolean(nativeHost()?.core?.invoke), demo = !native && params.get('preview') === 'demo';
  const [data, setData] = useState<Status | null>(() => demo ? demoStatus(Date.now()) : null);
  const [draft, setDraft] = useState<Preferences>(() => demo ? demoStatus(Date.now()).preferences : { tray: false, pinned: false, favorites: [] });
  const [orders, setOrders] = useState<Orders>(() => {
    const sample = demo ? demoStatus(Date.now()) : null;
    return refreshOrders({ overview: [], all: [], favorites: [] }, sample?.snapshot?.rows || [], sample?.preferences.favorites || []);
  });
  const [scope, setScope] = useState<Scope>('overview'), [filter, setFilter] = useState<RowStatus | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]), [now, setNow] = useState(Date.now);
  const [message, setMessage] = useState(''), [readError, setReadError] = useState(''), [saving, setSaving] = useState(false);
  const dirty = useRef(false), pending = useRef(false), alive = useRef(true), savingRef = useRef(false), revision = useRef(0);
  const available = Boolean(native && id);
  const canConfigure = available && data !== null;
  const api = <T,>(action: string, payload: Record<string, unknown> = {}) => invoke<T>('plugin_status_api', { id, action, payload });
  function applyData(result: Status) {
    const rows = result.snapshot?.rows || [];
    setData(result); setNow(Date.now()); setReadError('');
    setOrders(previous => refreshOrders(previous, rows, result.preferences.favorites));
    const ids = new Set(rows.map(row => row.id));
    setExpanded(previous => previous.filter(value => ids.has(value)));
  }
  useEffect(() => {
    alive.current = true;
    if (!available && !demo) return;
    async function load() {
      if (document.hidden) return;
      setNow(Date.now());
      if (!available || pending.current || savingRef.current) return;
      pending.current = true;
      const version = revision.current;
      try {
        const result = await invoke<Status>('plugin_status_api', { id, action: 'get', payload: {} });
        if (!alive.current || version !== revision.current) return;
        applyData(result);
        if (!dirty.current) setDraft(result.preferences);
      } catch (error) { if (alive.current && version === revision.current) setReadError(`读取失败：${error instanceof Error ? error.message : String(error)}`); }
      finally { pending.current = false; }
    }
    void load(); const timer = setInterval(() => void load(), 15000);
    document.addEventListener('visibilitychange', load);
    return () => { alive.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [available, demo, id]);
  async function save() {
    if (!canConfigure || savingRef.current) return;
    savingRef.current = true; revision.current++;
    setSaving(true);
    try {
      const result = await api<Status>('save', { ...draft });
      if (alive.current) { applyData(result); setDraft(result.preferences); dirty.current = false; setMessage('显示设置已保存'); }
    } catch (error) { if (alive.current) setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { savingRef.current = false; if (alive.current) setSaving(false); }
  }
  function edit(next: Preferences) { dirty.current = true; setDraft(next); setMessage(''); }
  const rows = data?.snapshot?.rows || [], favorites = data?.preferences.favorites || [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const scoped = orders[scope].flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  const filtered = filter ? scoped.filter(row => rowStatus(row.status) === filter) : scoped;
  const visible = scope === 'overview' ? filtered.slice(0, 5) : filtered;
  const counts = Object.fromEntries(Object.keys(labels).map(status => [status, scoped.filter(row => rowStatus(row.status) === status).length]));
  function changeScope(next: Scope) {
    setOrders(previous => ({ ...previous, [next]: initialOrder(rows, favorites, next) }));
    setScope(next); setFilter(null);
  }
  const snapshot = data?.snapshot;
  const activity = demo ? '演示数据 · 只读预览，不连接采集服务' : !available ? '请在 FlowHub 中打开状态组件。' : !data ? readError ? '' : '正在读取缓存…' : !snapshot ? '等待插件状态，最多约 15 秒…' : snapshot.monitoring ? '后台采集中' : '后台采集未开启，显示已有缓存';
  const empty = !rows.length ? '暂无机器，请在插件中添加。' : scope === 'favorites' && !scoped.length ? '尚未关注机器，请在显示设置中勾选并保存。' : '当前筛选无结果。';
  return <main className="fh-root fh-status-page">
    <header><h1>{snapshot?.title || '插件状态'}</h1><Button disabled={!available} onClick={() => void api('plugin').catch(error => setMessage(String(error)))}>打开插件 ↗</Button></header>
    <p role="status" className="fh-status-activity">{activity}</p>
    {readError ? <p role="alert">{readError}{snapshot ? '，继续显示上次缓存。' : ''}</p> : null}
    {snapshot?.error ? <p role="alert">采集异常：{snapshot.error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {snapshot ? <>
      <nav className="fh-status-scopes" aria-label="查看范围">{(Object.entries(scopes) as [Scope, string][]).map(([value, label]) => <Button key={value} size="sm" variant={scope === value ? 'secondary' : 'ghost'} aria-pressed={scope === value} onClick={() => changeScope(value)}>{label}</Button>)}</nav>
      <div className="fh-status-summary" role="group" aria-label="状态筛选">
        <Button size="sm" variant="ghost" aria-pressed={filter === null} onClick={() => setFilter(null)}>全部状态 {scoped.length}</Button>
        {(Object.entries(labels) as [RowStatus, string][]).map(([status, label]) => <Button key={status} size="sm" variant="ghost" aria-pressed={filter === status} onClick={() => setFilter(previous => previous === status ? null : status)}><Badge variant={statusVariant(status)}>{label} {counts[status]}</Badge></Button>)}
      </div>
      <p className="fh-status-scope-note">{scopes[scope]} · {filter ? labels[filter] + ' · ' : ''}{scope === 'overview' ? `显示 ${visible.length} / ${filtered.length} 台，优先异常及关注` : `${visible.length} 台`}</p>
      <section aria-label="机器状态">{visible.map(row => {
        const open = expanded.includes(row.id), detailId = `status-details-${encodeURIComponent(row.id)}`, at = collectedAt(row.at), status = rowStatus(row.status);
        return <article className="fh-status-row" key={row.id} data-row-id={row.id}>
          <Button variant="ghost" className="fh-status-row-toggle" aria-expanded={open} aria-controls={detailId} onClick={() => setExpanded(previous => open ? previous.filter(id => id !== row.id) : [...previous, row.id])}>
            <strong className="fh-status-name">{row.name}</strong><Badge variant={statusVariant(status)}>{labels[status]}</Badge>
            <span className="fh-status-key-metric">{keyMetric(row)}</span><span className="fh-status-age">{relativeTime(row.at, now)}</span><ChevronDownIcon className={open ? 'fh-status-chevron open' : 'fh-status-chevron'} aria-hidden="true" />
          </Button>
          <div id={detailId} className="fh-status-row-details" hidden={!open}><dl>{(['cpu', 'memory', 'disk'] as const).map((key, index) => <div key={key}><dt>{['CPU', '内存', '磁盘'][index]}</dt><dd>{metric(row.values?.[key])}</dd></div>)}</dl>
            <small>{at ? <>采集于 <time dateTime={at.toISOString()}>{at.toLocaleString()}</time></> : '尚无有效采集时间'}</small>
          </div>
        </article>;
      })}
        {!visible.length ? <p className="fh-status-empty">{empty}</p> : null}
      </section>
      {scope === 'overview' && rows.length > visible.length ? <Button className="fh-status-show-all" variant="ghost" onClick={() => changeScope('all')}>查看全部 {rows.length} 台</Button> : null}
    </> : null}
    {available || demo ? <details className="fh-status-settings"><summary>显示设置</summary><div className="fh-row"><span>显示菜单栏状态</span><Switch label="显示菜单栏状态" checked={draft.tray} disabled={saving || !canConfigure} onChange={tray => edit({ ...draft, tray })}/></div>
      <Button disabled={!available || saving} onClick={() => void api('menu').catch(error => setMessage(String(error)))}>打开菜单栏下拉</Button>
      <div className="fh-row"><span>窗口始终置顶</span><Switch label="窗口始终置顶" checked={draft.pinned} disabled={saving || !canConfigure} onChange={pinned => edit({ ...draft, pinned })}/></div>
      <FieldSet><FieldLegend variant="label">关注机器</FieldLegend><p className="fh-status-scope-note">勾选并保存后可在“关注”范围查看，概览优先展示。</p>
        <FieldGroup className="fh-status-favorites">{rows.map(row => <Field key={row.id} orientation="horizontal" data-disabled={saving || !canConfigure}>
          <Checkbox id={`favorite-${row.id}`} checked={draft.favorites.includes(row.id)} disabled={saving || !canConfigure} onCheckedChange={checked => edit({ ...draft, favorites: checked ? [...new Set([...draft.favorites, row.id])] : draft.favorites.filter(value => value !== row.id) })} />
          <FieldLabel htmlFor={`favorite-${row.id}`}>{row.name}</FieldLabel>
        </Field>)}</FieldGroup>
      </FieldSet>
      <Button disabled={saving || !canConfigure} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</Button>
    </details> : null}
  </main>;
}
