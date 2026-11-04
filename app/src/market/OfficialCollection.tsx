import { ArrowRightIcon, PackageOpenIcon } from 'lucide-react';
import { Button } from '../shared/ui';
import { PluginIcon } from './PluginItems';
import { officialPlugins } from './official';

export function OfficialCollection({disabled,available,onConnect}: {disabled:boolean;available:boolean;onConnect:()=>void}) {
  return <section className="market-official-collection" aria-label="FlowHub 公开插件库">
    <div className="market-collection-copy">
      <span className="market-collection-label"><PackageOpenIcon aria-hidden="true"/>FlowHub 公开插件库</span>
      <h2>把常用工具，放在手边。</h2>
      <p>从设备状态到开发运维，连接官方库后按需安装。</p>
      {available?<Button variant="default" disabled={disabled} onClick={onConnect}>连接官方库<ArrowRightIcon data-icon="inline-end"/></Button>:null}
      <p className="market-meta">自动查找适用于当前 Mac 的公开稳定版本。{available?'连接只添加来源，更新前会单独确认。':'请在桌面 App 中连接。'}</p>
    </div>
    <ul className="market-collection-tools">{officialPlugins.map(plugin=><li key={plugin.id}><PluginIcon id={plugin.id}/><div className="min-w-0"><span>{plugin.name}</span></div></li>)}</ul>
  </section>;
}
