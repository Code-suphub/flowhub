import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { ArrowLeftIcon } from 'lucide-react';
import { Button, Input } from '../shared/ui';
import { Help } from '../shared/controls';
import { Field, FieldLabel } from '../components/ui/field';
import { Textarea } from '../components/ui/textarea';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyContent } from '../components/ui/empty';
import { useViewMemory, useViewState } from './view-state';

export function CollectionField({ label, value, readOnly, onChange, help, multiline, code }: {
  label: string; value: unknown; readOnly: boolean; onChange(value: string): void; help?: string; multiline?: boolean; code?: boolean;
}) {
  const id = useId();
  const props = { id, 'aria-label': label, value: String(value ?? ''), readOnly, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (!readOnly) onChange(event.target.value); } };
  return <Field className="min-w-0">
    <div className="flex items-center gap-2"><FieldLabel htmlFor={id}>{label}</FieldLabel>{help ? <Help label={`${label}说明`}>{help}</Help> : null}</div>
    {multiline ? <Textarea {...props} className={code ? 'settings-code' : undefined} rows={code ? 10 : 3} spellCheck={code ? false : undefined} /> : <Input {...props} />}
  </Field>;
}

export function CollectionHeading({ title, location, icon, onBack, backLabel, children }: {
  title: string; location: string; icon: ReactNode; onBack(): void; backLabel: string; children?: ReactNode;
}) {
  return <div className="settings-collection-heading flex flex-wrap items-start gap-3">
    <CollectionBack label={backLabel} onClick={onBack} />
    <div className="settings-collection-identity flex min-w-0 flex-1 items-start gap-3">
      <span className="settings-collection-icon" aria-hidden="true">{icon}</span>
      <div className="min-w-0"><h3 tabIndex={-1} data-collection-heading>{title}</h3><p>{location}</p></div>
    </div>
    {children}
  </div>;
}

function CollectionBack({ label, onClick }: { label: string; onClick(): void }) {
  return <Button className="settings-collection-back" variant="ghost" aria-label={label} onClick={onClick}><ArrowLeftIcon data-icon="inline-start" />列表</Button>;
}

export function CollectionEmpty({ title, icon, children, onBack, backLabel = '返回列表' }: { title: string; icon: ReactNode; children?: ReactNode; onBack?(): void; backLabel?: string }) {
  return <>{onBack ? <CollectionBack label={backLabel} onClick={onBack} /> : null}<Empty className="settings-collection-empty"><EmptyHeader><EmptyMedia variant="icon">{icon}</EmptyMedia><EmptyTitle>{title}</EmptyTitle></EmptyHeader>{children ? <EmptyContent>{children}</EmptyContent> : null}</Empty></>;
}

// The container query owns the breakpoint. Focus/scroll work only runs after an
// explicit pane action, never during field typing or ordinary rerenders.
export function useCollectionPane(key: string, tree: RefObject<HTMLDivElement | null>) {
  const [detailOpen, setDetailOpen] = useViewState(`${key}:detail-open`, false);
  const memory = useViewMemory();
  const ref = useRef<HTMLDivElement>(null), scroll = useRef((memory?.get(`${key}:pane-scroll`) as number) || 0), frame = useRef(0), interaction = useRef(0);
  useEffect(() => {
    const advance = () => { interaction.current++; };
    window.addEventListener('pointerdown', advance, true); window.addEventListener('keydown', advance, true);
    return () => { cancelAnimationFrame(frame.current); window.removeEventListener('pointerdown', advance, true); window.removeEventListener('keydown', advance, true); };
  }, []);
  function schedule(action: (focusAllowed: boolean) => void) { const current = interaction.current; cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(() => action(current === interaction.current)); }
  function openDetail(focusTitle = false) {
    if (tree.current?.getClientRects().length) scroll.current = tree.current.scrollTop;
    memory?.set(`${key}:pane-scroll`, scroll.current);
    setDetailOpen(true);
    schedule(focusAllowed => {
      if (!focusAllowed) return;
      if (focusTitle) { const title = ref.current?.querySelector<HTMLInputElement>('[data-collection-detail] input[aria-label="标题"]'); title?.focus(); title?.select(); }
      else if (ref.current?.querySelector('.settings-collection-back')?.getClientRects().length) ref.current.querySelector<HTMLElement>('[data-collection-heading]')?.focus();
    });
  }
  function back(id: string, attribute: string) {
    setDetailOpen(false);
    schedule(focusAllowed => {
      const list = tree.current;
      if (!list) return;
      list.scrollTop = scroll.current;
      if (!focusAllowed) return;
      const row = [...list.querySelectorAll<HTMLElement>('[role=treeitem]')].find(row => row.getAttribute(attribute) === id);
      (row || ref.current?.querySelector<HTMLElement>('[data-collection-list] input'))?.focus({ preventScroll: true });
    });
  }
  return { ref, detailOpen, openDetail, back, onListFocus: () => setDetailOpen(false), onDetailFocus: () => setDetailOpen(true) };
}
