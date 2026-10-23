// Menu-bar sections describe placement, independently of per-item capability.
export function isKnownMenuBarSection(section: unknown): boolean {
  return section === 'visible' || section === 'hidden' || section === 'alwaysHidden';
}

export function menuBarSectionLabel(section: unknown): string {
  switch (section) {
    case 'visible': return '常显区';
    case 'hidden': return '随箭头展开／收起';
    case 'alwaysHidden': return '始终隐藏区';
    default: return '分区未知';
  }
}

export function menuBarVisibilityMatches(section: unknown, hidden: boolean): boolean {
  return hidden ? section === 'alwaysHidden' : section === 'visible' || section === 'hidden';
}
