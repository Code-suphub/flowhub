import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Dialog } from '../shared/ui';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, Help } from '../shared/controls';
import { Core, Clipboard, Tools } from './Core';
import { CanvasSettings } from './CanvasSettings';
import { WebCatalog, Memos } from './Collections';
import { Toggle } from './fields';
import { call, host, readonly, write, type InstalledPlugin } from './api';
import { SettingsStore, useSettings } from './store';
import { signature } from './model';
import './settings.css';
import { Theme } from './Theme';
import { bindNativeSettings } from './native';
const emptyPlugins: InstalledPlugin[] = [];
const builtInModules = [{ id: 'core', label: '通用设置' }, { id: 'web', label: '网页目录' }, { id: 'app', label: '应用' }, { id: 'clipboard', label: '剪贴板' }, { id: 'memo', label: '备忘录' }, { id: 'tools', label: '工具' }];
const pluginModules = [{ id: 'extensions', label: '插件市场' }, { id: 'canvas', label: '桌面组件' }];
const modules = [...builtInModules, ...pluginModules];
function PluginFrame({ module }: { module: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => { if (!frame.current) return; return host().FlowHubPluginIntegration?.attach(frame.current); }, []);
  useEffect(() => { host().FlowHubPluginIntegration?.show(module); }, [module]);
  return <iframe ref={frame} id="pluginFrame" title="插件工作区" className="settings-plugin-frame" referrerPolicy="no-referrer" />;
}
export function Settings({ store }: { store: SettingsStore }) {
  const s = useSettings(store), [module, setModule] = useState('core'), [section, setSection] = useState('general'), [json, setJson] = useState(false), [reset, setReset] = useState(false), [close, setClose] = useState(false);
  const integration = host().FlowHubPluginIntegration;
  const installed = useSyncExternalStore(integration?.subscribe || (() => () => {}), integration?.getSnapshot || (() => emptyPlugins), () => emptyPlugins);
  useEffect(() => {
    const unbind = bindNativeSettings(store, id => { if (modules.some(m => m.id === id) || id.startsWith('plugin:')) { setJson(false); setModule(id); } }, setSection);
    void store.run(() => store.load());
    const beforeUnload = (event: BeforeUnloadEvent) => { store.persist(); if (store.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('pagehide', store.persist);
    return () => { unbind(); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', store.persist); };
  }, [store]);
  useEffect(() => { if (module.startsWith('plugin:') && !installed.some(p => p.enabled && `plugin:${p.manifest.id}` === module)) setModule('extensions'); }, [installed, module]);
  function navigate(id: string) { if (s.busy) return; if (s.jsonText !== null) { try { store.applyJson(); } catch (e) { store.notice(String(e), true); return; } } setJson(false); setModule(id); }
  const editorActions = module !== 'extensions' && module !== 'canvas' && !module.startsWith('plugin:') ? <><Help label="草稿与保存">修改只进入草稿；保存后生效。源数据库与配置路径分别隔离草稿。撤销支持最近 40 次修改。</Help><Button disabled={s.busy} onClick={() => { try { if (json) store.applyJson(); setJson(!json); } catch (e) { store.notice(String(e), true); } }}>{json ? '返回表单' : '编辑 JSON'}</Button></> : null;
  return <div className="fh-root settings-shell flex flex-col min-h-screen" aria-busy={s.busy}>
    <header className="settings-topbar flex flex-wrap items-center justify-between gap-3"><h1>FlowHub 设置</h1><div className="flex items-center gap-2"><Theme /><span>{s.update.currentVersion || '预览版'}</span><Button onClick={() => { if (store.dirty) setClose(true); else void store.run(async () => { await call('closeSettings'); }); }} disabled={s.busy}>关闭</Button></div></header>
    {readonly() ? <p className="settings-preview" role="status">{module === 'web' || module === 'memo' ? '目录可在本页临时展开、折叠和拖动，刷新后复原；配置保存与编辑仅桌面 App 可用。' : '浏览器预览只读；配置修改、文件操作和原生能力请在桌面 App 中使用。'}</p> : null}
    <div className="settings-workspace grid md:grid-cols-[160px_minmax(0,1fr)]"><nav aria-label="设置模块" className="settings-sidebar flex md:flex-col gap-1 overflow-auto">
      <div className="settings-nav-group"><span className="settings-nav-heading">内置功能</span>{builtInModules.map(item => <Button key={item.id} aria-pressed={module === item.id} disabled={s.busy} onClick={() => navigate(item.id)}>{item.label}</Button>)}</div>
      <div className="settings-nav-group"><span className="settings-nav-heading">插件</span>{[...pluginModules, ...installed.filter(p => p.enabled).map(p => ({ id: `plugin:${p.manifest.id}`, label: p.manifest.name }))].map(item => <Button key={item.id} aria-pressed={module === item.id} disabled={s.busy} onClick={() => navigate(item.id)}>{item.label}</Button>)}</div>
    </nav>
      <main className="settings-main min-w-0 p-4 md:p-6">
        {!s.config ? <EmptyState>{s.busy ? '正在读取配置…' : '配置未能加载'}<Button disabled={s.busy} onClick={() => void store.run(() => store.load())}>重试</Button></EmptyState> : <>
          {editorActions && (module !== 'core' || json) ? <div className="settings-editor-actions">{editorActions}</div> : null}
          {module === 'canvas' ? <CanvasSettings /> : module === 'extensions' || module.startsWith('plugin:') ? <PluginFrame module={module} /> : json ? <label className="grid gap-2">完整配置 JSON<Textarea aria-label="完整配置 JSON" className="settings-code" rows={26} spellCheck={false} readOnly={readonly() || s.busy || s.conflict} value={s.jsonText ?? JSON.stringify(s.config, null, 2)} onChange={e => store.setJson(e.target.value)} /></label> : <>
            {module === 'core' ? <Core store={store} section={section} onSection={setSection} actions={editorActions} /> : <fieldset disabled={s.busy || s.conflict || (readonly() && module !== 'web' && module !== 'memo')} className="settings-fieldset">{module === 'web' ? <WebCatalog store={store} /> : module === 'memo' ? <Memos store={store} /> : module === 'clipboard' ? <Clipboard store={store} /> : module === 'tools' ? <Tools store={store} /> : <><Toggle label="启用应用搜索" checked={s.config.plugins.app.enabled !== false} onChange={v => store.edit(c => { c.plugins.app.enabled = v; })} help="扫描 macOS 应用目录，提供原生图标、搜索和快速启动。" /><Button onClick={() => void store.run(async () => { await write('openAccessibilitySettings'); })}>打开辅助功能设置</Button></>}</fieldset>}
          </>}
        </>}
      </main></div>
    <footer className="settings-footer flex flex-wrap items-center justify-between gap-3"><p role={s.error ? 'alert' : 'status'} className={s.error ? 'settings-error' : ''}>{s.notice || (store.dirty ? '有未保存修改' : '已保存')}</p><div className="flex flex-wrap gap-2"><Button disabled={readonly() || s.busy || !s.undo.length || s.conflict} onClick={() => store.travel('undo')}>撤销</Button><Button disabled={readonly() || s.busy || !s.redo.length || s.conflict} onClick={() => store.travel('redo')}>重做</Button><Button disabled={s.busy || !store.dirty} onClick={() => setReset(true)}>重置未保存</Button><Button className="primary" disabled={readonly() || s.busy || !store.dirty || s.conflict} onClick={() => void store.run(() => store.save())}>{s.busy ? '处理中…' : '保存'}</Button></div></footer>
    {reset ? <Dialog title="重置未保存修改" busy={s.busy} onClose={() => setReset(false)}><p>{s.conflict ? '保留源草稿并加载当前目标配置？' : '放弃当前编辑，重新加载已保存配置？'}</p><Button onClick={() => void store.run(async () => { await store.reset(); setReset(false); })}>确认重置</Button></Dialog> : null}
    {close ? <Dialog title="关闭设置" busy={s.busy} onClose={() => setClose(false)}><p>尚有未保存修改，可保留本地草稿后关闭。</p><Button onClick={() => void store.run(async () => { store.persist(); await call('closeSettings'); })}>保留草稿并关闭</Button><Button onClick={() => void store.run(async () => { await store.save(); if (!store.dirty) await call('closeSettings'); })}>保存并关闭</Button></Dialog> : null}
    {s.recovery ? <Dialog title="发现本地草稿" busy={false} onClose={() => store.patch({ recovery: null })}><p>{new Date(s.recovery.savedAt).toLocaleString()} 保存的草稿。{s.recovery.baseSignature !== signature(s.saved) ? '磁盘配置已发生变化，请核对后恢复。' : ''}</p><pre className="settings-code">{s.recovery.jsonDirty ? s.recovery.jsonText : JSON.stringify(s.recovery.config, null, 2)}</pre><Button disabled={!s.recovery.origin} onClick={() => void store.run(async () => store.recoverDraft())}>恢复同源草稿</Button><Button onClick={() => store.patch({ recovery: null })}>暂不恢复</Button></Dialog> : null}
  </div>;
}
export function mountSettings(element: HTMLElement) { const store = new SettingsStore(), root = createRoot(element); root.render(<Settings store={store} />); return () => { store.dispose(); root.unmount(); }; }
