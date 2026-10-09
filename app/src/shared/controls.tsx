import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { observePopupOwner } from '../../../../common-components/packages/frontend/dom/popup';
import { cn } from '../lib/utils';
import { Switch as ShadcnSwitch } from '../components/ui/switch';
import { Select as ShadcnSelect, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tooltip as ShadcnTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';

export function Switch({checked, onChange, disabled, label}: {checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label: string}) {
  return <ShadcnSwitch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />;
}

export function Tooltip({children, content}: {children: ReactElement; content?: ReactNode}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!content) return children;
  return <TooltipProvider>
    <ShadcnTooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger render={children} aria-describedby={open ? id : undefined} />
      <TooltipContent id={id} role="tooltip" side="bottom">{content}</TooltipContent>
    </ShadcnTooltip>
  </TooltipProvider>;
}
export function Help({label = '说明', children}: {label?: string; children: ReactNode}) {
  return <span className="fh-help"><Tooltip content={children}><button type="button" aria-label={label}>?</button></Tooltip></span>;
}

export interface SelectOption {value: string; label: string; disabled?: boolean}
export function Select({value, options, onChange, label, disabled, id, labelledBy, popupClassName}: {value: string; options: readonly SelectOption[]; onChange: (value: string) => void; label: string; disabled?: boolean; id?: string; labelledBy?: string; popupClassName?: string}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const actions = useRef<{ unmount(): void } | null>(null);
  const changeOpen = (next: boolean) => setOpen(next);
  // Remove the visible layer before paint; Base UI may retain hidden options
  // for keyboard navigation, so don't conditionally remove SelectContent.
  useLayoutEffect(() => { if (!open) actions.current?.unmount(); }, [open]);
  useEffect(() => {
    if (!open) return;
    if (disabled) { changeOpen(false); return; }
    return trigger.current ? observePopupOwner(trigger.current, () => changeOpen(false)) : undefined;
  }, [open, disabled]);
  return <ShadcnSelect actionsRef={actions} open={open} onOpenChange={changeOpen} items={options.map(({value, label}) => ({value, label}))} value={value} onValueChange={next => { if (typeof next === 'string') onChange(next); }} disabled={disabled}>
    <SelectTrigger ref={trigger} id={id} aria-label={label} aria-labelledby={labelledBy}><SelectValue>{() => options.find(option => option.value === value)?.label || '请选择'}</SelectValue></SelectTrigger>
    <SelectContent className={cn('fh-select-popup', popupClassName)} side="bottom" align="start" alignItemWithTrigger={false} aria-label={label}>
      <SelectGroup>
        {options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled} title={option.label}>{option.label}</SelectItem>)}
      </SelectGroup>
    </SelectContent>
  </ShadcnSelect>;
}

export function EmptyState({children}: {children: ReactNode}) {return <p className="fh-empty" role="status">{children}</p>;}
