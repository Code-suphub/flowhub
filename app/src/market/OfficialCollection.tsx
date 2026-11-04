import { ArrowRightIcon, PackageOpenIcon } from 'lucide-react';
import { Button } from '../shared/ui';
import { PluginIcon } from './PluginItems';
import { officialPlugins } from './official';

export function OfficialCollection({disabled,available,missing,onConnect}: {disabled:boolean;available:boolean;missing:number;onConnect:()=>void}) {
  return <section className="market-official-collection" aria-label="FlowHub 公开插件库">
    <div className="market-collection-copy">
      <span className="market-collection-label"><PackageOpenIcon aria-hidden="true"/>FlowHub 公开插件库</span>
      <h2>把常用工具，放在手边。</h2>
      <p>从设备状态到开发运维，连接官方库后按需安装。</p>
      {available?<Button variant="default" disabled={disabled} onClick={onConnect}>{missing===officialPlugins.length?'连接官方库':`补全官方库 (${missing})`}<ArrowRightIcon data-icon="inline-end"/></Button>:null}
      <p className="market-meta">当前公开版本适用于 macOS Apple Silicon。{available?'连接只添加来源，不会安装插件。':'请在桌面 App 中连接。'}</p>
    </div>
    <ul className="market-collection-tools">{officialPlugins.map(plugin=><li key={plugin.id}><PluginIcon id={plugin.id}/><div className="min-w-0"><span>{plugin.name}</span><small>v{plugin.version}</small></div></li>)}</ul>
  </section>;
}
