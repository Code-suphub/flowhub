import { ActivityIcon, BoxIcon, KeyRoundIcon, LayoutDashboardIcon, MessagesSquareIcon, MoreHorizontalIcon, PuzzleIcon, SearchIcon, ServerIcon, UsbIcon } from 'lucide-react';
import { FeatureIcon, type IconTone } from '../shared/FeatureIcon';
import { Button } from '../shared/ui';
import { ActionMenu } from '../shared/ActionMenu';
import { Badge } from '../components/ui/badge';
import type { Candidate, Installed, Manifest } from './api';
import { installLabel } from './versions';
import type { MarketItemNavigation } from './useMarketNavigation';

const icons:Record<string,typeof PuzzleIcon> = {'device-center':UsbIcon,'resource-monitor':ActivityIcon,machines:ServerIcon,docker:BoxIcon,twofa:KeyRoundIcon,'social-hub':MessagesSquareIcon};
export function PluginIcon({id,manifest}: {id?:string;manifest?:Manifest}) {
  const Icon=icons[id || manifest?.id || ''] || (manifest?.widget?LayoutDashboardIcon:manifest?.statusSurface?ActivityIcon:manifest?.searchable?SearchIcon:PuzzleIcon);
  const tones:Record<string,IconTone>={'device-center':'blue','resource-monitor':'green',machines:'green',docker:'sky',twofa:'violet','social-hub':'pink'};
  return <FeatureIcon icon={Icon} tone={tones[id || manifest?.id || ''] || 'violet'} size="large" className="market-plugin-icon"/>;
}
export function Features({manifest}: {manifest: Manifest}) {
  const features = [manifest.searchable && {label:'搜索入口',Icon:SearchIcon}, manifest.widget && {label:'桌面组件',Icon:LayoutDashboardIcon}, manifest.statusSurface && {label:'状态面板',Icon:ActivityIcon}].filter(Boolean) as {label:string;Icon:typeof SearchIcon}[];
  return features.length ? <div className="market-features">{features.map(({label,Icon})=><span key={label}><Icon aria-hidden="true"/>{label}</span>)}</div> : null;
}
export function CatalogCard({item, sourceName, official, installed, disabled, onInstall, onManage, onDetails,navigation}: {item:Candidate;sourceName:string;official:boolean;installed?:Installed;disabled:boolean;onInstall:()=>void;onManage:()=>void;onDetails:()=>void;navigation:MarketItemNavigation}) {
  const action=installLabel(item,installed), same=action==='管理';
  const tabIndex=navigation.tabIndex===-1?-1:undefined;
  return <article className="market-catalog-card" aria-label={item.manifest.name} {...navigation}>
    <div className="market-plugin-identity"><PluginIcon manifest={item.manifest}/><div className="min-w-0"><h2><button tabIndex={tabIndex} type="button" className="market-name-button" onClick={onDetails} aria-label={`查看${item.manifest.name}详情`}>{item.manifest.name}</button></h2><span className="market-meta">v{item.manifest.version}</span></div>{installed?<Badge variant="secondary" className="market-installed-badge">已安装</Badge>:null}</div>
    <p className="market-description">{item.manifest.description || '此插件尚未提供功能介绍。'}</p>
    <Features manifest={item.manifest}/>
    <div className="market-card-footer"><div className="min-w-0"><p className="market-source-name" title={sourceName}>{official?'FlowHub 官方':sourceName}</p><Button tabIndex={tabIndex} variant="link" size="sm" onClick={onDetails} aria-label={`${item.manifest.name}详情`}>查看详情</Button></div>
      <div className="market-card-actions flex items-center gap-1"><Button tabIndex={tabIndex} variant={same?'outline':'default'} size="sm" disabled={same?false:disabled} onClick={same?onManage:onInstall}>{action}</Button>{same?<ActionMenu tabIndex={tabIndex} label={`更多${item.manifest.name}操作`} icon={<MoreHorizontalIcon/>} disabled={disabled} popupClassName="fh-market-menu" items={[{id:'reinstall',label:'重新安装此版本',disabled,onSelect:onInstall}]}/>:null}</div>
    </div>
  </article>;
}
export function InstalledRow({item,update,disabled,onToggle,onReload,onUninstall,onUpdate,onOpen,onDetails,navigation}: {item:Installed;update?:Candidate;disabled:boolean;onToggle:()=>void;onReload:()=>void;onUninstall:()=>void;onUpdate:()=>void;onOpen:()=>void;onDetails?:()=>void;navigation:MarketItemNavigation}) {
  const tabIndex=navigation.tabIndex===-1?-1:undefined;
  return <article className="market-installed-row" aria-label={item.manifest.name} {...navigation}>
    <div className="market-installed-copy"><PluginIcon manifest={item.manifest}/><div className="market-installed-info"><div className="market-installed-title"><h2>{item.manifest.name}</h2><span className="market-meta">v{item.manifest.version}</span></div><p className="market-description">{item.manifest.description || '此插件尚未提供功能介绍。'}</p><div className="market-installed-details"><Features manifest={item.manifest}/>
      <details className="market-location"><summary tabIndex={tabIndex}>本机信息</summary><dl>{item.manifest.description?<><dt>功能说明</dt><dd>{item.manifest.description}</dd></>:null}<dt>安装目录</dt><dd><code>{item.directory}</code></dd><dt>最近加载</dt><dd>{item.lastLoadedAt?new Date(item.lastLoadedAt).toLocaleString():'暂无记录'}</dd></dl></details>
    </div></div></div>
    <div className="market-installed-actions">{update?<Badge variant="secondary">可更新至 v{update.manifest.version}</Badge>:<Badge variant={item.enabled?'secondary':'outline'}>{item.enabled?'已启用':'已停用'}</Badge>}{update?<Button tabIndex={tabIndex} size="sm" variant="default" disabled={disabled} onClick={onUpdate}>更新</Button>:item.enabled?<Button tabIndex={tabIndex} size="sm" disabled={disabled} onClick={onOpen}>打开</Button>:null}<Button tabIndex={tabIndex} size="sm" disabled={disabled} onClick={onToggle}>{item.enabled?'停用':'启用'}</Button>
      <ActionMenu tabIndex={tabIndex} label={`管理${item.manifest.name}`} icon={<MoreHorizontalIcon/>} disabled={disabled} popupClassName="fh-market-menu" items={[
        ...(item.enabled && update?[{id:'open',label:'打开插件',onSelect:onOpen}]:[]),
        ...(onDetails?[{id:'details',label:'版本详情',onSelect:onDetails}]:[]),
        {id:'reload',label:'重新加载',disabled:disabled || !item.enabled,onSelect:onReload},
        {id:'uninstall',label:'卸载插件',disabled,onSelect:onUninstall},
      ]}/>
    </div>
  </article>;
}
