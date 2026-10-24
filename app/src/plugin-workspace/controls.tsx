import { useEffect, useRef, useState } from 'react';
import { EllipsisIcon, PuzzleIcon, GripVerticalIcon, XIcon } from 'lucide-react';
import { Button } from '../shared/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { dragWorkspace } from './native';
import { host, type InstalledPlugin } from '../settings/api';
export function PluginFrame({ module }: { module: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => { if (!frame.current) return; return host().FlowHubPluginIntegration?.attach(frame.current); }, []);
  useEffect(() => { host().FlowHubPluginIntegration?.show(module); }, [module]);
  return <iframe ref={frame} id="pluginFrame" title="插件工作区" className="settings-plugin-frame" referrerPolicy="no-referrer" />;
}
export function PluginDock({ installed, busy, open, active, onSelect, floating = false, onHide }: { installed: InstalledPlugin[]; busy: boolean; open: boolean; active: string; onSelect: (id: string) => void; floating?: boolean; onHide?: () => void }) {
  const enabled = installed.filter(plugin => plugin.enabled);
  const visible = enabled.slice(0, 3), overflow = enabled.slice(3);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { if (busy || !overflow.length) setMoreOpen(false); }, [busy, overflow.length]);
  return <nav className="fh-root settings-plugin-dock" aria-label="插件工作区">
    <>{floating ? <Button className="workspace-drag-handle" aria-label="拖动插件栏" title="拖动插件栏" onPointerDown={event => { if (event.button === 0) void dragWorkspace()?.catch(console.error); }}><GripVerticalIcon aria-hidden="true" /></Button> : null}</><Button className="settings-plugin-trigger" aria-label="插件市场" title="插件市场" aria-haspopup="dialog" aria-expanded={open && active === 'extensions'} aria-pressed={open && active === 'extensions'} disabled={busy} onClick={() => onSelect('extensions')}><PuzzleIcon aria-hidden="true" /><span>插件市场</span></Button>
    {enabled.length ? <span className="settings-dock-divider" aria-hidden="true" /> : null}
    {visible.map(plugin => <Button className="settings-dock-plugin" key={plugin.manifest.id} title={plugin.manifest.name} aria-label={plugin.manifest.name} disabled={busy} aria-haspopup="dialog" aria-expanded={open && active === `plugin:${plugin.manifest.id}`} aria-pressed={open && active === `plugin:${plugin.manifest.id}`} onClick={() => onSelect(`plugin:${plugin.manifest.id}`)}><PuzzleIcon aria-hidden="true" /><span>{plugin.manifest.name}</span></Button>)}
    {overflow.length && floating ? <Button className="settings-dock-more" aria-label={`更多插件（${overflow.length}）`} aria-haspopup="dialog" aria-expanded={open && active === 'overflow'} onClick={() => onSelect('overflow')}><EllipsisIcon aria-hidden="true" /></Button> : overflow.length ? <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen} modal={false}><DropdownMenuTrigger render={<Button className="settings-dock-more" title="更多插件" aria-label={`更多插件（${overflow.length}）`} disabled={busy} />}><EllipsisIcon aria-hidden="true" /></DropdownMenuTrigger><DropdownMenuContent side="top" align="end" className="settings-dock-overflow"><DropdownMenuGroup>{overflow.map(plugin => <DropdownMenuItem key={plugin.manifest.id} onClick={() => onSelect(`plugin:${plugin.manifest.id}`)}><PuzzleIcon aria-hidden="true" />{plugin.manifest.name}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu> : null}
    {floating ? <Button className="workspace-hide" aria-label="隐藏插件栏" title="隐藏插件栏（可从设置重新打开）" onClick={onHide}><XIcon aria-hidden="true" /></Button> : null}
  </nav>;
}
