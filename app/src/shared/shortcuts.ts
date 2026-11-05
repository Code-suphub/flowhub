import '../../ui/shared/shortcuts.js';

export interface ShortcutEvent {
  key: string; code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean;
  isComposing?: boolean; keyCode?: number; repeat?: boolean; getModifierState?: (key: string) => boolean;
}
interface ShortcutKeys {
  isMac(): boolean;
  canonical(text: string, mac?: boolean): string;
  capture(event: ShortcutEvent, allowBare?: boolean, mac?: boolean): {value?: string; error?: string} | null;
  matches(event: ShortcutEvent, shortcut: string, mac?: boolean): boolean;
  format(text: string, mac?: boolean): string;
}
declare global { interface Window { FlowHubShortcuts: ShortcutKeys } }
export const shortcutKeys = window.FlowHubShortcuts;
