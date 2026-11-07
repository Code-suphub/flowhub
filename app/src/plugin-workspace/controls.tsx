import { useEffect, useRef, useState } from 'react';
import { EllipsisIcon, PuzzleIcon, GripVerticalIcon, XIcon } from 'lucide-react';
import { FeatureIcon, PluginIcon } from '../shared/FeatureIcon';
import { Button } from '../shared/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { dragWorkspace, inspectPlugin } from './native';
import { host, readonly, type InstalledPlugin } from '../settings/api';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
export function PluginFrame({ module, onManage }: { module: string; onManage?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0), [state, setState] = useState({ module: '', attempt: -1, pending: true, error: false });
  const current = state.module === module && state.attempt === attempt ? state : { pending: true, error: false };
  useEffect(() => {
    const node = frame.current, integration = host().FlowHubPluginIntegration;
    if (!node || !integration) return;
    const detach = integration.attach(node);
    let active = true;
    setState({ module, attempt, pending: true, error: false });
    async function open() {
      const plugin = integration!.getSnapshot().find(item => `plugin:${item.manifest.id}` === module);
      if (!readonly() && plugin?.directory) {
        node!.src = 'about:blank';
        const candidate = await inspectPlugin(plugin.directory);
        if (candidate.manifest.id !== plugin.manifest.id || candidate.manifest.ui !== plugin.manifest.ui) throw Error('插件入口已变化，请先更新插件');
      }
      if (!active) return;
      integration!.show(module);
      setState({ module, attempt, pending: false, error: false });
    }
    void open().catch(() => { if (active) setState({ module, attempt, pending: false, error: true }); });
    return () => { active = false; detach(); };
  }, [module, attempt]);
  return <>{current.error ? <Empty className="workspace-frame-error" role="alert"><EmptyHeader><EmptyTitle>插件文件不可用</EmptyTitle><EmptyDescription>原安装目录可能已移动，或构建资源不完整。恢复原目录后可以重试；也可前往插件市场，在管理菜单中更换安装目录或重新安装。</EmptyDescription></EmptyHeader><EmptyContent className="flex-row flex-wrap justify-center"><Button onClick={() => setAttempt(value => value + 1)}>重试打开</Button><Button onClick={() => onManage ? onManage() : host().FlowHubPluginIntegration?.show('extensions')}>返回插件市场</Button></EmptyContent></Empty> : current.pending ? <p className="workspace-frame-loading" role="status">正在读取插件…</p> : null}<iframe ref={frame} id="pluginFrame" title="插件工作区" className="settings-plugin-frame" style={{ display: current.pending || current.error ? 'none' : undefined }} referrerPolicy="no-referrer" /></>;
}
export function PluginDock({ installed, busy, open, active, onSelect, floating = false, onHide }: { installed: InstalledPlugin[]; busy: boolean; open: boolean; active: string; onSelect: (id: string) => void; floating?: boolean; onHide?: () => void }) {
  const enabled = installed.filter(plugin => plugin.enabled);
  const visible = enabled.slice(0, 3), overflow = enabled.slice(3);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { if (busy || !overflow.length) setMoreOpen(false); }, [busy, overflow.length]);
  return <nav className="fh-root settings-plugin-dock" aria-label="插件工作区">
    <>{floating ? <Button className="workspace-drag-handle" aria-label="拖动插件栏" title="拖动插件栏" onPointerDown={event => { if (event.button === 0) void dragWorkspace()?.catch(console.error); }}><GripVerticalIcon aria-hidden="true" /></Button> : null}</><Button className="settings-plugin-trigger" aria-label="插件市场" title="插件市场" aria-haspopup="dialog" aria-expanded={open && active === 'extensions'} aria-pressed={open && active === 'extensions'} disabled={busy} onClick={() => onSelect('extensions')}><FeatureIcon icon={PuzzleIcon} tone="violet" /><span className="settings-dock-trigger-label">插件市场</span></Button>
    {enabled.length ? <span className="settings-dock-divider" aria-hidden="true" /> : null}
    {visible.map(plugin => <Button className="settings-dock-plugin" key={plugin.manifest.id} title={plugin.manifest.name} aria-label={plugin.manifest.name} disabled={busy} aria-haspopup="dialog" aria-expanded={open && active === `plugin:${plugin.manifest.id}`} aria-pressed={open && active === `plugin:${plugin.manifest.id}`} onClick={() => onSelect(`plugin:${plugin.manifest.id}`)}><PluginIcon id={plugin.manifest.id} /><span className="settings-dock-label">{plugin.manifest.name}</span></Button>)}
    {overflow.length && floating ? <Button className="settings-dock-more" aria-label={`更多插件（${overflow.length}）`} aria-haspopup="dialog" aria-expanded={open && active === 'overflow'} onClick={() => onSelect('overflow')}><EllipsisIcon aria-hidden="true" /></Button> : overflow.length ? <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen} modal={false}><DropdownMenuTrigger render={<Button className="settings-dock-more" title="更多插件" aria-label={`更多插件（${overflow.length}）`} disabled={busy} />}><EllipsisIcon aria-hidden="true" /></DropdownMenuTrigger><DropdownMenuContent side="top" align="end" className="settings-dock-overflow"><DropdownMenuGroup>{overflow.map(plugin => <DropdownMenuItem key={plugin.manifest.id} onClick={() => onSelect(`plugin:${plugin.manifest.id}`)}><PluginIcon id={plugin.manifest.id} size="small" />{plugin.manifest.name}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu> : null}
    {floating ? <Button className="workspace-hide" aria-label="隐藏插件栏" title="隐藏插件栏（可从设置重新打开）" onClick={onHide}><XIcon aria-hidden="true" /></Button> : null}
  </nav>;
}
