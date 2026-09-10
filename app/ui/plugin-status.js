(() => {
  const $=s=>document.querySelector(s),id=new URLSearchParams(location.search).get('id');
  const invoke=window.__TAURI__?.core?.invoke;
  let dirty=false,initialized=false,busy=false,last='';
  const labels={healthy:'正常',error:'异常',stale:'已过期',unknown:'未采集'};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api=(action,payload={})=>invoke('plugin_status_api',{id,action,payload});
  function render(data){
    const snapshot=data.snapshot,prefs=data.preferences;
    if(!snapshot){$('#message').textContent='等待插件状态，最多约 15 秒…';return;}
    $('#title').textContent=snapshot.title||'插件状态';
    $('#message').textContent=snapshot.error|| (snapshot.monitoring?'后台采集中':'后台采集未开启，显示已有缓存');
    const all=snapshot.rows||[],rows=all.filter(r=>!prefs.favorites.length||prefs.favorites.includes(r.id));
    $('#summary').innerHTML=Object.entries(labels).map(([key,label])=>`<span class="${key}">${label} ${rows.filter(r=>r.status===key).length}</span>`).join('');
    $('#rows').innerHTML=rows.map(r=>`<article class="card"><div class="card-head"><strong>${esc(r.name)}</strong><span class="${Object.hasOwn(labels,r.status)?r.status:'unknown'}">${labels[r.status]||'未采集'}</span></div>${r.values?`<div class="metrics">${[['cpu','CPU'],['memory','内存'],['disk','磁盘']].map(([key,name])=>`<span>${name}<b>${Number.isFinite(r.values[key])?r.values[key].toFixed(1)+'%':'—'}</b></span>`).join('')}</div>`:''}<time>${r.at?'采集于 '+esc(new Date(r.at).toLocaleString()):'尚无采集数据'}</time></article>`).join('')||'<p>暂无机器，请在插件中添加。</p>';
    const signature=JSON.stringify(all.map(r=>[r.id,r.name]));
    if(!dirty && (!initialized||signature!==last)){
      $('#tray').checked=prefs.tray;$('#pinned').checked=prefs.pinned;
      $('#favorites').innerHTML=all.map(r=>`<label><input type="checkbox" value="${esc(r.id)}" ${prefs.favorites.includes(r.id)?'checked':''}>${esc(r.name)}</label>`).join('');
      initialized=true;last=signature;
    }
  }
  async function load(){if(busy||document.hidden)return;busy=true;try{render(await api('get'));}catch(e){$('#message').textContent=String(e);}finally{busy=false;}}
  $('details').onchange=()=>{dirty=true;};
  $('#save').onclick=async()=>{
    $('#save').disabled=true;
    try{const data=await api('save',{tray:$('#tray').checked,pinned:$('#pinned').checked,favorites:Array.from(document.querySelectorAll('#favorites input:checked'),i=>i.value)});dirty=false;initialized=false;render(data);$('#message').textContent='显示设置已保存';}
    catch(e){$('#message').textContent=String(e);}finally{$('#save').disabled=false;}
  };
  $('#openPlugin').onclick=()=>api('plugin').catch(e=>{$('#message').textContent=String(e);});
  $('#showMenu').onclick=()=>api('menu').catch(e=>{$('#message').textContent=String(e);});
  if(invoke){load();setInterval(load,15000);document.addEventListener('visibilitychange',load);}else{$('#message').textContent='请在 FlowHub 中打开状态组件';$('details').hidden=true;$('#openPlugin').disabled=true;}
})();
