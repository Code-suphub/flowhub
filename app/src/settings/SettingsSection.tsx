import type { ReactNode } from 'react';
import { FieldGroup, FieldLegend, FieldSet } from '../components/ui/field';

export function SettingsSection({title,children}: {title:string;children:ReactNode}) {
  return <FieldSet className="settings-section gap-3"><FieldLegend variant="label">{title}</FieldLegend><FieldGroup className="gap-0">{children}</FieldGroup></FieldSet>;
}
