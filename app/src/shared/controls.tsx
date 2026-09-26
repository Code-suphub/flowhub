import { useId, useState, type ReactElement, type ReactNode } from 'react';
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
