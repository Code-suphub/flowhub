import type { Source } from './api';

// Public release catalogs verified on 2026-11-05. Keep versions explicit until
// the plugin repository publishes an aggregate index; refreshing is not updating.
// https://github.com/Code-suphub/flowhub-plugins/blob/main/docs/releases.md
export const officialKey = 'RWQIJOnosHIl5QGJ83XSe/Mx8aIvANKnnSUDpzVVNxCAZjTR+cBm1Jne';
export const officialPlugins = [
  {id:'device-center', name:'外设中心', version:'0.2.7'},
  {id:'resource-monitor', name:'应用资源监控', version:'0.3.0'},
  {id:'machines', name:'机器管理', version:'0.3.1'},
  {id:'docker', name:'Docker 管理', version:'0.1.0'},
  {id:'twofa', name:'2FA 验证码', version:'0.1.0'},
  {id:'social-hub', name:'社交聚合', version:'0.1.0'},
] as const;
export const officialSources: Source[] = officialPlugins.map(plugin=>({
  id:'', name:`FlowHub · ${plugin.name}`, kind:'https',
  location:`https://github.com/Code-suphub/flowhub-plugins/releases/download/${plugin.id}-v${plugin.version}/catalog.json`,
  key:officialKey,
}));
export function hasOfficialKey(key:string) {
  return key.trim().split(/\r?\n/).filter(line=>line.trim() && !line.startsWith('untrusted comment:')).join('').trim()===officialKey;
}
export function isOfficialSource(source?:Source) {
  return Boolean(source?.kind==='https' && hasOfficialKey(source.key) && officialSources.some(item=>item.location===source.location));
}
export function missingOfficialSources(sources:Source[]) {
  return officialSources.filter(preset=>!sources.some(source=>source.kind==='https' && source.location===preset.location && hasOfficialKey(source.key)));
}
