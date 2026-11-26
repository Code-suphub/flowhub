import type { MouseEvent, ReactNode } from 'react';
import { ActivityIcon, BoxIcon, ChevronRightIcon, KeyRoundIcon, LayoutDashboardIcon, MessagesSquareIcon, MoreHorizontalIcon, PuzzleIcon, SearchIcon, ServerIcon, UsbIcon } from 'lucide-react';
import { FeatureIcon, type IconTone } from '../shared/FeatureIcon';
import { Button } from '../shared/ui';
import { ActionMenu } from '../shared/ActionMenu';
import { Switch } from '../shared/controls';
import { Badge } from '../components/ui/badge';
import type { Candidate, Installed, Manifest } from './api';
import { installLabel } from './versions';
import type { MarketItemNavigation } from './useMarketNavigation';

const icons:Record<string,typeof PuzzleIcon> = {'device-center':UsbIcon,'resource-monitor':ActivityIcon,machines:ServerIcon,docker:BoxIcon,twofa:KeyRoundIcon,'social-hub':MessagesSquareIcon};
function openCardDetails(event:MouseEvent<HTMLElement>,open:()=>void) {
  if (!(event.target instanceof Element) || event.target.closest('button, a, input, summary, details, [role="switch"], [role="menuitem"]')) return;
  if (window.getSelection()?.isCollapsed === false) return;
  open();
}

