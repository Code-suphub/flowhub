import { navigationItems } from '../settings/navigation';
import type { SearchSnapshot } from './types';

export interface LauncherPlugin {id:string;name:string;description?:string}
export interface LauncherCommand {
  id:string;label:string;description:string;keywords:string;kind:'搜索范围'|'设置'|'插件'|'窗口';
  target:{type:'scope';id:string}|{type:'settings';module:string}|{type:'local';action:'preview'|'pin'|'clear'};
  shortcut?:string;disabled?:boolean;
}
export function launcherCommands(snapshot:SearchSnapshot,{plugins=[],readonly=false,previewable=false,previewOpen=false,pinAvailable=false}: {plugins?:LauncherPlugin[];readonly?:boolean;previewable?:boolean;previewOpen?:boolean;pinAvailable?:boolean}):LauncherCommand[] {
  const commands:LauncherCommand[]=[
    {id:'scope:all',label:'搜索全部结果',description:'使用当前关键词搜索所有已启用来源',keywords:'全部 搜索 all search',kind:'搜索范围',target:{type:'scope',id:'all'}},
    {id:'settings:extensions',label:'打开插件市场',description:'浏览、安装与管理插件',keywords:'插件 安装 扩展 市场 已安装 卸载 marketplace extension plugin',kind:'插件',target:{type:'settings',module:'extensions'}},
    ...navigationItems.map(page=>({id:`settings:${page.id}`,label:page.label,description:`前往设置 · ${page.group}`,keywords:page.keywords,kind:'设置' as const,target:{type:'settings' as const,module:page.id}})),
    ...(snapshot.state.plugins || []).filter((plugin:{enabled:boolean;available:boolean;searchable:boolean})=>plugin.enabled && plugin.available && plugin.searchable).map((plugin:{id:string;name:string;description?:string})=>({id:`scope:${plugin.id}`,label:`搜索${plugin.name}`,description:'切换搜索范围，保留当前关键词',keywords:`搜索 范围 ${plugin.id} ${plugin.description || ''}`,kind:'搜索范围' as const,target:{type:'scope' as const,id:plugin.id}})),
    ...plugins.filter(plugin=>/^[a-z0-9_-]{1,80}$/i.test(plugin.id)).map(plugin=>({id:`plugin:${plugin.id}`,label:String(plugin.name).slice(0,128),description:`打开插件工作区${plugin.description?` · ${String(plugin.description).slice(0,256)}`:''}`,keywords:`已安装 插件 plugin ${plugin.id}`,kind:'插件' as const,target:{type:'settings' as const,module:`plugin:${plugin.id}`}})),
  ];
  if(previewable)commands.push({id:'local:preview',label:previewOpen?'收起结果预览':'展开结果预览',description:'切换当前结果的详情布局',keywords:'预览 详情 展开 收起 preview detail',kind:'窗口',shortcut:'⌘I',target:{type:'local',action:'preview'}});
  if(pinAvailable)commands.push({id:'local:pin',label:snapshot.launcherPinned?'取消固定搜索窗口':'固定搜索窗口',description:'切换启动器固定状态',keywords:'固定 置顶 窗口 pinned pin window',kind:'窗口',disabled:readonly,target:{type:'local',action:'pin'}});
  if(snapshot.state.query)commands.push({id:'local:clear',label:'清除当前搜索',description:'清空当前关键词并返回结果列表',keywords:'清空 清除 查询 clear query',kind:'窗口',target:{type:'local',action:'clear'}});
  return commands;
}
const normalize=(text:string)=>text.normalize('NFKC').toLocaleLowerCase().trim();
export function findLauncherCommands(commands:LauncherCommand[],query:string) {
  const text=normalize(query.slice(0,256)),terms=text.split(/\s+/).filter(Boolean);
  return commands.filter(command=>terms.every(term=>normalize(`${command.label} ${command.description} ${command.keywords} ${command.kind}`).includes(term)))
    .map((command,index)=>({command,index,score:normalize(command.label)===text?0:normalize(command.label).startsWith(text)?1:normalize(command.label).includes(text)?2:3}))
    .sort((a,b)=>a.score-b.score || a.index-b.index).slice(0,60).map(entry=>entry.command);
}
