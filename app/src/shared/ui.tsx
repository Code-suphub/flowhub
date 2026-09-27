import { useEffect, useRef, type ButtonHTMLAttributes, type ComponentProps, type InputHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from './controls';
import { Button as ShadcnButton } from '../components/ui/button';
import { Input as ShadcnInput } from '../components/ui/input';
import { Tabs as ShadcnTabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Dialog as ShadcnDialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
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
export function Dialog({ title, onClose, busy, children, notice, className }: { title: string; onClose: () => void; busy: boolean; children: ReactNode; notice?: string; className?: string }) {
  const previousFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  useEffect(() => () => {
    const previous = previousFocus.current;
    if (previous?.isConnected) requestAnimationFrame(() => { if (previous.isConnected) previous.focus(); });
  }, []);
  return <ShadcnDialog open onOpenChange={open => { if (!open && !busy) onClose(); }} disablePointerDismissal>
    <DialogContent className={cn('fh-dialog gap-0', className)} showCloseButton={false} aria-busy={busy}>
      <DialogHeader className="mb-4 flex-row items-center justify-between gap-4">
        <DialogTitle>{title}</DialogTitle>
        <DialogClose render={<Button disabled={busy} aria-label="关闭" />}>×</DialogClose>
      </DialogHeader>
      {children}
      {notice ? <p role="alert" className="whitespace-pre-wrap">{notice}</p> : null}
    </DialogContent>
  </ShadcnDialog>;
}
