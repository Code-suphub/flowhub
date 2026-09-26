import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, Input, Tabs } from '../shared/ui';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../components/ui/field';
import { api, available, getInvoke, refreshNavigation, type Candidate, type Installed, type Manifest, type Source } from './api';

const tabs = [{ id: 'discover', label: '发现' }, { id: 'installed', label: '已安装' }, { id: 'sources', label: '来源' }];
const blankSource = (): Source => ({ id: '', name: '', kind: 'local', location: '', key: '' });
type Confirmation = { title: string; detail: string; warning?: string; action: () => Promise<void> };
function Row({ title, children, actions }: { title: string; children: ReactNode; actions: ReactNode }) {
  return <article className="fh-row"><div className="fh-row-copy"><h2>{title}</h2><div className="fh-muted">{children}</div></div><div className="fh-actions">{actions}</div></article>;
}
export function Market() {
  const [tab, setTab] = useState('discover'), [installed, setInstalled] = useState<Installed[]>([]), [sources, setSources] = useState<Source[]>([]);
  const [found, setFound] = useState<Candidate[]>([]), [query, setQuery] = useState(''), [notice, setNotice] = useState(available ? '' : '浏览器预览只读，请在 FlowHub 设置中管理插件。');
  const [busy, setBusy] = useState(false), lock = useRef(false), [editing, setEditing] = useState<Source | null>(null), [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const disabled = busy || !available;
  async function refresh() {
    const [plugins, catalog] = await Promise.all([api<Installed[]>('list'), api<Source[]>('sources')]);
    setInstalled(plugins); setSources(catalog);
    await refreshNavigation();
  }
  async function run(action: () => Promise<void>, reload = true) {
    if (lock.current || !available) return;
    lock.current = true; setBusy(true); setNotice('');
    try { await action(); if (reload) await refresh(); }
    catch (error) { setNotice(String(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { if (available) void run(async () => {}, true); }, []);
  function install(manifest: Manifest, action: () => Promise<unknown>) {
    setConfirmation({ title: '安装插件', detail: `${manifest.name} · ${manifest.version}`, warning: '将在本机运行插件进程，可访问当前用户文件和网络。仅安装可信来源的插件。', action: async () => { await action(); setTab('installed'); setNotice('安装完成，入口已加入侧栏。'); } });
  }
  async function scan(list: Source[]) {
    const messages: string[] = [];
    for (const source of list) {
      try {
        const result = await api<{ plugins: Candidate[]; warnings: string[] }>('scanSource', { id: source.id });
        setFound(old => [...old.filter(item => item.source !== source.id), ...result.plugins]);
        messages.push(...result.warnings, `${source.name}：发现 ${result.plugins.length} 个插件`);
      } catch (error) { setFound(old => old.filter(item => item.source !== source.id)); messages.push(`${source.name}：${error}`); }
    }
    setNotice(messages.join('\n')); setTab('discover');
  }
  return <main className="fh-root fh-market" aria-busy={busy}>
    <header className="flex flex-wrap items-center justify-between gap-3 mb-3"><h1>插件市场</h1><div className="fh-actions">
      <Button disabled={disabled} onClick={() => void run(async () => { await getInvoke()!('plugin_canvas_api', { action: 'open', payload: {} }); }, false)}>桌面组件</Button>
      <Button disabled={disabled} onClick={() => void run(async () => { const selected = await api<{ manifest: Manifest; directory: string } | null>('choose'); if (selected) install(selected.manifest, () => api('install', { directory: selected.directory })); }, false)}>安装开发目录</Button>
    </div></header>
    <Tabs items={tabs} value={tab} onChange={setTab} label="插件市场" />
    {notice ? <p role="status" className="fh-muted whitespace-pre-wrap text-sm mb-3">{notice}</p> : null}
    <section id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {tab === 'discover' ? <><div className="flex flex-wrap gap-2 mb-2"><div className="w-full sm:w-64"><Input type="search" aria-label="搜索插件" placeholder="搜索插件名称或描述" value={query} onChange={e => setQuery(e.target.value)} /></div><Button disabled={disabled || !sources.length} onClick={() => void run(() => scan(sources), false)}>刷新来源</Button><Button onClick={() => setTab('sources')}>配置来源</Button></div>
        {found.filter(item => `${item.manifest.name} ${item.manifest.description || ''}`.toLowerCase().includes(query.toLowerCase())).map(item => <Row key={`${item.source}:${item.manifest.id}`} title={`${item.manifest.name} · ${item.manifest.version}`} actions={<Button disabled={disabled} onClick={() => install(item.manifest, () => api('installCandidate', { token: item.token }))}>{installed.some(p => p.manifest.id === item.manifest.id) ? '重新安装' : '安装'}</Button>}><p>{item.manifest.description}</p><p>来源：{sources.find(s => s.id === item.source)?.name}</p></Row>)}
        {!found.some(item => `${item.manifest.name} ${item.manifest.description || ''}`.toLowerCase().includes(query.toLowerCase())) ? <p className="fh-muted py-4">{query ? '没有匹配的插件。' : !sources.length ? '还没有插件来源，请先配置来源。' : '点击“刷新来源”查找可安装插件。'}</p> : null}
      </> : null}
      {tab === 'installed' ? <>{installed.map(item => <Row key={item.manifest.id} title={`${item.manifest.name} · ${item.manifest.version}${item.enabled ? '' : ' · 已停用'}`} actions={<>
        <Button disabled={disabled} onClick={() => void run(async () => { await api('reload', { id: item.manifest.id }); setNotice('重新加载完成'); })}>重新加载</Button>
        <Button disabled={disabled} onClick={() => void run(async () => { await api('enable', { id: item.manifest.id, enabled: !item.enabled }); })}>{item.enabled ? '停用' : '启用'}</Button>
        <Button className="danger" disabled={disabled} onClick={() => setConfirmation({ title: '卸载插件', detail: `确认卸载 ${item.manifest.name}？`, action: async () => { await api('uninstall', { id: item.manifest.id }); } })}>卸载</Button>
      </>}><p>{item.directory}</p><p>最近加载：{item.lastLoadedAt ? new Date(item.lastLoadedAt).toLocaleString() : '暂无记录'}</p></Row>)}{!installed.length ? <p className="fh-muted py-4">尚未安装插件。</p> : null}</> : null}
      {tab === 'sources' ? <><div className="flex justify-end"><Button disabled={disabled} onClick={() => setEditing(blankSource())}>添加来源</Button></div>{sources.map(source => <Row key={source.id} title={source.name} actions={<>
        <Button disabled={disabled} onClick={() => void run(() => scan([source]), false)}>扫描</Button><Button disabled={disabled} onClick={() => setEditing({ ...source })}>编辑</Button>
        <Button className="danger" disabled={disabled} onClick={() => setConfirmation({ title: '移除来源', detail: `移除 ${source.name}？不会卸载已安装的插件。`, action: async () => { await api('removeSource', { id: source.id }); setFound(old => old.filter(item => item.source !== source.id)); } })}>移除</Button>
      </>}><p>{source.kind === 'local' ? '本地目录' : 'HTTPS 仓库'} · {source.location}</p></Row>)}{!sources.length ? <p className="fh-muted py-4">还没有插件来源。</p> : null}</> : null}
    </section>
    {editing ? <Dialog notice={notice} title={editing.id ? '编辑来源' : '添加来源'} busy={busy} onClose={() => setEditing(null)}><form className="grid gap-4" onSubmit={event => { event.preventDefault(); void run(async () => { await api('saveSource', { ...editing, name: editing.name.trim(), location: editing.location.trim(), key: editing.kind === 'https' ? editing.key.trim() : '' }); setFound([]); setEditing(null); setNotice('来源已保存，可扫描插件。'); }); }}>
      <FieldGroup className="gap-4">
        <Field data-disabled={busy}><FieldLabel htmlFor="source-name">名称</FieldLabel><Input id="source-name" autoFocus required maxLength={100} disabled={busy} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></Field>
        <FieldSet className="border-0 p-0 m-0 gap-0"><FieldLegend variant="label">来源类型</FieldLegend><div className="flex gap-4">{(['local', 'https'] as const).map(kind => <label key={kind}><input type="radio" name="kind" value={kind} disabled={busy} checked={editing.kind === kind} onChange={() => setEditing({ ...editing, kind })} />{kind === 'local' ? '本地目录' : 'HTTPS 仓库'}</label>)}</div></FieldSet>
        <Field data-disabled={busy}><FieldLabel htmlFor="source-location">{editing.kind === 'local' ? '目录' : '仓库索引地址'}</FieldLabel><Input id="source-location" required disabled={busy} value={editing.location} onChange={e => setEditing({ ...editing, location: e.target.value })} /></Field>
        {editing.kind === 'local' ? <Button disabled={busy} onClick={() => void run(async () => { const path = await api<string | null>('chooseSource'); if (path) setEditing(old => old ? { ...old, location: path } : null); }, false)}>选择目录</Button> : <Field data-disabled={busy}><FieldLabel htmlFor="source-key">仓库签名公钥</FieldLabel><Input id="source-key" disabled={busy} value={editing.key} onChange={e => setEditing({ ...editing, key: e.target.value })} placeholder="minisign 公钥" /></Field>}
      </FieldGroup>
      <div className="flex justify-end gap-2"><Button disabled={busy} onClick={() => setEditing(null)}>取消</Button><Button className="primary" type="submit" disabled={busy}>保存来源</Button></div>
    </form></Dialog> : null}
    {confirmation ? <Dialog notice={notice} title={confirmation.title} busy={busy} onClose={() => setConfirmation(null)}><p>{confirmation.detail}</p>{confirmation.warning ? <p className="fh-warning">{confirmation.warning}</p> : null}<div className="flex justify-end gap-2 mt-4"><Button disabled={busy} onClick={() => setConfirmation(null)}>取消</Button><Button className="primary" disabled={busy} onClick={() => void run(async () => { await confirmation.action(); setConfirmation(null); })}>确认</Button></div></Dialog> : null}
  </main>;
}
