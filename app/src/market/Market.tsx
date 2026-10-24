import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BlocksIcon, PuzzleIcon, SparklesIcon } from 'lucide-react';
import { Button, Dialog, Input, Tabs } from '../shared/ui';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../components/ui/field';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { api, available, refreshNavigation, type Candidate, type Installed, type Manifest, type Source } from './api';
import './market.css';

const tabs = [{ id: 'discover', label: '发现' }, { id: 'installed', label: '已安装' }, { id: 'sources', label: '来源' }];
const blankSource = (): Source => ({ id: '', name: '', kind: 'local', location: '', key: '' });
type Confirmation = { title: string; detail: string; warning?: string; action: () => Promise<void> };
function Row({ title, version, children, actions }: { title: string; version?: string; children: ReactNode; actions: ReactNode }) {
  return <article className="fh-market-row"><div className="fh-market-row-copy"><div className="fh-market-title"><span className="fh-market-icon" aria-hidden="true">{title.trim().slice(0, 1)}</span><div className="fh-market-title-copy"><h2 title={title}>{title}</h2>{version ? <span className="fh-market-version">{version}</span> : null}</div></div><div className="fh-market-copy">{children}</div></div><div className="fh-market-actions">{actions}</div></article>;
}
function MarketEmpty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <Empty className="fh-market-empty"><div className="fh-market-empty-art" aria-hidden="true"><span><BlocksIcon /></span><span><PuzzleIcon /></span><span><SparklesIcon /></span></div><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader>{action}</Empty>;
}
function Location({ value, label }: { value: string; label: string }) {
  return <details className="fh-market-location"><summary>{label}</summary><code>{value}</code></details>;
}
export function Market() {
  const [tab, setTab] = useState('discover'), [installed, setInstalled] = useState<Installed[]>([]), [sources, setSources] = useState<Source[]>([]);
  const [found, setFound] = useState<Candidate[]>([]), [query, setQuery] = useState(''), [notice, setNotice] = useState(''), [noticeError, setNoticeError] = useState(false);
  const [busy, setBusy] = useState(false), lock = useRef(false), [editing, setEditing] = useState<Source | null>(null), [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const disabled = busy || !available;
  const embedded = typeof window !== 'undefined' && window.parent !== window;
  async function refresh() {
    const [plugins, catalog] = await Promise.all([api<Installed[]>('list'), api<Source[]>('sources')]);
    setInstalled(plugins); setSources(catalog);
    await refreshNavigation();
  }
  async function run(action: () => Promise<void>, reload = true) {
    if (lock.current || !available) return;
    lock.current = true; setBusy(true); setNotice(''); setNoticeError(false);
    try { await action(); if (reload) await refresh(); }
    catch (error) { setNotice(String(error)); setNoticeError(true); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { if (available) void run(async () => {}, true); }, []);
  function install(manifest: Manifest, action: () => Promise<unknown>) {
    setConfirmation({ title: '安装插件', detail: `${manifest.name} · ${manifest.version}`, warning: '将在本机运行插件进程，可访问当前用户文件和网络。仅安装可信来源的插件。', action: async () => { await action(); setTab('installed'); setNotice('安装完成，入口已加入底部插件栏。'); } });
  }
  async function scan(list: Source[]) {
    const messages: string[] = []; let hasError = false;
    for (const source of list) {
      try {
        const result = await api<{ plugins: Candidate[]; warnings: string[] }>('scanSource', { id: source.id });
        setFound(old => [...old.filter(item => item.source !== source.id), ...result.plugins]);
        messages.push(...result.warnings, `${source.name}：发现 ${result.plugins.length} 个插件`);
      } catch (error) { hasError = true; setFound(old => old.filter(item => item.source !== source.id)); messages.push(`${source.name}：${error}`); }
    }
    setNotice(messages.join('\n')); setNoticeError(hasError); setTab('discover');
  }
  return <main className={`fh-root fh-market${embedded ? ' fh-market-embedded' : ''}`} aria-busy={busy}>
    {(!embedded || available) ? <header className="fh-market-toolbar" aria-label="插件市场操作">{!embedded ? <h1>插件市场</h1> : null}{available ? <div className="fh-market-toolbar-actions">
      <Button disabled={disabled} onClick={() => void run(async () => { const selected = await api<{ manifest: Manifest; directory: string } | null>('choose'); if (selected) install(selected.manifest, () => api('install', { directory: selected.directory })); }, false)}>安装开发目录</Button>
    </div> : null}</header> : null}
    <Tabs items={tabs} value={tab} onChange={setTab} label="插件市场" />
    {notice ? <p role={noticeError ? 'alert' : 'status'} className="fh-muted whitespace-pre-wrap text-sm mb-3">{notice}</p> : null}
    <section className="fh-market-panel" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {tab === 'discover' ? <>{sources.length ? <div className="flex flex-wrap gap-2 mb-2"><div className="w-full sm:w-64"><Input type="search" aria-label="搜索插件" placeholder="搜索插件名称或描述" value={query} onChange={e => setQuery(e.target.value)} /></div><Button disabled={disabled} onClick={() => void run(() => scan(sources), false)}>刷新来源</Button><Button onClick={() => setTab('sources')}>管理来源</Button></div> : null}
        {found.filter(item => `${item.manifest.name} ${item.manifest.description || ''}`.toLowerCase().includes(query.toLowerCase())).map(item => <Row key={`${item.source}:${item.manifest.id}`} title={item.manifest.name} version={item.manifest.version} actions={<Button disabled={disabled} onClick={() => install(item.manifest, () => api('installCandidate', { token: item.token }))}>{installed.some(p => p.manifest.id === item.manifest.id) ? '重新安装' : '安装'}</Button>}><p>{item.manifest.description || '暂无描述'}</p><p className="fh-market-meta">来源：{sources.find(s => s.id === item.source)?.name || '未知来源'}</p></Row>)}
        {!found.some(item => `${item.manifest.name} ${item.manifest.description || ''}`.toLowerCase().includes(query.toLowerCase())) ? <MarketEmpty title={query ? '没有匹配的插件' : !sources.length ? '还没有插件来源' : '尚未发现插件'} description={query ? '试试其他关键词。' : !sources.length ? available ? '添加本地目录或 HTTPS 仓库，然后扫描插件。' : '在桌面 App 添加来源后，可在这里发现插件。' : '点击“刷新来源”查找可安装插件。'} action={!sources.length && available?<Button className="primary" onClick={() => setTab('sources')}>添加来源</Button>:null} /> : null}
      </> : null}
      {tab === 'installed' ? <>{installed.map(item => <Row key={item.manifest.id} title={item.manifest.name} version={item.manifest.version} actions={<>
        <Button disabled={disabled} onClick={() => void run(async () => { await api('reload', { id: item.manifest.id }); setNotice('重新加载完成'); })}>重新加载</Button>
        <Button disabled={disabled} onClick={() => void run(async () => { await api('enable', { id: item.manifest.id, enabled: !item.enabled }); })}>{item.enabled ? '停用' : '启用'}</Button>
        <Button className="danger" disabled={disabled} onClick={() => setConfirmation({ title: '卸载插件', detail: `确认卸载 ${item.manifest.name}？`, action: async () => { await api('uninstall', { id: item.manifest.id }); } })}>卸载</Button>
      </>}><p className="fh-market-meta"><span className={item.enabled ? 'fh-market-enabled' : 'fh-market-disabled'}>{item.enabled ? '已启用' : '已停用'}</span><span>最近加载：{item.lastLoadedAt ? new Date(item.lastLoadedAt).toLocaleString() : '暂无记录'}</span></p><Location value={item.directory} label="查看本机目录" /></Row>)}{!installed.length ? <MarketEmpty title="尚未安装插件" description="从“发现”页面安装插件。" /> : null}</> : null}
      {tab === 'sources' ? <><div className="flex justify-end">{available && sources.length ? <Button className="primary" disabled={disabled} onClick={() => setEditing(blankSource())}>添加来源</Button> : null}</div>{sources.map(source => <Row key={source.id} title={source.name} actions={<>
        <Button disabled={disabled} onClick={() => void run(() => scan([source]), false)}>扫描</Button><Button disabled={disabled} onClick={() => setEditing({ ...source })}>编辑</Button>
        <Button className="danger" disabled={disabled} onClick={() => setConfirmation({ title: '移除来源', detail: `移除 ${source.name}？不会卸载已安装的插件。`, action: async () => { await api('removeSource', { id: source.id }); setFound(old => old.filter(item => item.source !== source.id)); } })}>移除</Button>
      </>}><p className="fh-market-meta">{source.kind === 'local' ? '本地目录' : 'HTTPS 仓库'}</p><Location value={source.location} label="查看来源位置" /></Row>)}{!sources.length ? <MarketEmpty title="还没有插件来源" description={available ? '支持本地目录和 HTTPS 仓库。' : '请在桌面 App 添加来源。'} action={available?<Button className="primary" onClick={() => setEditing(blankSource())}>添加来源</Button>:null} /> : null}</> : null}
    </section>
    {editing ? <Dialog className="fh-market-dialog" notice={noticeError ? notice : undefined} title={editing.id ? '编辑来源' : '添加来源'} busy={busy} onClose={() => setEditing(null)}><form className="grid gap-4" onSubmit={event => { event.preventDefault(); void run(async () => { await api('saveSource', { ...editing, name: editing.name.trim(), location: editing.location.trim(), key: editing.kind === 'https' ? editing.key.trim() : '' }); setFound([]); setEditing(null); setNotice('来源已保存，可扫描插件。'); }); }}>
      <FieldGroup className="gap-4">
        <Field data-disabled={busy}><FieldLabel htmlFor="source-name">名称</FieldLabel><Input id="source-name" autoFocus required maxLength={100} disabled={busy} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></Field>
        <FieldSet className="border-0 p-0 m-0 gap-0"><FieldLegend variant="label">来源类型</FieldLegend><RadioGroup className="flex gap-4" value={editing.kind} disabled={busy} onValueChange={kind => setEditing({ ...editing, kind: kind as Source['kind'] })}>{(['local', 'https'] as const).map(kind => <div key={kind} className="flex items-center gap-2"><RadioGroupItem id={`source-kind-${kind}`} value={kind} /><FieldLabel htmlFor={`source-kind-${kind}`}>{kind === 'local' ? '本地目录' : 'HTTPS 仓库'}</FieldLabel></div>)}</RadioGroup></FieldSet>
        <Field data-disabled={busy}><FieldLabel htmlFor="source-location">{editing.kind === 'local' ? '目录' : '仓库索引地址'}</FieldLabel><Input id="source-location" required disabled={busy} value={editing.location} onChange={e => setEditing({ ...editing, location: e.target.value })} /></Field>
        {editing.kind === 'local' ? <Button disabled={busy} onClick={() => void run(async () => { const path = await api<string | null>('chooseSource'); if (path) setEditing(old => old ? { ...old, location: path } : null); }, false)}>选择目录</Button> : <Field data-disabled={busy}><FieldLabel htmlFor="source-key">仓库签名公钥</FieldLabel><Input id="source-key" disabled={busy} value={editing.key} onChange={e => setEditing({ ...editing, key: e.target.value })} placeholder="minisign 公钥" /></Field>}
      </FieldGroup>
      <div className="flex justify-end gap-2"><Button disabled={busy} onClick={() => setEditing(null)}>取消</Button><Button className="primary" type="submit" disabled={busy}>保存来源</Button></div>
    </form></Dialog> : null}
    {confirmation ? <Dialog className="fh-market-dialog" notice={noticeError ? notice : undefined} title={confirmation.title} busy={busy} onClose={() => setConfirmation(null)}><p>{confirmation.detail}</p>{confirmation.warning ? <Alert variant="warning"><AlertTitle>运行权限提醒</AlertTitle><AlertDescription>{confirmation.warning}</AlertDescription></Alert> : null}<div className="flex justify-end gap-2 mt-4"><Button disabled={busy} onClick={() => setConfirmation(null)}>取消</Button><Button className="primary" disabled={busy} onClick={() => void run(async () => { await confirmation.action(); setConfirmation(null); })}>确认</Button></div></Dialog> : null}
  </main>;
}
