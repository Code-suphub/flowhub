import { useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Switch as ShadcnSwitch } from '../components/ui/switch';
import { Select as ShadcnSelect, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';

export function Switch({checked, onChange, disabled, label}: {checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label: string}) {
  return <ShadcnSwitch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />;
}

export function Tooltip({children, content}: {children: ReactNode; content?: ReactNode}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null), tip = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const rect = anchor.current.getBoundingClientRect(), box = tip.current.getBoundingClientRect();
    const trigger = anchor.current.querySelector('button');
    trigger?.setAttribute('aria-describedby', id);
    tip.current.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8)) + 'px';
    tip.current.style.top = (rect.bottom + box.height + 8 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - box.height - 6)) + 'px';
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {trigger?.removeAttribute('aria-describedby');window.removeEventListener('resize', close);document.removeEventListener('scroll', close, true);};
  }, [open, id]);
  return <span ref={anchor} className="fh-tooltip-anchor" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={event => {if (event.key === 'Escape' && open) {event.preventDefault();event.stopPropagation();setOpen(false);}}}>
    {children}
    {open && content ? <span ref={tip} id={id} role="tooltip" className="fh-help-content">{content}</span> : null}
  </span>;
}
export function Help({label = '说明', children}: {label?: string; children: ReactNode}) {
  return <span className="fh-help"><Tooltip content={children}><button type="button" aria-label={label}>?</button></Tooltip></span>;
}

export interface SelectOption {value: string; label: string; disabled?: boolean}
export function Select({value, options, onChange, label, disabled, id}: {value: string; options: readonly SelectOption[]; onChange: (value: string) => void; label: string; disabled?: boolean; id?: string}) {
  return <ShadcnSelect items={options.map(({value, label}) => ({value, label}))} value={value} onValueChange={next => { if (typeof next === 'string') onChange(next); }} disabled={disabled}>
    <SelectTrigger id={id} aria-label={label}><SelectValue>{() => options.find(option => option.value === value)?.label || '请选择'}</SelectValue></SelectTrigger>
    <SelectContent side="bottom" align="start" alignItemWithTrigger={false} aria-label={label}>
      <SelectGroup>
        {options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
      </SelectGroup>
    </SelectContent>
  </ShadcnSelect>;
}

export function EmptyState({children}: {children: ReactNode}) {return <p className="fh-empty" role="status">{children}</p>;}
