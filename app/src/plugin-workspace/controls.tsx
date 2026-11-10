import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EllipsisIcon, PuzzleIcon, GripVerticalIcon, XIcon } from 'lucide-react';
import { FeatureIcon, PluginIcon } from '../shared/FeatureIcon';
import { Button } from '../shared/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { dragWorkspace, inspectPlugin } from './native';
import { host, readonly, type InstalledPlugin } from '../settings/api';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
type PluginFrameProps = { module: string; onManage?: () => void };

export function PluginFrame(props: PluginFrameProps) {
  // The market is a first-party document. Give each selected plugin its own sandboxed frame.
  return <PluginFrameContent key={props.module} {...props} />;
}

function PluginFrameContent({ module, onManage }: PluginFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const integration = host().FlowHubPluginIntegration;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'checking' | 'ready' | 'error'>('checking');
  useEffect(() => {
    if (!integration) return;
    const plugin = integration.getSnapshot().find(item => item.enabled && `plugin:${item.manifest.id}` === module);
    let active = true;
    async function check() {
      if (module.startsWith('plugin:') && !plugin) throw Error('找不到已启用的插件');
      if (!readonly() && plugin?.directory) {
        const candidate = await inspectPlugin(plugin.directory);
        if (candidate.manifest.id !== plugin.manifest.id || candidate.manifest.ui !== plugin.manifest.ui) throw Error('插件入口已变化，请先更新插件');
      }
      if (active) setStatus('ready');
    }
    void check().catch(() => { if (active) setStatus('error'); });
    return () => { active = false; };
  }, [integration, module, attempt]);
  useLayoutEffect(() => {
    const node = frame.current;
    if (status !== 'ready' || !node || !integration) return;
    const detach = integration.attach(node);
    integration.show(module);
    return detach;
  }, [integration, module, status]);
  if (status === 'checking') return <p className="workspace-frame-loading" role="status">正在读取插件…</p>;
  if (status === 'error') {
    const retry = () => { setStatus('checking'); setAttempt(value => value + 1); };
    return <Empty className="workspace-frame-error" role="alert">
      <EmptyHeader>
        <EmptyTitle>插件文件不可用</EmptyTitle>
        <EmptyDescription>原安装目录可能已移动，或构建资源不完整。恢复原目录后可以重试；也可前往插件市场，在管理菜单中更换安装目录或重新安装。</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center">
        <Button onClick={retry}>重试打开</Button>
        {onManage ? <Button onClick={onManage}>返回插件市场</Button> : null}
      </EmptyContent>
    </Empty>;
  }
  return <iframe ref={frame} id="pluginFrame" title="插件工作区" className="settings-plugin-frame" sandbox={module === 'extensions' ? undefined : 'allow-scripts'} referrerPolicy="no-referrer" />;
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
