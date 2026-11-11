#!/usr/bin/env node
// Assemble reviewed fixture exports; ordinary application data is never an input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {normalizePresentation,validateLibrary} from './sync.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const inputs=process.argv.slice(2);
if(!inputs.length)throw Error('Pass reviewed public-fixture export JSON files.');
const entries=[];
for(const filename of inputs){
 const data=JSON.parse(await fs.readFile(filename,'utf8'));
 const components=Array.isArray(data)?data:data.components??data.newComponents;
 if(!Array.isArray(components))throw Error(`No design components in ${filename}.`);
 for(const component of components){
  if(component.source?.fixture!==true)throw Error(`Missing explicit fixture provenance: ${component.name}.`);
  if(component.source.entry?.includes('/build/ui/')){
    component.source.buildEntry=component.source.entry;
    component.source.entry=component.source.entry.replace('/build/ui/','/ui/');
  }
  component.source.repository=component.source.entry?.startsWith('plugins/')?'Code-suphub/flowhub-plugins':'Code-suphub/flowhub';
  component.body=normalizePresentation(component.body);
  entries.push(component);
 }
}
const palette={
 'FH Canvas':'#eff3ed','FH Surface':'#f9fbf6','FH Surface Soft':'#e9efe7','FH Surface Raised':'#ffffff',
 'FH Text':'#263b30','FH Muted':'#596e60','FH Border':'#d5dfd3','FH Accent':'#3c6d53',
 'FH Accent Strong':'#29533d','FH Accent Soft':'#e0ebdf','FH Danger':'#b83e4b','FH Warning':'#916616','FH Positive':'#287960'
};
const colorNames=new Map(Object.entries(palette).flatMap(([name,hex])=>{
 const channels=hex.slice(1).match(/../g).map(part=>parseInt(part,16));
 return [[hex.toLowerCase(),name],[`rgb(${channels.join(', ')})`,name]];
}));
function tokenize(node){
 if(typeof node!=='object'||!node)return;
 for(const [prop,value]of Object.entries(node.styles??{})){
  // Typography and layout remain the source component's values. Only known
  // semantic colors become shared tokens; opacity/gradient colors stay intact.
  const name=typeof value==='string'?colorNames.get(value.toLowerCase()):undefined;
  if(name)node.styles[prop]=`$token(${name})`;
 }
 for(const child of node.children==null?[]:Array.isArray(node.children)?node.children:[node.children])tokenize(child);
}
entries.forEach(entry=>tokenize(entry.body));
const t=(value,styles={})=>({type:'text',value,styles:{fontFamily:'system-ui',fontSize:'14px',lineHeight:'1.5',...styles}});
const catalog={name:'FlowHub · 页面目录',path:'/',source:{fixture:true,entry:'design/plasmic/project.json',repository:'Code-suphub/flowhub',nativeBehavior:false},body:{type:'vbox',tag:'main',styles:{padding:'28px',gap:'12px',fontFamily:'system-ui',backgroundColor:'$token(FH Surface)',color:'$token(FH Text)',width:'100%',maxWidth:'1100px'},children:[
 t('FlowHub 页面库',{fontSize:'26px',fontWeight:'700'}),
 t('来自主体与六个插件的实际界面，使用公开合成数据。这里维护可视结构；原生操作、权限和业务状态仍由源码负责。',{color:'$token(FH Muted)'}),
 ...entries.map(entry=>({type:'hbox',styles:{gap:'12px',padding:'8px 0',borderBottomWidth:'1px',borderBottomStyle:'solid',borderBottomColor:'$token(FH Border)'},children:[entry.path?{type:'text',tag:'a',value:entry.name,attrs:{href:entry.path},styles:{fontSize:'14px',fontWeight:'600',color:'$token(FH Accent)',width:'320px'}}:t(entry.name,{fontWeight:'600',width:'320px'}),t(entry.source.entry??entry.source.component??'插件界面组件',{fontSize:'12px',color:'$token(FH Muted)'})]}))
 ]}};
const library={schema:1,projectId:'rKroot8WmpiogJg8366SaB',source:{host:'4543be2',plugins:'1e5563e',scope:'actual public-fixture presentation; no production API or native input'},tokens:Object.entries(palette).map(([name,value])=>({name,value,type:'Color'})),components:[...entries,catalog]};
const counts=validateLibrary(library);
const output=path.join(os.homedir(),'.local/state/flowhub-plasmic/library.json');
await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
await fs.writeFile(output,JSON.stringify(library,null,2)+'\n',{mode:0o600});
await fs.writeFile(path.join(root,'project.json'),JSON.stringify({schema:library.schema,projectId:library.projectId,source:library.source,components:library.components.map(({name,path:route,source})=>({name,...(route?{path:route}:{}),source}))},null,2)+'\n');
const rows=entries.map(entry=>`| ${entry.name} | ${entry.path??'组件'} | ${entry.source.repository} | ${entry.source.react??entry.source.component??entry.source.entry??'—'} | ${entry.source.fixtureKind??'只读合成预览'} |`);
await fs.writeFile(path.join(root,'pages.md'),'# 页面与源码对应\n\n这些是可编辑的设计基线，不是生产运行时，也不代表原生功能验收。\n\n| 页面 / 状态 | Plasmic 路径 | 仓库 | 源入口 / 实现 | 数据方式 |\n| --- | --- | --- | --- | --- |\n'+rows.join('\n')+'\n');
console.log(JSON.stringify({...counts,output}));
