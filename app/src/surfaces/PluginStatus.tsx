import { useEffect, useRef, useState } from 'react';
import { Button } from '../shared/ui';
import { Help, Switch } from '../shared/controls';
import { Checkbox } from '../components/ui/checkbox';
import { Badge } from '../components/ui/badge';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../components/ui/field';
import { invoke, nativeHost } from '../shared/native';

interface Row {id: string; name: string; status: string; at?: number; values?: {cpu?: number; memory?: number; disk?: number}}
interface Preferences {tray: boolean; pinned: boolean; favorites: string[]}
interface Status {snapshot?: {title?: string; error?: string; monitoring?: boolean; rows?: Row[]}; preferences: Preferences}
const labels: Record<string, string> = {healthy: '正常', error: '异常', stale: '已过期', unknown: '未采集'};
const statusVariant = (status: string) => status === 'healthy' ? 'healthy' : status === 'stale' ? 'stale' : status === 'error' ? 'destructive' : 'outline';
export function PluginStatus() {
  const [data, setData] = useState<Status | null>(null), [draft, setDraft] = useState<Preferences>({tray: false, pinned: false, favorites: []});
  const [message, setMessage] = useState('正在读取缓存…'), [saving, setSaving] = useState(false);
  const dirty = useRef(false), pending = useRef(false), alive = useRef(true), savingRef = useRef(false), revision = useRef(0);
  const id = new URLSearchParams(location.search).get('id');
  const available = Boolean(nativeHost()?.core?.invoke && id);
  const api = <T,>(action: string, payload: Record<string, unknown> = {}) => invoke<T>('plugin_status_api', {id, action, payload});
  useEffect(() => {
    alive.current = true;
    if (!available) {setMessage('请在 FlowHub 中打开状态组件。');return;}
    async function load() {
      if (pending.current || savingRef.current || document.hidden) return;
      pending.current = true;
      const version = revision.current;
      try {
        const result = await invoke<Status>('plugin_status_api', {id, action: 'get', payload: {}});
        if (!alive.current || version !== revision.current) return;
        setData(result);
        if (!dirty.current) setDraft(result.preferences);
        setMessage(!result.snapshot ? '等待插件状态，最多约 15 秒…' : result.snapshot.error || (result.snapshot.monitoring ? '后台采集中' : '后台采集未开启，显示已有缓存'));
      } catch (error) {if (alive.current && version === revision.current) setMessage(String(error));}
      finally {pending.current = false;}
    }
    void load();const timer = setInterval(() => void load(), 15000);
    document.addEventListener('visibilitychange', load);
    return () => {alive.current = false;clearInterval(timer);document.removeEventListener('visibilitychange', load);};
  }, [available, id]);
  async function save() {
    if (!available || savingRef.current) return;
    savingRef.current = true;revision.current++;
    setSaving(true);
    try {const result = await api<Status>('save', {...draft});if (alive.current) {setData(result);setDraft(result.preferences);dirty.current = false;setMessage('显示设置已保存');}}
    catch (error) {if (alive.current) setMessage(String(error));}
    finally {savingRef.current = false;if (alive.current) setSaving(false);}
  }
  function edit(next: Preferences) {dirty.current = true;setDraft(next);}
  const rows = data?.snapshot?.rows || [], favorites = data?.preferences.favorites || [];
  const visible = rows.filter(row => !favorites.length || favorites.includes(row.id));
  return <main className="fh-root fh-status-page">
    <header><h1>{data?.snapshot?.title || '插件状态'} <Help>每 15 秒读取采集缓存。关闭窗口可从菜单栏重新打开。</Help></h1><Button disabled={!available} onClick={() => void api('plugin').catch(error => setMessage(String(error)))}>打开插件 ↗</Button></header>
    <p role="status">{message}</p>
    <div className="fh-status-summary">{Object.entries(labels).map(([key, label]) => <Badge key={key} variant={statusVariant(key)}>{label} {visible.filter(row => row.status === key).length}</Badge>)}</div>
    <section aria-label="机器状态">{visible.map(row => <article className="fh-status-row" key={row.id}><header><strong>{row.name}</strong><Badge variant={statusVariant(row.status)}>{Object.hasOwn(labels,row.status) ? labels[row.status] : labels.unknown}</Badge></header>
      {row.values ? <dl>{(['cpu', 'memory', 'disk'] as const).map((key, index) => <div key={key}><dt>{['CPU', '内存', '磁盘'][index]}</dt><dd>{Number.isFinite(row.values?.[key]) ? row.values![key]!.toFixed(1) + '%' : '—'}</dd></div>)}</dl> : null}
      <small>{row.at ? '采集于 ' + new Date(row.at).toLocaleString() : '尚无采集数据'}</small></article>)}
      {data?.snapshot && !visible.length ? <p>暂无机器，请在插件中添加。</p> : null}
    </section>
    {available ? <details><summary>显示设置</summary><div className="fh-row"><span>显示菜单栏状态</span><Switch label="显示菜单栏状态" checked={draft.tray} disabled={saving} onChange={tray => edit({...draft, tray})}/></div>
      <Button onClick={() => void api('menu').catch(error => setMessage(String(error)))}>打开菜单栏下拉</Button>
      <div className="fh-row"><span>窗口始终置顶</span><Switch label="窗口始终置顶" checked={draft.pinned} disabled={saving} onChange={pinned => edit({...draft, pinned})}/></div>
      <FieldSet><FieldLegend variant="label">关注机器 <Help>未勾选时显示全部机器。</Help></FieldLegend>
        <FieldGroup className="fh-status-favorites">{rows.map(row => <Field key={row.id} orientation="horizontal" data-disabled={saving}>
          <Checkbox id={`favorite-${row.id}`} checked={draft.favorites.includes(row.id)} disabled={saving} onCheckedChange={checked => edit({...draft, favorites: checked ? [...draft.favorites, row.id] : draft.favorites.filter(value => value !== row.id)})} />
          <FieldLabel htmlFor={`favorite-${row.id}`}>{row.name}</FieldLabel>
        </Field>)}</FieldGroup>
      </FieldSet>
      <Button disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</Button>
    </details> : null}
  </main>;
}
