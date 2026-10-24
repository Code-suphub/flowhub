import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AppWindowIcon, PaletteIcon, PanelTopIcon, SearchIcon, ClipboardIcon, EllipsisIcon, Globe2Icon, Layers2Icon, LayoutDashboardIcon, NotebookPenIcon, PuzzleIcon, Settings2Icon, WrenchIcon } from 'lucide-react';
import { Button, Dialog } from '../shared/ui';
import { Textarea } from '../components/ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { EmptyState, Help } from '../shared/controls';
import { Core, Clipboard, Tools } from './Core';
import { CanvasSettings } from './CanvasSettings';
import { WebCatalog, Memos } from './Collections';
import { Applications } from './Applications';
import { call, host, readonly, type InstalledPlugin } from './api';
import { SettingsStore, useSettings } from './store';
import { signature } from './model';
import './settings.css';
import './glass.css';
import { PluginDock, PluginFrame } from '../plugin-workspace/controls';
import { workspaceCall } from '../plugin-workspace/native';
import { Theme } from './Theme';
import { bindNativeSettings } from './native';
import { bindSettingsClose } from './close';
import { observePopupOwner } from '../../../../common-components/packages/frontend/dom/popup';
const emptyPlugins: InstalledPlugin[] = [];
const builtInModules = [{ id: 'core', label: '通用设置' }, { id: 'web', label: '网页目录' }, { id: 'app', label: '应用' }, { id: 'clipboard', label: '剪贴板' }, { id: 'memo', label: '备忘录' }, { id: 'tools', label: '工具' }];
const pluginModules = [{ id: 'extensions', label: '插件市场' }];
const workspaceModules = [{ id: 'core', label: '通用设置' }, { id: 'search', label: '搜索' }, { id: 'menubar', label: '菜单栏' }, { id: 'clipboard', label: '剪贴板' }, { id: 'canvas', label: '桌面组件' }, { id: 'appearance', label: '外观' }];
const collectionModules = builtInModules.filter(item => ['web', 'app', 'memo', 'tools'].includes(item.id));
const modules = [...builtInModules, ...workspaceModules, ...pluginModules];
const moduleIcons = { search: SearchIcon, menubar: PanelTopIcon, appearance: PaletteIcon, core: Settings2Icon, web: Globe2Icon, app: AppWindowIcon, clipboard: ClipboardIcon, memo: NotebookPenIcon, tools: WrenchIcon, extensions: PuzzleIcon, canvas: LayoutDashboardIcon };
export function Settings({ store }: { store: SettingsStore }) {
  const s = useSettings(store), [module, setModule] = useState('core'), [section, setSection] = useState('general'), [json, setJson] = useState(false), [reset, setReset] = useState(false), [close, setClose] = useState(false);
  const integration = host().FlowHubPluginIntegration;
  const jsonBefore = useRef<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false), [pluginModule, setPluginModule] = useState('extensions');
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const menuActions = useRef<{ unmount(): void; close(): void } | null>(null);
  useLayoutEffect(() => { if (!menuOpen) menuActions.current?.unmount(); }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    if (s.busy) { setMenuOpen(false); return; }
    return menuTrigger.current ? observePopupOwner(menuTrigger.current, () => setMenuOpen(false)) : undefined;
  }, [menuOpen, s.busy]);
  const installed = useSyncExternalStore(integration?.subscribe || (() => () => {}), integration?.getSnapshot || (() => emptyPlugins), () => emptyPlugins);
  useEffect(() => {
    const unbindClose = bindSettingsClose(store, () => setClose(true));
    const unbind = bindNativeSettings(store, id => { if (modules.some(m => m.id === id) || id.startsWith('plugin:')) navigate(id); }, setSection);
    void store.run(() => store.load());
    const beforeUnload = (event: BeforeUnloadEvent) => { store.persist(); if (store.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('pagehide', store.persist);
    return () => { unbindClose(); unbind(); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', store.persist); };
  }, [store]);
  useEffect(() => { if (pluginModule.startsWith('plugin:') && !installed.some(p => p.enabled && `plugin:${p.manifest.id}` === pluginModule)) setPluginModule('extensions'); }, [installed, pluginModule]);
  function finishJson() {
    if (store.snapshot().busy) return false;
    try { store.applyJson(); setJson(false); return true; } catch (e) { store.notice(String(e), true); return false; }
  }
  function openJson() { jsonBefore.current = store.snapshot().jsonText; setJson(true); }
  function cancelJson() { if (!store.snapshot().busy) { store.restoreJson(jsonBefore.current); setJson(false); } }
  function navigate(id: string) { if (store.snapshot().busy || !finishJson()) return false; if (id === 'extensions' || id.startsWith('plugin:')) { if (!readonly()) { void workspaceCall('select', id).catch(e => store.notice(String(e), true)); } else { setPluginModule(id); setPluginsOpen(true); } } else { setModule(id); setPluginsOpen(false); } return true; }
  const title = modules.find(item => item.id === module)?.label || installed.find(plugin => `plugin:${plugin.manifest.id}` === module)?.manifest.name || '设置';
  const pluginTitle = pluginModule === 'extensions' ? '插件市场' : installed.find(plugin => `plugin:${plugin.manifest.id}` === pluginModule)?.manifest.name || '插件';
  return <div className={`settings-stage${readonly() ? '' : ' settings-detached-workspace'}`}><div className="settings-landscape" aria-hidden="true" /><div className="fh-root settings-shell flex flex-col min-h-screen" aria-busy={s.busy}>
    <header data-tauri-drag-region="deep" className="settings-topbar flex flex-wrap items-center justify-between gap-3"><h1>设置<span className="settings-current-page"> / {title}</span></h1><div className="settings-global-actions flex items-center gap-2"><Theme />{!readonly() ? <Button aria-label="显示独立插件栏" onClick={() => void workspaceCall('show').catch(e => store.notice(String(e), true))}><PuzzleIcon aria-hidden="true" />插件栏</Button> : null}<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} actionsRef={menuActions}><DropdownMenuTrigger ref={menuTrigger} render={<Button aria-label="更多设置操作" disabled={s.busy || !s.config} />}><EllipsisIcon data-icon="inline-start" />更多</DropdownMenuTrigger><DropdownMenuContent align="end" className="settings-global-menu"><DropdownMenuGroup><DropdownMenuItem onClick={openJson}>{readonly() ? '查看完整配置 JSON' : '编辑完整配置 JSON'}</DropdownMenuItem><DropdownMenuItem onClick={() => { if (navigate('core')) setSection('updates'); }}>版本与更新</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>{readonly() ? <Button onClick={() => host().requestSettingsClose?.()} disabled={s.busy}>关闭</Button> : null}</div></header>
    <div className="settings-workspace grid md:grid-cols-[208px_minmax(0,1fr)]"><nav aria-label="设置模块" className="settings-sidebar flex md:flex-col gap-1">
      <div className="settings-brand"><span><Layers2Icon aria-hidden="true" /></span>FlowHub</div>
      <div className="settings-navigation-scroll">
      {[{ label: '工作空间', items: workspaceModules }, { label: '目录与工具', items: collectionModules }].map(group => <div className="settings-nav-group" key={group.label}><span className="settings-nav-heading">{group.label}</span>{group.items.map(item => { const Icon = moduleIcons[item.id as keyof typeof moduleIcons]; return <Button key={item.id} aria-current={module === item.id ? 'page' : undefined} disabled={s.busy} onClick={() => navigate(item.id)}><Icon data-icon="inline-start" aria-hidden="true" />{item.label}</Button>; })}</div>)}
      </div>
      <div className="settings-sidebar-bottom"><span className="settings-local-status"><i />{readonly() ? '浏览器演示' : '本地工作空间'}</span></div>
    </nav>
      <main className="settings-main min-w-0 p-4 md:p-6">
        {!s.config ? <EmptyState error={!s.busy}>{s.busy ? '正在读取配置…' : '配置未能加载'}<Button disabled={s.busy} onClick={() => void store.run(() => store.load())}>重试</Button></EmptyState> : <>
          {module === 'canvas' ? <><div className="settings-page-intro"><h2>桌面上的小帮手。</h2><p>常用信息就近摆放，用紧凑状态条随时唤回。</p></div><CanvasSettings /></> : module === 'appearance' ? <div className="settings-appearance"><div className="settings-page-intro"><h2>让工作空间轻一点。</h2><p>柔和的光与色，留出专注的余地。</p></div><div className="settings-material-sample"><Layers2Icon aria-hidden="true" /><strong>轻雾玻璃</strong><span>鼠尾草绿 · 暖沙色</span></div><div className="settings-appearance-choice"><span>外观主题</span><Theme /></div><p className="fh-muted">{readonly() ? '浏览器使用玻璃效果演示背景；Mac 版叠加原生窗口材质。' : '原生窗口材质随桌面光色变化，并尊重系统的降低透明度设置。'}</p></div> : <>
            {['core', 'search', 'menubar'].includes(module) ? <Core store={store} section={module === 'core' ? section : module} onSection={setSection} navigation={module === 'core'} /> : <fieldset disabled={s.busy || s.conflict || (readonly() && module !== 'web' && module !== 'memo')} className="settings-fieldset">{module === 'web' ? <WebCatalog store={store} /> : module === 'memo' ? <Memos store={store} /> : module === 'clipboard' ? <Clipboard store={store} /> : module === 'tools' ? <Tools store={store} /> : <Applications store={store} />}</fieldset>}
          </>}
        </>}
      </main></div>
    {readonly() && pluginsOpen ? <Dialog title={pluginTitle} busy={s.busy} modal={false} onClose={() => setPluginsOpen(false)} className="settings-plugin-drawer"><div className="settings-drawer-handle" aria-hidden="true" /><PluginFrame module={pluginModule} /><p className="settings-plugin-caption">{readonly() ? '浏览器预览 · 插件安装与管理请在桌面 App 中操作' : '本地插件工作区'}</p></Dialog> : null}
    <footer className="settings-footer flex flex-wrap items-center justify-between gap-3"><div className="settings-save-status"><p role={s.error ? 'alert' : 'status'} className={s.error ? 'settings-error' : ''}>{s.notice || (readonly() ? '浏览器预览 · 不会保存配置' : store.dirty ? '有未保存修改' : '已保存')}</p><Help label="草稿与保存">修改后需保存才会生效；未保存的修改会保留为本地草稿，可在下次打开时恢复。</Help></div><div className="settings-footer-actions flex flex-wrap gap-2"><Button disabled={readonly() || s.busy || !s.undo.length || s.conflict} onClick={() => store.travel('undo')}>撤销</Button><Button disabled={readonly() || s.busy || !s.redo.length || s.conflict} onClick={() => store.travel('redo')}>重做</Button><Button disabled={s.busy || !store.dirty} onClick={() => setReset(true)}>重置未保存</Button><Button className="primary settings-save-button" disabled={readonly() || s.busy || !store.dirty || s.conflict} onClick={() => void store.run(() => store.save())}>{s.busy ? '处理中…' : '保存'}</Button></div></footer>
    {json && s.config ? <Dialog title={readonly() ? '查看完整配置 JSON' : '编辑完整配置 JSON'} busy={s.busy} onClose={cancelJson} notice={s.error ? s.notice : undefined} className="settings-json-dialog"><p className="fh-muted">{readonly() ? '此处查看 FlowHub 完整配置。' : '此处编辑 FlowHub 完整配置；完成后进入草稿，保存后生效。'}</p><Textarea aria-label="完整配置 JSON" className="settings-code" rows={18} spellCheck={false} readOnly={readonly() || s.busy || s.conflict} value={s.jsonText ?? JSON.stringify(s.config, null, 2)} onChange={e => store.setJson(e.target.value)} /><div className="settings-dialog-actions">{!readonly() ? <Button disabled={s.busy} onClick={cancelJson}>取消编辑</Button> : null}<Button disabled={s.busy} onClick={() => { finishJson(); }}>{readonly() ? '完成' : '完成编辑'}</Button></div></Dialog> : null}
    {reset ? <Dialog title="重置未保存修改" busy={s.busy} onClose={() => setReset(false)}><p>{s.conflict ? '保留源草稿并加载当前目标配置？' : '放弃当前编辑，重新加载已保存配置？'}</p><Button onClick={() => void store.run(async () => { await store.reset(); setReset(false); })}>确认重置</Button></Dialog> : null}
    {close ? <Dialog title="关闭设置" busy={s.busy} onClose={() => setClose(false)} notice={s.error ? s.notice : undefined}><p>尚有未保存修改，关闭前请选择如何处理。</p><div className="settings-dialog-actions"><Button disabled={s.busy} onClick={() => setClose(false)}>取消</Button><Button disabled={s.busy} onClick={() => void store.run(async () => { store.persist(); await call('closeSettings'); })}>保留草稿并关闭</Button><Button className="primary" disabled={s.busy || s.conflict} onClick={() => void store.run(async () => { await store.save(); if (!store.dirty) await call('closeSettings'); })}>保存并关闭</Button></div></Dialog> : null}
    {s.recovery ? <Dialog title="发现本地草稿" busy={false} onClose={() => store.patch({ recovery: null })}><p>{new Date(s.recovery.savedAt).toLocaleString()} 保存的草稿。{s.recovery.baseSignature !== signature(s.saved) ? '磁盘配置已发生变化，请核对后恢复。' : ''}</p><pre className="settings-code">{s.recovery.jsonDirty ? s.recovery.jsonText : JSON.stringify(s.recovery.config, null, 2)}</pre><Button disabled={!s.recovery.origin} onClick={() => void store.run(async () => store.recoverDraft())}>恢复同源草稿</Button><Button onClick={() => store.patch({ recovery: null })}>暂不恢复</Button></Dialog> : null}
  </div>{readonly() ? <PluginDock installed={installed} busy={s.busy} open={pluginsOpen} active={pluginModule} onSelect={id => { if (pluginsOpen && pluginModule === id) setPluginsOpen(false); else navigate(id); }} /> : null}</div>;
}
export function mountSettings(element: HTMLElement) { const store = new SettingsStore(), root = createRoot(element); root.render(<Settings store={store} />); return () => { store.dispose(); root.unmount(); }; }
