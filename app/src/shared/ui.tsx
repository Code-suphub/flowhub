import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ComponentProps, type InputHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from './controls';
import { Button as ShadcnButton } from '../components/ui/button';
import { Input as ShadcnInput } from '../components/ui/input';
import { Tabs as ShadcnTabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { cn } from '../lib/utils';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & Pick<ComponentProps<typeof ShadcnButton>, 'variant' | 'size'>;
export function Button({ className = '', variant, size = 'lg', type = 'button', ...props }: ButtonProps) {
  const classes = className.split(/\s+/);
  const legacyVariant = classes.includes('primary') ? 'default' : classes.includes('danger') ? 'destructive' : 'outline';
  return <ShadcnButton type={type} variant={variant ?? legacyVariant} size={size}
    className={cn('fh-button', classes.filter(name => name !== 'primary' && name !== 'danger').join(' '))} {...props} />;
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <ShadcnInput {...props} />;
}
export type Tab = { id: string; label: string; help?: string };
export function Tabs({ items, value, onChange, label }: { items: readonly Tab[]; value: string; onChange: (id: string) => void; label: string }) {
  return <ShadcnTabs value={value} onValueChange={next => onChange(String(next))} className="min-w-0 flex-1">
    <TabsList variant="line" activateOnFocus className="fh-tabs w-full justify-start" aria-label={label}>
      {items.map(item => <Tooltip key={item.id} content={item.help}><TabsTrigger className="flex-none" value={item.id} id={`tab-${item.id}`} aria-controls={`panel-${item.id}`}>{item.label}</TabsTrigger></Tooltip>)}
    </TabsList>
  </ShadcnTabs>;
}
// Native dialog provides the focus trap/top layer; all host React dialogs share this lifecycle.
export function Dialog({ title, onClose, busy, children, notice }: { title: string; onClose: () => void; busy: boolean; children: ReactNode; notice?: string }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!; dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="fh-dialog" aria-labelledby={titleId} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="flex items-center justify-between gap-4 mb-4"><h2 id={titleId}>{title}</h2><Button disabled={busy} aria-label="关闭" onClick={onClose}>×</Button></header>
    {children}
    {notice ? <p role="alert" className="whitespace-pre-wrap">{notice}</p> : null}
  </dialog>;
}
