import { ActivityIcon, ContainerIcon, KeyRoundIcon, MessagesSquareIcon, PuzzleIcon, ServerIcon, UsbIcon, type LucideIcon } from 'lucide-react';
import './feature-icons.css';

export type IconTone = 'blue' | 'sky' | 'orange' | 'amber' | 'violet' | 'green' | 'teal' | 'pink' | 'slate';
type IconSize = 'small' | 'medium' | 'large';

/** FlowHub-specific artwork; controls and accessible names belong to the caller. */
export function FlowHubLogo({ className = '' }: { className?: string }) {
  return <img className={`flowhub-logo ${className}`} src="assets/flowhub.svg" alt="" aria-hidden="true" draggable={false} />;
}

export function FeatureIcon({ icon: Icon, tone = 'blue', size = 'medium', className = '' }: { icon: LucideIcon; tone?: IconTone; size?: IconSize; className?: string }) {
  return <span className={`fh-feature-icon ${className}`} data-tone={tone} data-size={size} data-icon="inline-start" aria-hidden="true"><Icon strokeWidth={1.8} /></span>;
}

const pluginArtwork: Record<string, { icon: LucideIcon; tone: IconTone }> = {
  'device-center': { icon: UsbIcon, tone: 'blue' },
  'resource-monitor': { icon: ActivityIcon, tone: 'green' },
  twofa: { icon: KeyRoundIcon, tone: 'violet' },
  docker: { icon: ContainerIcon, tone: 'sky' },
  'social-hub': { icon: MessagesSquareIcon, tone: 'pink' },
  machines: { icon: ServerIcon, tone: 'green' },
};

export function PluginIcon({ id, size = 'medium', className = '' }: { id: string; size?: IconSize; className?: string }) {
  const artwork = pluginArtwork[id] || { icon: PuzzleIcon, tone: 'violet' as const };
  return <FeatureIcon {...artwork} size={size} className={className} />;
}
