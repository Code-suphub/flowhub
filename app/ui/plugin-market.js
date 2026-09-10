(() => {
const $=s=>document.querySelector(s),invoke=window.parent.__TAURI__?.core?.invoke,api=(action,payload={})=>invoke('plugin_api',{action,payload});
let installed=[],sources=[],found=[],busy=false;
$('#openCanvas').onclick=()=>{if(invoke)invoke('plugin_canvas_api',{action:'open',payload:{}}).catch(e=>$('#notice').textContent=String(e));else $('#notice').textContent='请在 FlowHub 中打开桌面组件';};
const tabs=[...document.querySelectorAll('[data-tab]')];
function tab(name){tabs.forEach(b=>{const active=b.dataset.tab===name;b.setAttribute('aria-selected',active);b.tabIndex=active?0:-1;$('#'+b.dataset.tab).hidden=!active;});}
tabs.forEach((b,i)=>{b.onclick=()=>tab(b.dataset.tab);b.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const next=tabs[(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];next.click();next.focus();}};});
function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>operate(fn);return b;}
function row(title,description,actions){const r=document.createElement('article'),info=document.createElement('div'),h=document.createElement('h2'),p=document.createElement('p'),a=document.createElement('div');h.textContent=title;p.textContent=description;info.append(h,p);a.className='actions';actions.forEach(b=>a.append(b));r.append(info,a);return r;}
async function refresh(){[installed,sources]=await Promise.all([api('list'),api('sources')]);render();await window.parent.FlowHubPluginIntegration?.refresh();}
function render(){
$('#plugins').replaceChildren(...installed.map(p=>row(p.manifest.name+' · '+p.manifest.version+(p.enabled?'':' · 已停用'),p.directory,[button('重新加载',async()=>{await api('reload',{id:p.manifest.id});$('#notice').textContent='重新加载完成';}),button(p.enabled?'停用':'启用',()=>api('enable',{id:p.manifest.id,enabled:!p.enabled})),button('卸载',()=>api('uninstall',{id:p.manifest.id}))])));
if(!installed.length)$('#plugins').textContent='尚未安装插件，请到“发现”中选择安装。';
$('#sourceRows').replaceChildren(...sources.map(s=>row(s.name,(s.kind==='local'?'本地目录':'HTTPS 仓库')+' · '+s.location,[button('扫描',async()=>{await scan(s);tab('discover');}),button('编辑',()=>edit(s)),button('移除',async()=>{await api('removeSource',{id:s.id});found=found.filter(c=>c.source!==s.id);})])));
if(!sources.length)$('#sourceRows').textContent='添加本地目录或 HTTPS 仓库，保存后即可扫描插件。';renderFound();
}
function renderFound(){const q=$('#search').value.toLowerCase(),visible=found.filter(c=>(c.manifest.name+' '+c.manifest.description).toLowerCase().includes(q));
$('#discoverRows').replaceChildren(...visible.map(c=>row(c.manifest.name+' · '+c.manifest.version,(c.manifest.description||'')+'\n来源：'+(sources.find(s=>s.id===c.source)?.name||''),[button(installed.some(p=>p.manifest.id===c.manifest.id)?'重新安装':'安装',async()=>{if(!await confirmInstall(c.manifest))return;await api('installCandidate',{token:c.token});$('#notice').textContent='安装完成，入口已加入侧栏。';tab('installed');})])));
if(!visible.length)$('#discoverRows').textContent=!sources.length?'还没有插件来源，先点击“配置来源”。':found.length?'没有匹配的插件。':'点击“刷新来源”查找可安装插件。';
}
function confirmInstall(m){return new Promise(resolve=>{const dialog=$('#installDialog');$('#installInfo').textContent=m.name+' · '+m.version+'\n将在本机运行插件进程，可访问当前用户文件和网络。';const finish=value=>{dialog.close();resolve(value);};$('#confirmInstall').disabled=false;$('#cancelInstall').disabled=false;$('#confirmInstall').onclick=()=>finish(true);$('#cancelInstall').onclick=()=>finish(false);dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.showModal();});}
async function operate(fn){if(busy||!invoke)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();await refresh();}catch(e){$('#notice').textContent=String(e);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
async function scan(s){const result=await api('scanSource',{id:s.id});found=found.filter(c=>c.source!==s.id).concat(result.plugins);$('#notice').textContent=result.warnings.join('\n')||s.name+'：发现 '+result.plugins.length+' 个插件';renderFound();}
$('#scan').onclick=()=>operate(async()=>{const warnings=[];for(const s of sources){try{await scan(s);}catch(e){found=found.filter(c=>c.source!==s.id);warnings.push(s.name+'：'+e);}}if(warnings.length)$('#notice').textContent=warnings.join('\n');});
$('#search').oninput=renderFound;$('#goSources').onclick=()=>tab('sources');
function kind(){return document.querySelector('input[name="kind"]:checked').value;}
function updateKind(){$('#keyField').hidden=kind()!=='https';$('#pickSource').hidden=kind()!=='local';}
document.querySelectorAll('input[name="kind"]').forEach(r=>r.onchange=updateKind);
function edit(s){$('#sourceForm').hidden=false;$('#sourceId').value=s?.id||'';$('#sourceName').value=s?.name||'';$('#sourceLocation').value=s?.location||'';$('#sourceKey').value=s?.key||'';document.querySelectorAll('input[name="kind"]').forEach(r=>r.checked=r.value===(s?.kind||'local'));updateKind();$('#sourceName').focus();}
$('#addSource').onclick=()=>edit(null);$('#cancelSource').onclick=()=>$('#sourceForm').hidden=true;
$('#pickSource').onclick=()=>operate(async()=>{const path=await api('chooseSource');if(path)$('#sourceLocation').value=path;});
$('#sourceForm').onsubmit=e=>{e.preventDefault();operate(async()=>{await api('saveSource',{id:$('#sourceId').value,name:$('#sourceName').value.trim(),kind:kind(),location:$('#sourceLocation').value.trim(),key:$('#sourceKey').value.trim()});found=[];$('#sourceForm').hidden=true;$('#notice').textContent='来源已保存，点击扫描查看插件。';});};
$('#choose').onclick=()=>operate(async()=>{const p=await api('choose');if(p&&await confirmInstall(p.manifest)){await api('install',{directory:p.directory});tab('installed');}});
if(invoke)refresh().catch(e=>$('#notice').textContent=String(e));else{document.querySelectorAll('button').forEach(b=>b.disabled=true);$('#notice').textContent='请在 FlowHub 设置中管理插件来源。';}
})();
