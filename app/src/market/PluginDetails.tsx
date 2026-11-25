import { ChevronDownIcon, ShieldCheckIcon } from 'lucide-react';
import { Button, Dialog } from '../shared/ui';
import { Badge } from '../components/ui/badge';
import { Features, PluginIcon } from './PluginItems';
import { isOfficialSource } from './official';
import { api, type Candidate, type Installed, type Source } from './api';
import { installLabel } from './versions';

type Release = {version:string;publishedAt:string;releaseNotes:string};
type ReleaseHistory = {releases:Release[];bounded:boolean};

function ReleaseDate({value}: {value?:string}) {
  return value && Number.isFinite(Date.parse(value))?<time dateTime={value}>{new Date(value).toLocaleDateString()}</time>:null;
}

function OfficialHistory({id}: {id:string}) {
  const [history,setHistory]=useState<ReleaseHistory>();
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  async function load(){
    setLoading(true);
    setError('');
    try {setHistory(await api<ReleaseHistory>('releaseHistory',{id}));}
    catch(reason){setError(String(reason));}
    finally {setLoading(false);}
  }
  return <section className="market-detail-section" aria-label="FlowHub 官方发布记录">
    {!history?<Button size="sm" disabled={loading} onClick={()=>void load()}>{loading?'正在读取官方发布记录…':error?'重试读取官方发布记录':'查看官方发布记录'}</Button>:<>
      <h3>FlowHub 官方发布记录</h3>
      {history.releases.length?history.releases.map(release=><details className="market-location" key={release.version}>
        <summary>v{release.version} <ReleaseDate value={release.publishedAt}/></summary>
        <p className="market-release-notes">{release.releaseNotes.trim() || '此版本未提供更新日志。'}</p>
      </details>):<p className="market-meta">未找到此插件适用于本机平台的公开稳定版。</p>}
      {history.bounded?<p className="market-meta">仅检查了最近 500 条官方发布。</p>:null}
    </>}
    {error?<p role="alert" className="market-meta">{error}</p>:null}
  </section>;
}

export function PluginDetails({item,source,installed,installedView,officialHistory,disabled,onClose,onInstall,onManage,onReinstall}: {item?:Candidate;source?:Source;installed?:Installed;installedView:boolean;officialHistory:boolean;disabled:boolean;onClose:()=>void;onInstall:()=>void;onManage:()=>void;onReinstall?:()=>void}) {
  const manifest=installedView?installed?.manifest:item?.manifest;
  if(!manifest)return null;
  const action=item?installLabel(item,installed):null, same=action==='管理', official=isOfficialSource(source);
  const target=item?.target==='macos-aarch64'?'macOS · Apple Silicon':item?.target==='macos-x86_64'?'macOS · Intel':item?.target;
  const published=item?.publishedAt;
  const notes=item?.releaseNotes?.trim();
  const sourceName=installedView && installed?.origin?.kind==='directory'?'本地目录':official?'FlowHub 官方':source?.name || '未知来源';
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
      {item?<div><dt>来源版本</dt><dd>v{item.manifest.version}</dd></div>:null}
      {installed?<div><dt>本机版本</dt><dd>v{installed.manifest.version} · {installed.enabled?'已启用':'已停用'}</dd></div>:null}
      {target?<div><dt>适用平台</dt><dd>{target}</dd></div>:null}
      {published && Number.isFinite(Date.parse(published))?<div><dt>发布时间</dt><dd><ReleaseDate value={published}/></dd></div>:null}
      <div><dt>插件 ID</dt><dd><code>{manifest.id}</code></dd></div>
      <div><dt>来源</dt><dd>{sourceName}</dd></div>
      <div><dt>打开方式</dt><dd>从插件栏打开</dd></div>
    </dl>
    <details className="market-current-release" open>
      <summary>更新日志{notes && item?` · v${item.manifest.version}`:''}<ChevronDownIcon aria-hidden="true"/></summary>
      <p className="market-release-notes">{notes || '当前来源未提供更新日志。'}</p>
    </details>
    {officialHistory?<OfficialHistory id={manifest.id}/>:null}
    {source?.location?<details className="market-location"><summary>查看来源地址</summary><code>{source.location}</code></details>:null}
    <section className="market-detail-section"><h3><ShieldCheckIcon aria-hidden="true"/>安装与权限</h3><p className="market-meta">{source?.kind==='https'?'下载后由 FlowHub 校验包的签名与完整性。':''}插件将在本机运行独立进程，可访问当前用户文件和网络。</p>{manifest.permissions?.length?<p className="market-meta">清单声明：<code>{manifest.permissions.join('、')}</code></p>:null}</section>
    </div>
    <div className="market-detail-actions"><Button onClick={onClose}>返回浏览</Button>{same && onReinstall?<Button disabled={disabled} onClick={onReinstall}>重新安装此版本</Button>:null}{action && !(installedView && same)?<Button variant="default" disabled={!same && disabled} onClick={same?onManage:onInstall}>{same?'管理插件':action==='安装'?'安装插件':action==='更新'?'更新插件':action}</Button>:null}</div>
  </Dialog>;
}
import { useState } from 'react';
