import { PackageOpenIcon } from 'lucide-react';
import { Button } from '../shared/ui';

export function OfficialCollection({disabled,available,onConnect}: {disabled:boolean;available:boolean;onConnect:()=>void}) {
  return <section className="market-official-collection" aria-labelledby="market-official-title">
    <PackageOpenIcon aria-hidden="true"/>
    <div className="market-collection-copy">
      <h2 id="market-official-title">FlowHub 官方插件库</h2>
      <p className="market-meta">{available?'连接后可浏览适用于此 Mac 的稳定版本。':'请在桌面 App 中连接官方库。'}</p>
    </div>
    {available?<Button size="sm" variant="default" disabled={disabled} onClick={onConnect}>连接官方库</Button>:null}
  </section>;
}
