import { useState } from 'react';
import { GripVertical, Maximize2, MoreHorizontal } from 'lucide-react';
import { Button, Dialog } from '../shared/ui';
import { ActionMenu } from '../shared/ActionMenu';
import { Switch } from '../shared/controls';
import { Checkbox } from '../components/ui/checkbox';
import type { Layout, Source } from './model';
import { compactStatus, favoriteCards, favoriteKey, type Favorite, type Presentation } from './compact-model';

export function CompactBar({ layout, sources, presentation, busy, native, demo, onExpand, onDrag, onMore }: {
  layout: Layout; sources: Source[]; presentation: Presentation; busy: boolean; native: boolean; demo: boolean;
  onExpand(): void; onDrag(): void; onMore(): void;
}) {
  const favorites = favoriteCards(layout, presentation.favorites);
  return <section className="canvas-compact-bar" aria-label="紧凑状态条">
    <Button className="compact-icon" variant="ghost" aria-label="拖动状态条" disabled={!native || busy} onMouseDown={event => { if (event.button === 0) onDrag(); }}><GripVertical aria-hidden="true" /></Button>
    <div className="compact-favorites" role="list" aria-label="关注组件，可左右滚动查看更多" tabIndex={0}>
      {favorites.map(({ card, ...favorite }) => { const source = sources.find(source => source.id === card.plugin), status = compactStatus(card, source), title = card.title || source?.title || card.plugin; return <div key={favoriteKey(favorite)} role="listitem" className="compact-favorite" data-status={status.status}><span className="compact-avatar" aria-hidden="true">{Array.from(title)[0]}</span><span className="compact-favorite-copy"><strong>{title}</strong><span>{status.label}{status.metric !== '—' && status.metric !== '指标 —' ? ` · ${status.metric}` : ''}</span></span></div>; })}
      {!favorites.length ? <span className="compact-empty">尚未关注组件，展开画布后在“更多”中选择</span> : null}
    </div>
    {demo ? <span className="compact-demo">演示</span> : null}
    <Button id="expandCanvas" className="compact-icon" aria-label="展开画布" disabled={busy} onClick={onExpand}><Maximize2 aria-hidden="true" /></Button>
    {native ? <Button className="compact-icon" variant="ghost" aria-label="更多状态条操作" aria-haspopup="menu" disabled={busy} onClick={onMore}><MoreHorizontal aria-hidden="true" /></Button> : <ActionMenu label="更多状态条操作" icon={<MoreHorizontal aria-hidden="true" />} triggerClassName="compact-icon" popupClassName="compact-action-menu" items={[{ id: 'pinned', label: '置顶状态条', checked: layout.pinned, disabled: true }, { id: 'left', label: '贴左边', disabled: true }, { id: 'right', label: '贴右边', disabled: true }, { id: 'hide', label: '隐藏 · 从设置恢复', disabled: true }]} />}
  </section>;
}

export function CompactSettings({ layout, presentation, busy, notice, onClose, onSave }: {
  layout: Layout; presentation: Presentation; busy: boolean; notice: string; onClose(): void; onSave(enabled: boolean, favorites: Favorite[]): void;
}) {
  const [enabled, setEnabled] = useState(presentation.enabled), [favorites, setFavorites] = useState<Favorite[]>(() => favoriteCards(layout, presentation.favorites).map(({ boardId, cardId }) => ({ boardId, cardId })));
  return <Dialog title="紧凑状态条" busy={busy} notice={notice} onClose={onClose} className="canvas-compact-settings">
    <label className="compact-option"><span>启用紧凑入口</span><Switch label="启用紧凑入口" checked={enabled} disabled={busy} onChange={setEnabled} /></label>
    <p>开启后可点击收起或展开。置顶沿用画布设置；隐藏仅影响当前窗口，可从设置中的“打开桌面组件”恢复，重启仍按常驻设置显示。</p>
    <div className="compact-choice-list" role="group" aria-label="选择关注组件">{layout.boards.map(board => <section key={board.id}><h3>{board.title}</h3>{board.cards.map(card => { const favorite = { boardId: board.id, cardId: card.id }, key = favoriteKey(favorite), checked = favorites.some(item => favoriteKey(item) === key); return <label className="compact-option" key={key}><span>{card.title || card.plugin}</span><Checkbox aria-label={`关注${card.title || card.plugin}`} checked={checked} disabled={busy} onCheckedChange={value => setFavorites(current => value === true ? [...current, favorite] : current.filter(item => favoriteKey(item) !== key))} /></label>; })}{!board.cards.length ? <p>此布局暂无组件</p> : null}</section>)}</div>
    <div className="compact-settings-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button className="primary" disabled={busy} onClick={() => onSave(enabled, favorites)}>{busy ? '保存中…' : '保存'}</Button></div>
  </Dialog>;
}
