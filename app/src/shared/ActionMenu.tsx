import type { ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Button } from './ui';

export type ActionMenuItem = { id: string; label: string; disabled?: boolean; checked?: boolean; onSelect?(): void };
/** Shared menu semantics: keyboard movement, Escape, outside dismissal and focus return. */
export function ActionMenu({ label, icon, items, triggerClassName, popupClassName }: {
  label: string; icon: ReactNode; items: ActionMenuItem[]; triggerClassName?: string; popupClassName?: string;
}) {
  return <Menu.Root><Menu.Trigger render={<Button variant="ghost" className={triggerClassName} aria-label={label} />}>{icon}</Menu.Trigger>
    <Menu.Portal><Menu.Positioner sideOffset={6} align="end" className="z-50"><Menu.Popup className={popupClassName} aria-label={label}>
      {items.map(item => item.checked === undefined ? <Menu.Item key={item.id} disabled={item.disabled} onClick={item.onSelect}>{item.label}</Menu.Item> : <Menu.CheckboxItem key={item.id} checked={item.checked} disabled={item.disabled} onCheckedChange={item.onSelect}><Menu.CheckboxItemIndicator>✓</Menu.CheckboxItemIndicator>{item.label}</Menu.CheckboxItem>)}
    </Menu.Popup></Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}
