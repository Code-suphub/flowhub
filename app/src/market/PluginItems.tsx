import { ActivityIcon, LayoutDashboardIcon, MoreHorizontalIcon, PuzzleIcon, SearchIcon } from 'lucide-react';
import { Button } from '../shared/ui';
import { ActionMenu } from '../shared/ActionMenu';
import { Badge } from '../components/ui/badge';
import type { Candidate, Installed, Manifest } from './api';

function PluginIcon() {return <span className="market-plugin-icon" aria-hidden="true"><PuzzleIcon/></span>;}
function Identity({manifest}: {manifest: Manifest}) {
  return <div className="market-plugin-identity"><PluginIcon/><div className="min-w-0"><h2>{manifest.name}</h2><span className="market-meta">v{manifest.version}</span></div></div>;
}
function Features({manifest}: {manifest: Manifest}) {
  const features = [manifest.searchable && {label:'搜索入口',Icon:SearchIcon}, manifest.widget && {label:'桌面组件',Icon:LayoutDashboardIcon}, manifest.statusSurface && {label:'状态面板',Icon:ActivityIcon}].filter(Boolean) as {label:string;Icon:typeof SearchIcon}[];
  return features.length ? <div className="market-features">{features.map(({label,Icon})=><span key={label}><Icon aria-hidden="true"/>{label}</span>)}</div> : null;
}
export function CatalogCard({item, sourceName, installed, disabled, onInstall, onManage}: {item:Candidate;sourceName:string;installed?:Installed;disabled:boolean;onInstall:()=>void;onManage:()=>void}) {
  const same = installed?.manifest.version === item.manifest.version;
  return <article className="market-catalog-card" aria-label={item.manifest.name}>
    <Identity manifest={item.manifest}/>
    <p className="market-description">{item.manifest.description || '此插件尚未提供功能介绍。'}</p>
    <Features manifest={item.manifest}/>
    <div className="market-card-footer"><div className="min-w-0"><p className="market-source-name" title={sourceName}>{sourceName}</p>{installed ? <Badge variant="secondary">{same ? '已安装' : `已安装 v${installed.manifest.version}`}</Badge> : null}</div>
      <div className="market-card-actions flex items-center gap-1"><Button variant={same?'outline':'default'} size="sm" disabled={same?false:disabled} onClick={same?onManage:onInstall}>{same?'管理':installed?'更换版本':'安装'}</Button>{same?<ActionMenu label={`更多${item.manifest.name}操作`} icon={<MoreHorizontalIcon/>} disabled={disabled} popupClassName="fh-market-menu" items={[{id:'reinstall',label:'重新安装此版本',disabled,onSelect:onInstall}]}/>:null}</div>
    </div>
  </article>;
}
export function InstalledRow({item,disabled,onToggle,onReload,onUninstall}: {item:Installed;disabled:boolean;onToggle:()=>void;onReload:()=>void;onUninstall:()=>void}) {
  return <article className="market-installed-row" aria-label={item.manifest.name}>
    <div className="market-installed-copy"><PluginIcon/><div className="market-installed-info"><div className="market-installed-title"><h2>{item.manifest.name}</h2><span className="market-meta">v{item.manifest.version}</span></div><p className="market-description">{item.manifest.description || '此插件尚未提供功能介绍。'}</p><div className="market-installed-details"><Features manifest={item.manifest}/>
      <details className="market-location"><summary>本机信息</summary><dl>{item.manifest.description?<><dt>功能说明</dt><dd>{item.manifest.description}</dd></>:null}<dt>安装目录</dt><dd><code>{item.directory}</code></dd><dt>最近加载</dt><dd>{item.lastLoadedAt?new Date(item.lastLoadedAt).toLocaleString():'暂无记录'}</dd></dl></details>
    </div></div></div>
    <div className="market-installed-actions"><Badge variant={item.enabled?'secondary':'outline'}>{item.enabled?'已启用':'已停用'}</Badge><Button size="sm" disabled={disabled} onClick={onToggle}>{item.enabled?'停用':'启用'}</Button>
      <ActionMenu label={`管理${item.manifest.name}`} icon={<MoreHorizontalIcon/>} disabled={disabled} popupClassName="fh-market-menu" items={[
        {id:'reload',label:'重新加载',disabled:disabled || !item.enabled,onSelect:onReload},
        {id:'uninstall',label:'卸载插件',disabled,onSelect:onUninstall},
      ]}/>
    </div>
  </article>;
}
