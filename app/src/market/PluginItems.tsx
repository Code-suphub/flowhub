import { ActivityIcon, BoxIcon, ChevronRightIcon, KeyRoundIcon, LayoutDashboardIcon, MessagesSquareIcon, MoreHorizontalIcon, PuzzleIcon, SearchIcon, ServerIcon, UsbIcon } from 'lucide-react';
import { FeatureIcon, type IconTone } from '../shared/FeatureIcon';
import { Button } from '../shared/ui';
import { ActionMenu } from '../shared/ActionMenu';
import { Badge } from '../components/ui/badge';
import type { Candidate, Installed, Manifest } from './api';
import { installLabel } from './versions';
import type { MarketItemNavigation } from './useMarketNavigation';

const icons:Record<string,typeof PuzzleIcon> = {'device-center':UsbIcon,'resource-monitor':ActivityIcon,machines:ServerIcon,docker:BoxIcon,twofa:KeyRoundIcon,'social-hub':MessagesSquareIcon};
function openCardDetails(event:MouseEvent<HTMLElement>,open:()=>void) {
  if (!(event.target instanceof Element) || event.target.closest('button, a, input, summary, details, [role="menuitem"]')) return;
  if (window.getSelection()?.isCollapsed === false) return;
  open();
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
  const actions=<div className="market-card-actions flex items-center gap-1"><Button tabIndex={tabIndex} variant={same?'outline':'default'} size="sm" disabled={same?false:disabled} onClick={same?onManage:onInstall}>{compact && same?'已安装 · 管理':action}</Button>{same && !compact?<ActionMenu tabIndex={tabIndex} label={`更多${item.manifest.name}操作`} icon={<MoreHorizontalIcon/>} disabled={disabled} popupClassName="fh-market-menu" items={[{id:'reinstall',label:'重新安装此版本',disabled,onSelect:onInstall}]}/>:null}</div>;
  return <article className={compact?'market-catalog-card market-catalog-card-compact':'market-catalog-card'} aria-label={item.manifest.name} {...navigation} onClick={event=>openCardDetails(event,onDetails)}>
    <div className="market-plugin-identity">
      <PluginIcon manifest={item.manifest}/>
      <div className="min-w-0">
        <h2><button tabIndex={tabIndex} type="button" className="market-name-button" onClick={onDetails} aria-label={`查看${item.manifest.name}详情`}>{item.manifest.name}<ChevronRightIcon aria-hidden="true"/></button></h2>
        <div className="market-catalog-version">
          <span className="market-meta">{compact?<>{official?'FlowHub 官方':sourceName} · </>:null}v{item.manifest.version}</span>
          {installed && (!compact || !same)?<Badge variant="secondary">{action==='更新'?`已安装 v${installed.manifest.version}`:'已安装'}</Badge>:null}
        </div>
      </div>
    </div>
    <p className="market-description">{item.manifest.description || '此插件尚未提供功能介绍。'}</p>
    <div className="market-card-footer"><div className="min-w-0">{!compact?<p className="market-source-name" title={sourceName}>{official?'FlowHub 官方':sourceName}</p>:null}<Features manifest={item.manifest}/></div>{!compact?actions:null}</div>
    {compact?actions:null}
  </article>;
}
export function InstalledRow({item,update,sourceName,canUpdate,disabled,onToggle,onChooseDirectory,onUninstall,onUpdate,onOpen,onDetails,navigation}: {item:Installed;update?:Candidate;sourceName?:string;canUpdate:boolean;disabled:boolean;onToggle:()=>void;onChooseDirectory:()=>void;onUninstall:()=>void;onUpdate:()=>void;onOpen:()=>void;onDetails:()=>void;navigation:MarketItemNavigation}) {
  const tabIndex=navigation.tabIndex===-1?-1:undefined;
  return <article className="market-installed-row" aria-label={item.manifest.name} {...navigation} onClick={event=>openCardDetails(event,onDetails)}>
    <div className="market-installed-copy"><PluginIcon manifest={item.manifest}/><div className="market-installed-info">
      <div className="market-installed-title">
        <h2><button tabIndex={tabIndex} type="button" className="market-name-button" onClick={onDetails} aria-label={`查看${item.manifest.name}详情`}>{item.manifest.name}<ChevronRightIcon aria-hidden="true"/></button></h2>
        <span className="market-meta">v{item.manifest.version}</span>
      </div>
      <div className="market-installed-states">
        <Badge variant={item.enabled?'secondary':'outline'} className="market-state-badge" data-enabled={item.enabled}>{item.enabled?'已启用':'已停用'}</Badge>
        {update?<Badge variant="outline">可更新至 v{update.manifest.version}</Badge>:null}
      </div>
      <p className="market-description">{item.manifest.description || '此插件尚未提供功能介绍。'}</p><div className="market-installed-details"><Features manifest={item.manifest}/>
      <details className="market-location"><summary tabIndex={tabIndex}>本机信息</summary><dl><dt>更新来源</dt><dd>{item.origin?.kind==='directory'?'本地目录':sourceName || (item.origin?.source?'原市场来源已移除':'插件市场')}</dd><dt>安装目录</dt><dd><code>{item.directory}</code></dd><dt>最近加载</dt><dd>{item.lastLoadedAt?new Date(item.lastLoadedAt).toLocaleString():'暂无记录'}</dd></dl></details>
    </div></div></div>
    <div className="market-installed-actions">{item.enabled?<Button tabIndex={tabIndex} size="sm" variant={update?'outline':'default'} disabled={disabled} onClick={onOpen}>打开</Button>:null}{canUpdate?<Button tabIndex={tabIndex} size="sm" variant={update?'default':'outline'} disabled={disabled} onClick={onUpdate}>更新</Button>:null}<Button tabIndex={tabIndex} size="sm" variant={item.enabled?'ghost':update?'outline':'default'} disabled={disabled} onClick={onToggle}>{item.enabled?'停用':'启用'}</Button>
      <ActionMenu tabIndex={tabIndex} label={`管理${item.manifest.name}`} icon={<MoreHorizontalIcon/>} disabled={disabled} popupClassName="fh-market-menu" items={[
        {id:'details',label:'版本详情',onSelect:onDetails},
        {id:'directory',label:'更换安装目录…',disabled,onSelect:onChooseDirectory},
        {id:'uninstall',label:'卸载插件',disabled,onSelect:onUninstall},
      ]}/>
    </div>
  </article>;
}
import type { MouseEvent } from 'react';
