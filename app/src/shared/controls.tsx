import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';

export function Switch({checked, onChange, disabled, label}: {checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label: string}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="fh-switch" onClick={() => onChange(!checked)}><span /></button>;
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
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const typed = useRef({text: '', at: 0});
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {if (!ref.current?.contains(event.target as Node)) setOpen(false);};
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  function choose(index: number) {const option = options[index]; if (!option || option.disabled) return; onChange(option.value);setOpen(false);trigger.current?.focus();}
  function nextEnabled(start: number, direction: number) {
    for (let step=1;step<=options.length;step++) {const index=(start+step*direction+options.length*2)%options.length;if(!options[index].disabled)return index;}
    return 0;
  }
  return <div ref={ref} className="fh-select-react" onBlur={event => {if(!event.currentTarget.contains(event.relatedTarget as Node))setOpen(false);}}>
    <button ref={trigger} type="button" role="combobox" id={id} className="fh-input" disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined} onClick={() => {setActive(Math.max(0, options.findIndex(option => option.value === value)));setOpen(!open);}} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {event.preventDefault();setOpen(true);setActive(index => nextEnabled(open ? index : options.findIndex(option => option.value === value), event.key === 'ArrowDown' ? 1 : -1));}
      if (event.key === 'Home' || event.key === 'End') {event.preventDefault();setOpen(true);setActive(nextEnabled(event.key === 'Home' ? -1 : options.length, event.key === 'Home' ? 1 : -1));}
      if (event.key === 'Escape' && open) {event.preventDefault();event.stopPropagation();setOpen(false);}
      if (open && (event.key === 'Enter' || event.key === ' ')) {event.preventDefault();choose(active);}
      if (event.key.length===1 && event.key!==' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const now=Date.now();typed.current={text:(now-typed.current.at<700?typed.current.text:'')+event.key.toLocaleLowerCase(),at:now};
        const match=options.findIndex(option=>!option.disabled && option.label.toLocaleLowerCase().startsWith(typed.current.text));
        if(match>=0){event.preventDefault();setOpen(true);setActive(match);}
      }
    }}>{options.find(option => option.value === value)?.label || '请选择'} <span aria-hidden="true">⌄</span></button>
    {open ? <div role="listbox" id={listId} aria-label={label} className="fh-select-options">{options.map((option, index) => <button id={`${listId}-${index}`} tabIndex={-1} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className={index === active ? 'active' : ''} key={option.value} onMouseEnter={() => setActive(index)} onMouseDown={event=>event.preventDefault()} onClick={() => choose(index)}>{option.label}</button>)}</div> : null}
  </div>;
}

export function EmptyState({children}: {children: ReactNode}) {return <p className="fh-empty" role="status">{children}</p>;}
