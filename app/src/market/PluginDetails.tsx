import { ShieldCheckIcon } from 'lucide-react';
import { Button, Dialog } from '../shared/ui';
import { Badge } from '../components/ui/badge';
import { Features, PluginIcon } from './PluginItems';
import { isOfficialSource } from './official';
import type { Candidate, Installed, Source } from './api';
import { installLabel } from './versions';

export function PluginDetails({item,source,installed,disabled,onClose,onInstall,onManage}: {item:Candidate;source?:Source;installed?:Installed;disabled:boolean;onClose:()=>void;onInstall:()=>void;onManage:()=>void}) {
  const {manifest}=item, action=installLabel(item,installed), same=action==='管理', official=isOfficialSource(source);
  const published=item.publishedAt && Number.isFinite(Date.parse(item.publishedAt))?new Date(item.publishedAt).toLocaleDateString():null;
  const target=item.target==='macos-aarch64'?'macOS · Apple Silicon':item.target==='macos-x86_64'?'macOS · Intel':item.target;
  return <Dialog title={`${manifest.name}详情`} className="fh-market-dialog market-detail-dialog" busy={false} restoreFocus={false} onClose={onClose}>
    <div className="market-detail-body">
    <div className="market-detail-identity">
      <PluginIcon manifest={manifest}/>
      <div className="market-detail-overview">
        <p className="market-detail-description">{manifest.description || '此插件尚未提供功能介绍。'}</p>
        <Features manifest={manifest}/>
      </div>
      {installed?<Badge variant="secondary">已安装</Badge>:null}
    </div>
    <dl className="market-detail-facts">
      <div><dt>可安装版本</dt><dd>v{manifest.version}</dd></div>
      {installed?<div><dt>本机版本</dt><dd>v{installed.manifest.version} · {installed.enabled?'已启用':'已停用'}</dd></div>:null}
      {target?<div><dt>适用平台</dt><dd>{target}</dd></div>:null}
      {published?<div><dt>发布时间</dt><dd><time dateTime={item.publishedAt}>{published}</time></dd></div>:null}
      <div><dt>插件 ID</dt><dd><code>{manifest.id}</code></dd></div>
      <div><dt>来源</dt><dd>{official?'FlowHub 官方':source?.name || '未知来源'}</dd></div>
      <div><dt>打开方式</dt><dd>从插件栏打开</dd></div>
    </dl>
    {item.releaseNotes?<details className="fh-disclosure market-location"><summary>版本说明</summary><p className="market-release-notes">{item.releaseNotes}</p></details>:<p className="market-meta">来源未提供版本说明。</p>}
    {source?.location?<details className="market-location"><summary>查看来源地址</summary><code>{source.location}</code></details>:null}
    <section className="market-detail-section"><h3><ShieldCheckIcon aria-hidden="true"/>安装与权限</h3><p className="market-meta">{source?.kind==='https'?'下载后由 FlowHub 校验包的签名与完整性。':'此插件来自本地目录。'}插件将在本机运行独立进程，可访问当前用户文件和网络。</p>{manifest.permissions?.length?<p className="market-meta">清单声明：<code>{manifest.permissions.join('、')}</code></p>:null}</section>
    </div>
    <div className="market-detail-actions"><Button onClick={onClose}>返回浏览</Button><Button variant="default" disabled={same?false:disabled} onClick={same?onManage:onInstall}>{same?'管理插件':action==='安装'?'安装插件':action==='更新'?'更新插件':action}</Button></div>
  </Dialog>;
}
