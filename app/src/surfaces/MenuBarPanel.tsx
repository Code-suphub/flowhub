import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../shared/ui';
import { Help, Switch } from '../shared/controls';
import { invoke, nativeHost } from '../shared/native';

interface Item {windowId: number; displayName?: string; accessibilityLabel?: string; title?: string; ownerName?: string; section: string; hideable: boolean}
interface Snapshot {ok?: boolean; reason?: string; items?: Item[]; trusted: boolean; organizerEnabled: boolean}
export function MenuBarPanel() {
  const [items, setItems] = useState<Item[]>([]), [notice, setNotice] = useState('正在读取菜单栏…');
  const [busy, setBusy] = useState(false), [trusted, setTrusted] = useState(false);
  const order = useRef<number[]>([]), inFlight = useRef(false), changing = useRef(false), alive = useRef(true);
  const available = Boolean(nativeHost()?.core?.invoke);
  const refresh = useCallback(async (reset = false): Promise<Item[] | undefined> => {
    if (inFlight.current) return;
    inFlight.current = true; if (alive.current) setBusy(true);
    try {
      const result = await invoke<Snapshot>('list_menu_bar_items');
      if (result.ok === false) throw Error(result.reason || '读取失败');
      const fresh = result.items || [], byId = new Map(fresh.map(item => [item.windowId, item]));
      order.current = reset ? [] : order.current.filter(id => byId.has(id));
      const known = new Set(order.current);
      for (const item of fresh) if (!known.has(item.windowId)) {order.current.push(item.windowId);known.add(item.windowId);}
      const next = order.current.map(id => byId.get(id)!);
      if (alive.current) {
        setItems(next); setTrusted(result.trusted && result.organizerEnabled);
        setNotice(!result.organizerEnabled ? '请先启用隐藏分区' : !result.trusted ? '需要辅助功能权限，请在设置中授权' : !next.length ? '没有发现菜单栏图标' : '');
      }
      return next;
    } finally {inFlight.current = false;if (alive.current && !changing.current) setBusy(false);}
  }, []);
  const open = useCallback(() => {
    if (changing.current) return;
    void refresh(true).catch(error => {if (alive.current) setNotice(String(error));});
  }, [refresh]);
  const close = useCallback(() => {void invoke('toggle_menu_bar_panel').catch(error => {if (alive.current) setNotice(String(error));});}, []);
  useEffect(() => {
    alive.current = true;
    if (!available) {setNotice('浏览器预览只读，请在 FlowHub 中管理菜单栏。');return () => {alive.current = false;};}
    open();
    let unlisten: (() => void) | undefined, disposed = false;
    void nativeHost()?.event?.listen('menu-bar-panel-opened', open).then(stop => {if (disposed) stop();else unlisten = stop;}).catch(error => setNotice(String(error)));
    const key = (event: KeyboardEvent) => {if (event.key === 'Escape') close();};
    document.addEventListener('keydown', key);
    return () => {alive.current = false;disposed = true;unlisten?.();document.removeEventListener('keydown', key);};
  }, [available, close, open]);
  async function change(item: Item, hidden: boolean) {
    if (!available || !trusted || !item.hideable || changing.current || inFlight.current) return;
    changing.current = true;setBusy(true);setNotice(hidden ? '正在隐藏…' : '正在显示…');
    try {
      const result = await invoke<{ok: boolean; reason?: string}>('set_menu_bar_item_hidden', {windowId: item.windowId, hidden});
      await new Promise(resolve => setTimeout(resolve, 180));
      const actual = (await refresh())?.find(candidate => candidate.windowId === item.windowId);
      if (!result.ok) throw Error(result.reason || '操作未完成');
      if (!actual || (actual.section === 'alwaysHidden') !== hidden) throw Error('图标位置尚未更新，请重试');
      if (alive.current) setNotice('');
    } catch (error) {if (alive.current) setNotice(String(error));}
    finally {changing.current = false;if (alive.current) setBusy(false);}
  }
  return <div className="fh-root fh-menubar-panel">
    <header><h1>菜单栏图标 <Help>打开开关显示图标，关闭后始终隐藏。系统固定图标不能隐藏。</Help></h1><Button aria-label="关闭面板" disabled={!available} onClick={close}>×</Button></header>
    <p role="status" className="fh-muted">{notice}</p>
    <main aria-label="逐个图标控制">{items.map(item => {
      const name = item.displayName || item.accessibilityLabel || item.title || item.ownerName || '未命名图标';
      return <div className="fh-row" key={item.windowId}><span className="fh-row-copy"><strong>{name}</strong><small>{!item.hideable ? '系统固定' : item.section === 'alwaysHidden' ? '始终隐藏' : item.section === 'hidden' ? '随箭头展开／收起' : '显示'}</small></span><Switch label={name + '显示'} checked={item.section !== 'alwaysHidden'} disabled={busy || !trusted || !item.hideable} onChange={shown => void change(item, !shown)} /></div>;
    })}</main>
    <footer><span>{items.length} 个图标 · {items.filter(item => item.section === 'alwaysHidden').length} 个隐藏</span><Button disabled={busy || !available} onClick={open}>刷新顺序</Button></footer>
  </div>;
}
