import type { Candidate, Installed } from './api';

function version(value:string) {
  const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if(!match)return null;
  const pre=match[4]?.split('.') || [];
  if(pre.some(item=>/^\d+$/.test(item) && item.length>1 && item.startsWith('0')))return null;
  return {core:match.slice(1,4).map(item=>BigInt(item || '0')),pre};
}
export function compareVersions(a:string,b:string):number|null {
  const left=version(a),right=version(b);if(!left || !right)return null;
  for(let i=0;i<3;i++){if(left.core[i]!==right.core[i])return left.core[i]>right.core[i]?1:-1;}
  if(!left.pre.length || !right.pre.length)return left.pre.length===right.pre.length?0:left.pre.length?-1:1;
  for(let i=0;i<Math.max(left.pre.length,right.pre.length);i++){
    const x=left.pre[i],y=right.pre[i];if(x===y)continue;if(x===undefined)return -1;if(y===undefined)return 1;
    const nx=/^\d+$/.test(x),ny=/^\d+$/.test(y);
    if(nx && ny)return BigInt(x)>BigInt(y)?1:-1;
    if(nx!==ny)return nx?-1:1;return x>y?1:-1;
  }return 0;
}
export function installLabel(candidate:Candidate,installed?:Installed) {
  if(!installed)return '安装';
  const comparison=compareVersions(candidate.manifest.version,installed.manifest.version);
  return comparison===0?'管理':comparison===1 && !version(candidate.manifest.version)?.pre.length?'更新':comparison===-1?'回退版本':'更换版本';
}
export function availableUpdates(installed:Installed[],candidates:Candidate[]) {
  const result=new Map<string,Candidate>();
  for(const plugin of installed)for(const candidate of candidates){
    if(candidate.manifest.id!==plugin.manifest.id || installLabel(candidate,plugin)!=='更新')continue;
    const previous=result.get(plugin.manifest.id);
    if(!previous || compareVersions(candidate.manifest.version,previous.manifest.version)===1)result.set(plugin.manifest.id,candidate);
  }return result;
}
