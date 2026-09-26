import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from './controls';
import { Input as ShadcnInput } from '../components/ui/input';

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`fh-button ${className}`} {...props} />;
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <ShadcnInput {...props} />;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-2 text-sm">{label}{children}</label>;
}
export type Tab = { id: string; label: string; help?: string };
export function Tabs({ items, value, onChange, label }: { items: readonly Tab[]; value: string; onChange: (id: string) => void; label: string }) {
  const ref = useRef<HTMLElement>(null);
  return <nav ref={ref} className="fh-tabs" role="tablist" aria-label={label}>
    {items.map((item, index) => <Tooltip key={item.id} content={item.help}><button type="button" role="tab" id={`tab-${item.id}`} aria-controls={`panel-${item.id}`}
      aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1}
      onClick={() => onChange(item.id)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
        onChange(items[next].id); ref.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
      }}>{item.label}</button></Tooltip>)}
  </nav>;
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