function PluginCard({manifest, metadata, actions, source, compact, navigation, onDetails}: {
  manifest: Manifest;
  metadata: ReactNode;
  actions: ReactNode;
  source?: string;
  compact: boolean;
  navigation: MarketItemNavigation;
  onDetails: () => void;
}) {
  return <article className={compact?'market-catalog-card market-catalog-card-compact':'market-catalog-card'} aria-label={manifest.name} {...navigation} onClick={event=>openCardDetails(event,onDetails)}>
    <div className="market-plugin-identity">
      <PluginIcon manifest={manifest}/>
      <div className="min-w-0">
        <h2><button tabIndex={navigation.tabIndex===-1?-1:undefined} type="button" className="market-name-button" onClick={onDetails} aria-label={`查看${manifest.name}详情`}>{manifest.name}<ChevronRightIcon aria-hidden="true"/></button></h2>
        <div className="market-catalog-version">{metadata}</div>
      </div>
    </div>
    {compact?actions:null}
    <p className="market-description">{manifest.description || '此插件尚未提供功能介绍。'}</p>
    <div className="market-card-footer">
      <div className="min-w-0">{source?<p className="market-source-name" title={source}>{source}</p>:null}<Features manifest={manifest}/></div>
      {!compact?actions:null}
    </div>
  </article>;
}
export function PluginIcon({id,manifest}: {id?:string;manifest?:Manifest}) {
  const Icon=icons[id || manifest?.id || ''] || (manifest?.widget?LayoutDashboardIcon:manifest?.statusSurface?ActivityIcon:manifest?.searchable?SearchIcon:PuzzleIcon);
  const tones:Record<string,IconTone>={'device-center':'blue','resource-monitor':'green',machines:'green',docker:'sky',twofa:'violet','social-hub':'pink'};
  return <FeatureIcon icon={Icon} tone={tones[id || manifest?.id || ''] || 'violet'} size="large" className="market-plugin-icon"/>;
}
export function Features({manifest}: {manifest: Manifest}) {
  const features = [manifest.searchable && {label:'搜索入口',Icon:SearchIcon}, manifest.widget && {label:'桌面组件',Icon:LayoutDashboardIcon}, manifest.statusSurface && {label:'状态面板',Icon:ActivityIcon}].filter(Boolean) as {label:string;Icon:typeof SearchIcon}[];
  return features.length ? <div className="market-features">{features.map(({label,Icon})=><span key={label}><Icon aria-hidden="true"/>{label}</span>)}</div> : null;
}
export function CatalogCard({item, sourceName, official, installed, disabled, compact, onInstall, onManage, onDetails,navigation}: {item:Candidate;sourceName:string;official:boolean;installed?:Installed;disabled:boolean;compact:boolean;onInstall:()=>void;onManage:()=>void;onDetails:()=>void;navigation:MarketItemNavigation}) {
  const action=installLabel(item,installed), same=action==='管理';
  const tabIndex=navigation.tabIndex===-1?-1:undefined;
  const source=official?'FlowHub 官方':sourceName;
  const actions=<div className="market-card-actions flex items-center gap-1"><Button tabIndex={tabIndex} variant={same?'outline':'default'} size="sm" disabled={same?false:disabled} onClick={same?onManage:onInstall}>{compact && same?'已安装 · 管理':action}</Button>{same && !compact?<ActionMenu tabIndex={tabIndex} label={`更多${item.manifest.name}操作`} icon={<MoreHorizontalIcon/>} disabled={disabled} popupClassName="fh-market-menu" items={[{id:'reinstall',label:'重新安装此版本',disabled,onSelect:onInstall}]}/>:null}</div>;
  return <PluginCard manifest={item.manifest} compact={compact} source={compact?undefined:source} navigation={navigation} onDetails={onDetails} actions={actions} metadata={<>
    <span className="market-meta">{compact?`${source} · `:null}v{item.manifest.version}</span>
    {installed && (!compact || !same)?<Badge variant="secondary">{action==='更新'?`已安装 v${installed.manifest.version}`:'已安装'}</Badge>:null}
  </>}/>;
}
export function InstalledCard({item,update,canUpdate,disabled,onToggle,onChooseDirectory,onUninstall,onUpdate,onOpen,onDetails,navigation}: {item:Installed;update?:Candidate;canUpdate:boolean;disabled:boolean;onToggle:()=>void;onChooseDirectory:()=>void;onUninstall:()=>void;onUpdate:()=>void;onOpen:()=>void;onDetails:()=>void;navigation:MarketItemNavigation}) {
  const {manifest,enabled}=item;
  const tabIndex=navigation.tabIndex===-1?-1:undefined;
  const showUpdate=Boolean(update) || (canUpdate && !enabled);
  const actions=<div className="market-card-actions flex items-center gap-1">
    <div className="market-installed-switch"><Switch tabIndex={tabIndex} label={`启用 ${manifest.name}`} disabled={disabled} checked={enabled} onChange={onToggle}/></div>
    {showUpdate?<Button tabIndex={tabIndex} size="sm" variant={update?'default':'outline'} disabled={disabled} onClick={onUpdate}>更新</Button>:
      enabled?<Button tabIndex={tabIndex} size="sm" variant="outline" disabled={disabled} onClick={onOpen}>打开</Button>:null}
    <ActionMenu tabIndex={tabIndex} label={`管理${manifest.name}`} icon={<MoreHorizontalIcon/>} disabled={disabled} triggerClassName="market-more-trigger" popupClassName="fh-market-menu" items={[
      ...(enabled && showUpdate?[{id:'open',label:'打开',onSelect:onOpen}]:[]),
      ...(canUpdate && !showUpdate?[{id:'update',label:'更新',onSelect:onUpdate}]:[]),
      {id:'details',label:'版本详情',onSelect:onDetails},
      {id:'directory',label:'更换安装目录…',onSelect:onChooseDirectory},
      {id:'uninstall',label:'卸载插件',onSelect:onUninstall},
    ]}/>
  </div>;
  return <PluginCard manifest={manifest} compact navigation={navigation} onDetails={onDetails} actions={actions} metadata={<>
    <span className="market-meta">v{manifest.version} · {enabled?'已启用':'已停用'}</span>
    {update?<span className="market-meta market-update-label">可更新至 v{update.manifest.version}</span>:null}
  </>}/>;
}
