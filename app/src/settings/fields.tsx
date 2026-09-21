import { useState, type ReactNode, type KeyboardEvent } from 'react';
import { Button, Input } from '../shared/ui';
import { Help, Switch, Select } from '../shared/controls';
import { canonical } from './model';
export function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) { return <div className="settings-row grid gap-2 sm:grid-cols-2 items-center"><div className="flex items-center gap-2"><span>{label}</span>{help ? <Help label={`${label}说明`}>{help}</Help> : null}</div><div className="min-w-0">{children}</div></div>; }
export function TextField({ label, value, onChange, help, type = 'text', min, max, readOnly = false }: { label: string; value: unknown; onChange?: (value: string) => void; help?: string; type?: string; min?: number; max?: number; readOnly?: boolean }) { return <Row label={label} help={help}><Input aria-label={label} value={String(value ?? '')} type={type} min={min} max={max} readOnly={readOnly} onChange={e => onChange?.(e.target.value)} /></Row>; }
export function Toggle({ label, checked, onChange, disabled, help }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; help?: string }) { return <Row label={label} help={help}><Switch label={label} checked={checked} onChange={onChange} disabled={disabled} /></Row>; }
export function Choice({ label, value, options, onChange, help }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; help?: string }) { return <Row label={label} help={help}><Select label={label} value={value} options={options} onChange={onChange} /></Row>; }
export function Shortcut({ label, value, taken, onChange, allowBare = false }: { label: string; value: string; taken: string[]; onChange: (value: string) => void; allowBare?: boolean }) {
  const [capturing, setCapturing] = useState(false), [error, setError] = useState('');
  function key(event: KeyboardEvent) {
    if (!capturing) return; event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { setCapturing(false); setError(''); return; }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    if (['Backspace', 'Delete'].includes(event.key) && allowBare) { onChange(''); setCapturing(false); return; }
    const modifiers = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta'].filter(Boolean);
    const key = event.code.startsWith('Digit') ? event.code.slice(5) : event.code === 'Space' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
    if (!modifiers.length && !(allowBare && /^\d$|^F([1-9]|1\d|2[0-4])$/.test(key))) { setError('请使用组合键'); return; }
    const next = [...modifiers, key].join('+');
    if (taken.some(v => v && canonical(v) === canonical(next))) { setError('快捷键与其他入口冲突'); return; }
    onChange(next); setError(''); setCapturing(false);
  }
  return <Row label={label} help="点击后按组合键；Escape 取消，范围键可用 Delete 清空。"><Button aria-label={label} aria-pressed={capturing} onClick={() => setCapturing(true)} onBlur={() => setCapturing(false)} onKeyDown={key}>{capturing ? '请按快捷键…' : value || '未设置'}</Button>{error ? <p role="alert">{error}</p> : null}</Row>;
}
