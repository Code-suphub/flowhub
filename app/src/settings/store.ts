import { useSyncExternalStore } from 'react';
import { call, host, readonly, write } from './api';
import { clone, draftKey, normalize, origin, same, signature, type Bag, type Config } from './model';
export interface Snapshot {
  config: Config | null; saved: Config | null; plugins: Bag[]; configPath: Bag; storage: Bag;
  update: Bag; diagnostics: Bag; management: Bag; history: Bag; menuItems: Bag[];
  busy: boolean; notice: string; error: boolean; jsonText: string | null; conflict: boolean;
  recovery: Bag | null; undo: Config[]; redo: Config[]; revision: number; webSelection?: string;
}
export class SettingsStore {
  private value: Snapshot = { config: null, saved: null, plugins: [], configPath: {}, storage: {}, update: {}, diagnostics: {}, management: {}, history: {}, menuItems: [], busy: false, notice: '', error: false, jsonText: null, conflict: false, recovery: null, undo: [], redo: [], revision: 0 };
  private listeners = new Set<() => void>();
  private source = origin({}, {});
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private epoch = 0;
  private menuRequest: Promise<void> | null = null;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.value;
  patch(patch: Partial<Snapshot>) { if (this.disposed) return; this.value = { ...this.value, ...patch }; this.listeners.forEach(fn => fn()); }
  get dirty() { return this.value.conflict || this.value.jsonText !== null || !same(this.value.config, this.value.saved); }
  notice(message: string, error = false) { this.patch({ notice: message, error }); }
  async run(action: () => Promise<void>) { try { await action(); } catch (e) { this.notice(String(e instanceof Error ? e.message : e), true); } }
  edit(action: (config: Config) => void) {
    if (!this.value.config || this.value.busy || this.value.conflict || readonly()) return;
    const next = clone(this.value.config); action(next); if (same(next, this.value.config)) return;
    this.patch({ config: next, undo: [...this.value.undo.slice(-39), this.value.config], redo: [], revision: this.value.revision + 1, notice: '有未保存修改', jsonText: null }); this.scheduleDraft();
  }
  replace(config: Config) { this.edit(next => { for (const key of Object.keys(next)) delete next[key]; Object.assign(next, normalize(config)); }); }
  setJson(text: string) { if (readonly() || this.value.busy || this.value.conflict) return; this.patch({ jsonText: text, revision: this.value.revision + 1 }); this.scheduleDraft(); }
  applyJson() { if (this.value.jsonText !== null) { const next = normalize(JSON.parse(this.value.jsonText)); this.replace(next); this.patch({ jsonText: null }); this.scheduleDraft(); } }
  travel(direction: 'undo' | 'redo') {
    if (readonly() || this.value.busy || this.value.conflict || !this.value.config) return;
    const list = this.value[direction]; if (!list.length) return;
    const other = direction === 'undo' ? 'redo' : 'undo';
    this.patch({ config: list[list.length - 1], [direction]: list.slice(0, -1), [other]: [...this.value[other], this.value.config], jsonText: null, revision: this.value.revision + 1 }); this.scheduleDraft();
  }
  private scheduleDraft() { clearTimeout(this.timer); this.timer = setTimeout(() => this.persist(), 120); }
  persist = () => {
    clearTimeout(this.timer); if (readonly() || !this.dirty || !this.value.config) return;
    try { localStorage.setItem(draftKey(this.source), JSON.stringify({ version: 2, origin: this.source, savedAt: Date.now(), baseSignature: signature(this.value.saved), config: this.value.config, jsonDirty: this.value.jsonText !== null, jsonText: this.value.jsonText || '', saveConflict: this.value.conflict ? { sourceOrigin: this.source } : null })); }
    catch { this.notice('草稿无法写入本地存储，请及时保存或复制 JSON', true); }
  };
  private clearDraft() { clearTimeout(this.timer); try { localStorage.removeItem(draftKey(this.source)); } catch { /* committed configuration remains authoritative */ } }
  async load(recover = true) {
    if (this.value.busy) return;
    const epoch = ++this.epoch; this.patch({ busy: true });
    try {
      const [config, plugins, configPath, storage] = await Promise.all([call<Config>('getConfig'), call<Bag[]>('listPlugins'), call('getConfigPathInfo'), call('getClipboardStorageInfo')]);
      if (this.disposed || epoch !== this.epoch) return;
      const next = normalize(config); this.source = origin(configPath, storage);
      let recovery: Bag | null = null;
      if (recover && !readonly()) {
        try { const raw = localStorage.getItem(draftKey(this.source)) || localStorage.getItem(`flowhub:settings-draft:v1:${this.source.configPath}`); if (raw) recovery = JSON.parse(raw); }
        catch { this.notice('本地草稿损坏，已保留原始记录', true); }
      }
      this.patch({ config: next, saved: clone(next), plugins, configPath, storage, undo: [], redo: [], jsonText: null, conflict: false, recovery });
      const optional = await Promise.allSettled([call('getUpdateState'), call('getDiagnosticsState'), call('getMenuBarManagementState'), call('listConfigHistory')]);
      if (this.disposed || epoch !== this.epoch) return;
      const keys = ['update', 'diagnostics', 'management', 'history'] as const;
      optional.forEach((result, i) => { if (result.status === 'fulfilled') this.patch({ [keys[i]]: result.value }); });
      host().flowhubPerformance?.enable(this.value.diagnostics.enabled === true);
    } finally { if (epoch === this.epoch) this.patch({ busy: false }); }
  }
  recoverDraft() {
    const draft = this.value.recovery; if (!draft || readonly()) return;
    if (!draft.origin || !same(draft.origin, this.source)) throw new Error('旧草稿未记录来源数据库，不能直接恢复；可复制草稿 JSON 后核对并导入。');
    const next = normalize(draft.config);
    next.core.configPath = this.value.saved?.core.configPath || '';
    next.plugins.clipboard.settings.storagePath = this.value.saved?.plugins.clipboard?.settings.storagePath || '';
    this.replace(next);
    let jsonText: string | null = null;
    if (draft.jsonDirty) {
      try { const json = JSON.parse(draft.jsonText); json.core.configPath = next.core.configPath; json.plugins.clipboard.settings.storagePath = next.plugins.clipboard.settings.storagePath; jsonText = JSON.stringify(json, null, 2); }
      catch { jsonText = String(draft.jsonText); }
    }
    this.patch({ recovery: null, jsonText }); this.scheduleDraft();
  }
  async reset() { if (this.value.busy) return; const key = draftKey(this.source), preserve = this.value.conflict; this.persist(); await this.load(false); if (!preserve && !readonly()) { try { localStorage.removeItem(key); } catch { /* keep recoverable */ } } this.notice('已加载当前保存的配置'); }
  async save() {
    if (readonly() || this.value.busy || !this.value.config) return;
    if (this.value.conflict) throw new Error('源草稿已保留，请先重置以加载目标配置');
    const snapshot = normalize(this.value.jsonText === null ? this.value.config : JSON.parse(this.value.jsonText));
    this.persist(); this.patch({ busy: true });
    try {
      const result = await write('saveConfig', clone(snapshot));
      if (!result?.ok) throw new Error(result?.reason || '保存失败');
      const committed = normalize(result.config || snapshot);
      const metadata = await Promise.allSettled([call<Bag[]>('listPlugins'), call('getConfigPathInfo'), call('getClipboardStorageInfo')]);
      if (metadata[1].status === 'rejected' || metadata[2].status === 'rejected') { this.patch({ saved: committed, conflict: true }); this.persist(); this.notice('配置已提交，但来源路径刷新失败。源草稿已保留，请重置后继续编辑。', true); return; }
      this.clearDraft(); const configPath = metadata[1].value, storage = metadata[2].value;
      this.source = origin(configPath, result.storageState?.activePath ? { ...storage, activePath: result.storageState.activePath } : storage);
      this.patch({ config: clone(committed), saved: committed, configPath, storage, jsonText: null, undo: [], redo: [], plugins: metadata[0].status === 'fulfilled' ? metadata[0].value : this.value.plugins });
      this.notice(result.pluginFailures?.length ? `配置已保存；${result.pluginFailures.length} 项系统设置未生效：${JSON.stringify(result.pluginFailures)}` : result.storageState?.operation === 'open' ? '已打开目标数据库；源网页草稿未写入目标' : '配置已保存', Boolean(result.pluginFailures?.length));
      await this.refreshHistory();
    } finally { this.patch({ busy: false }); }
  }
  async restoreHistory(id: string) {
    if (readonly()) throw new Error('浏览器预览只读，请在 FlowHub App 中操作');
    if (this.value.busy) throw new Error('另一项配置操作正在进行，请等待完成');
    if (this.value.conflict) throw new Error('请先显式重载当前配置，再恢复历史');
    // Acquire before the first await. Close/save/load and repeated restore share this lock.
    this.persist(); this.patch({ busy: true });
    let committed = false;
    try {
      const result = await write('restoreConfigHistory', id);
      committed = true;
      const [raw, plugins, configPath, storage] = await Promise.all([call<Config>('getConfig'), call<Bag[]>('listPlugins'), call('getConfigPathInfo'), call('getClipboardStorageInfo')]);
      const config = normalize(raw);
      this.clearDraft(); this.source = origin(configPath, storage);
      this.patch({ config, saved: clone(config), plugins, configPath, storage, jsonText: null, recovery: null, conflict: false, undo: [], redo: [], revision: this.value.revision + 1 });
      this.notice([result.unchanged ? '配置相同，未做改动' : '已恢复配置，请重启使系统集成生效', ...(result.warnings || [])].join('；'));
      await this.refreshHistory();
    } catch (error) {
      if (committed) {
        this.patch({ conflict: true }); this.persist();
        throw new Error(`历史已提交，但当前配置或来源路径无法重读。已阻止保存，请重置以显式重载：${String(error)}`);
      }
      throw error;
    } finally { this.patch({ busy: false }); }
  }
  async refreshHistory() { try { this.patch({ history: await call('listConfigHistory') }); } catch (e) { this.patch({ history: { entries: [], error: String(e) } }); } }
  refreshMenu() {
    if (this.menuRequest) return this.menuRequest;
    this.menuRequest = (async () => { const management = await call('getMenuBarManagementState'); this.patch({ management }); if (!management.trusted || !this.value.config?.core.menuBar.organizerEnabled) return; const result = await call('listMenuBarItems'); this.patch({ menuItems: Array.isArray(result) ? result : result.items || [] }); })().finally(() => { this.menuRequest = null; });
    return this.menuRequest;
  }
  dispose() { this.persist(); this.disposed = true; ++this.epoch; clearTimeout(this.timer); this.listeners.clear(); }
}
export function useSettings(store: SettingsStore) { return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot); }
