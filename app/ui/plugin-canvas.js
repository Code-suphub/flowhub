(() => {
  const $=s=>document.querySelector(s), invoke=window.__TAURI__?.core?.invoke;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let layout={boards:[{id:'default',title:'默认布局',cards:[]}],active:'default',pinned:false},sources=[],naming='new',saving=false;
  let editingCard=null,gesture=null,suppressClick=false,menuCard=null,menuLeaveTimer=null,menuWatchTimer=null,menuGeneration=0;
  const cancelMenuLeave=()=>{clearTimeout(menuLeaveTimer);menuLeaveTimer=null;};
  const closeMenu=()=>{cancelMenuLeave();clearTimeout(menuWatchTimer);menuGeneration++;menu.hidden=true;menuCard=null;};
  const insideMenu=target=>!!target&&(menu.contains(target)||menuCard?.contains(target));
  const scheduleMenuLeave=()=>{if(!menu.hidden&&menuLeaveTimer===null)menuLeaveTimer=setTimeout(()=>{menuLeaveTimer=null;closeMenu();},180);};
  const trackMenuPosition=(x,y)=>{if(menu.hidden)return;const contains=el=>{if(!el?.isConnected)return false;const r=el.getBoundingClientRect();return x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom;};if(contains(menu)||contains(menuCard))cancelMenuLeave();else scheduleMenuLeave();};
  // WKWebView can miss leave events when crossing a transparent desktop window.
  // Only watch while a pointer-opened menu is visible; ignore stale IPC replies.
  function watchMenu(){clearTimeout(menuWatchTimer);const generation=++menuGeneration;if(!invoke)return;const check=async()=>{try{const p=await invoke('plugin_canvas_api',{action:'cursor',payload:{}});if(generation!==menuGeneration||menu.hidden)return;trackMenuPosition(p.x,p.y);}catch{}if(generation===menuGeneration&&!menu.hidden)menuWatchTimer=setTimeout(check,120);};menuWatchTimer=setTimeout(check,120);}
  const menu=document.createElement('div');menu.className='card-menu';menu.hidden=true;menu.setAttribute('role','menu');document.body.append(menu);
  function openCard(c){const title=c.title||sources.find(s=>s.id===c.plugin)?.title||'插件详情';const config=cardConfig(c);if(invoke)invoke('plugin_canvas_api',{action:'detail',payload:{plugin:c.plugin,config,title}}).catch(e=>$('#notice').textContent=String(e));else location.href='plugin-detail.html?'+new URLSearchParams({preview:previewBase,config:JSON.stringify(config),title});}
  function context(c,x,y){menu.innerHTML='<button role="menuitem" data-action="open">打开详情</button><button role="menuitem" data-action="edit">编辑组件</button><button role="menuitem" data-action="remove">移除组件</button>';cancelMenuLeave();menuCard=document.querySelector(`[data-id="${CSS.escape(c.id)}"]`);menu.hidden=false;menu.style.left=Math.max(8,Math.min(x,innerWidth-176))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-180))+'px';menu.onclick=e=>{const a=e.target.dataset.action;closeMenu();if(a==='open')openCard(c);if(a==='edit')add(c);if(a==='remove'){board().cards=board().cards.filter(i=>i.id!==c.id);commit();}};menu.querySelector('button').focus();}
  document.addEventListener('pointerdown',e=>{if(!menu.contains(e.target))closeMenu();},true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu();});
  document.addEventListener('pointermove',e=>trackMenuPosition(e.clientX,e.clientY),true);
  document.addEventListener('mousemove',e=>trackMenuPosition(e.clientX,e.clientY),true);
  document.addEventListener('pointerout',e=>{if(menu.hidden)return;if(!e.relatedTarget)closeMenu();else if(!insideMenu(e.relatedTarget))scheduleMenuLeave();},true);
  window.addEventListener('pagehide',closeMenu);
  document.documentElement.addEventListener('pointerleave',closeMenu);
  window.addEventListener('blur',closeMenu);
  // Hover, not key-window focus: transparent WKWebViews can miss pointerleave.
  let surfaceTimer=null,surfaceRevision=0,surfaceStopped=false;
  function trackSurface(x,y){
    const inside=x>=0&&y>=0&&x<innerWidth&&y<innerHeight;
    document.body.classList.toggle('surface-inactive',!inside);
    document.querySelector('header').inert=!inside;
    if(!inside)closeMenu();
  }
  document.addEventListener('pointermove',e=>{surfaceRevision++;trackSurface(e.clientX,e.clientY);},true);
  document.documentElement.addEventListener('pointerleave',()=>{surfaceRevision++;trackSurface(-1,-1);});
  async function watchSurface(){
    const revision=surfaceRevision;
    try{const p=await invoke('plugin_canvas_api',{action:'cursor',payload:{}});if(!surfaceStopped&&revision===surfaceRevision){trackSurface(p.x,p.y);trackMenuPosition(p.x,p.y);}}catch{}
    if(!surfaceStopped)surfaceTimer=setTimeout(watchSurface,150);
  }
  if(invoke)watchSurface();
  window.addEventListener('pagehide',()=>{surfaceStopped=true;clearTimeout(surfaceTimer);});
  window.addEventListener('pageshow',()=>{if(surfaceStopped&&invoke){surfaceStopped=false;watchSurface();}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)closeMenu();});
  document.addEventListener('focusin',e=>{if(!menu.hidden&&!menu.contains(e.target)&&!menuCard?.contains(e.target))closeMenu();});
  document.addEventListener('scroll',e=>{if(!menu.contains(e.target))closeMenu();},true);
  $('#canvas').oncontextmenu=e=>{const c=board().cards.find(c=>c.id===e.target.closest('.card')?.dataset.id);if(c){e.preventDefault();closeMenu();context(c,e.clientX,e.clientY);watchMenu();}};
  $('#canvas').addEventListener('keydown',e=>{const c=board().cards.find(c=>c.id===e.target.dataset.id);if(!c)return;if(e.key==='Enter'){e.preventDefault();openCard(c);}if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();const r=e.target.getBoundingClientRect();context(c,r.left+20,r.top+20);}});
  const board=()=>layout.boards.find(b=>b.id===layout.active),uid=()=>crypto.randomUUID();
  const previewBase=new URLSearchParams(location.search).get('preview');
  let editorFrame=null,cardFrames=[];
  const cardConfig=c=>c?.config||{view:c?.view,row:c?.row,metrics:c?.metrics};
  const surfaceUrl=(source,kind)=>invoke?'flowhub-plugin://'+source.id+'/'+source.widget[kind]+'?v='+Date.now():new URL(source.widget[kind],previewBase).href;
  function mountSurface(frame,source,kind,card){return FlowHubWidgetFrame.mount(frame,{url:surfaceUrl(source,kind),context:{config:cardConfig(card),title:card?.title||'',snapshot:source.snapshot,preview:!invoke},rpc:invoke?params=>invoke('plugin_widget_rpc',{id:source.id,params}):null});}
  document.body.classList.toggle('preview',!invoke);
  let saveTail=Promise.resolve();
  function save(){const snapshot=structuredClone(layout);const persist=async()=>{if(!invoke){localStorage.setItem('flowhub-canvas-preview',JSON.stringify(snapshot));return;}saving=true;try{await invoke('plugin_canvas_api',{action:'save',payload:snapshot});$('#notice').textContent='';fitSurface();}catch(e){$('#notice').textContent='保存失败：'+e;throw e;}finally{saving=false;}};saveTail=saveTail.catch(()=>{}).then(persist);return saveTail;}
  function positionCards(moving=null,wanted=null){const positions=WidgetLayout.arrange(board().cards,moving,wanted);for(const p of positions){const c=board().cards.find(c=>c.id===p.id);c.x=p.x;c.y=p.y;c.break_before=false;const n=document.querySelector(`[data-id="${CSS.escape(p.id)}"]`);if(n){n.style.left=p.x+'px';n.style.top=p.y+'px';}}const width=Math.max(320,...positions.map(p=>p.x+p.w)),height=Math.max(120,...positions.map(p=>p.y+p.h));$('#canvas').style.width=width+'px';$('#canvas').style.height=height+'px';return {width,height};}
  let fitted='';function fitSurface(){if(!invoke||gesture||document.querySelector('dialog[open]'))return;const width=Math.max(360,$('#canvas').offsetWidth+32,document.querySelector('header').scrollWidth+32),height=$('#canvas').offsetTop+$('#canvas').offsetHeight+16,key=width+':'+height;if(key===fitted)return;fitted=key;invoke('plugin_canvas_api',{action:'fit',payload:{width,height}}).catch(()=>{fitted='';});}
  function render(){
    closeMenu();
    if(layout.boards.length>1){document.querySelector('header .tools').prepend($('#boards'));$('#boards').setAttribute('aria-label','切换组件布局');}
    $('#boards').innerHTML=layout.boards.map(b=>`<option value="${esc(b.id)}">${esc(b.title)}</option>`).join('');$('#boards').value=layout.active;$('#pin').checked=layout.pinned;$('#removeBoard').disabled=layout.boards.length===1;
    for(const f of cardFrames)f.dispose();cardFrames=[];
    $('#canvas').innerHTML=board().cards.map(c=>{const source=sources.find(s=>s.id===c.plugin),title=c.title||source?.title||c.plugin;return `<article tabindex="0" aria-label="${esc(title)}，点击打开详情，右键编辑" class="card" data-id="${esc(c.id)}" style="width:${Number(c.width)||({small:184,medium:384,large:384}[c.size])}px;height:${Number(c.height)||({small:184,medium:184,large:384}[c.size])}px">${source?.widget?'<iframe class="widget-content" tabindex="-1" title="'+esc(title)+'" sandbox="allow-scripts"></iframe>':'<p class="empty">插件未启用或尚未提供组件页面 · 布局已保留</p>'}<div class="widget-hit" aria-hidden="true"></div><button class="resize-handle" aria-label="调整组件大小" title="拖动缩放；方向键微调" data-resize>⌟</button></article>`;}).join('')||'<div class="blank"><h2>把常看的信息，放在一起。</h2><p>从已安装的插件中添加组件。</p><button class="primary" data-add>＋ 添加第一个组件</button></div>';
    for(const card of board().cards){const source=sources.find(s=>s.id===card.plugin),frame=document.querySelector(`[data-id="${CSS.escape(card.id)}"] iframe`);if(frame&&source?.widget)cardFrames.push(mountSurface(frame,source,'card',card));}
    positionCards();fitSurface();
  }
  function updateEditor(card=null){editorFrame?.dispose();editorFrame=null;const source=sources.find(s=>s.id===$('#source').value);$('#widgetEditor').hidden=!source?.widget;$('#cardTitle').closest('label').hidden=!source?.widget;$('#widgetForm button[type=submit]').disabled=!source?.widget;if(source?.widget)editorFrame=mountSurface($('#widgetEditor'),source,'editor',card);else $('#widgetEditor').src='about:blank';$('#pickerError').textContent='';}
  function add(card=null){editingCard=card?.id||null;const available=sources.filter(s=>s.widget);$('#source').innerHTML='<option value="" disabled>请选择插件</option>'+available.map(s=>`<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('');if(!available.length){$('#notice').textContent='请先安装或升级提供组件页面的插件';return;}$('#source').value=card?.plugin||'';$('#cardTitle').value=card?.title||'';$('#picker h2').textContent=card?'编辑组件':'添加组件';$('#widgetForm button[type=submit]').textContent=card?'保存修改':'添加到画布';updateEditor(card);window.FlowHubSelects?.sync();$('#picker').showModal();if(invoke)invoke('plugin_canvas_api',{action:'fit',payload:{width:Math.max(innerWidth,360),height:Math.max(innerHeight,560)}}).catch(()=>{});}
  $('#picker').addEventListener('close',()=>{editorFrame?.dispose();editorFrame=null;fitted='';fitSurface();});
  const commit=()=>{render();save().catch(()=>{});};
  $('#source').onchange=()=>updateEditor();
  $('#dragSurface').onmousedown=e=>{if(e.button===0&&invoke)invoke('plugin_canvas_api',{action:'drag',payload:{}}).catch(()=>{});};
  $('#closeSurface').onclick=()=>{if(invoke)invoke('plugin_canvas_api',{action:'close',payload:{}}).catch(e=>$('#notice').textContent=String(e));};
  $('#add').onclick=()=>add();
  $('#boards').onchange=e=>{layout.active=e.target.value;commit();};$('#pin').onchange=e=>{layout.pinned=e.target.checked;commit();};
  $('#widgetForm').onsubmit=async e=>{e.preventDefault();const editor=editorFrame;if(!editor)return;const button=$('#widgetForm button[type=submit]');button.disabled=true;try{const config=await editor.save();if(editor!==editorFrame)return;if(!editingCard&&board().cards.length>=32)throw Error('每个布局最多 32 个组件');const previous=board().cards.find(c=>c.id===editingCard),next={id:editingCard||uid(),plugin:$('#source').value,title:$('#cardTitle').value.trim(),config,view:'widget',size:previous?.size||'medium'};if(previous)Object.assign(previous,next);else board().cards.push(next);$('#picker').close();commit();}catch(e){$('#pickerError').textContent=String(e.message||e);}finally{button.disabled=false;}};

  $('#newBoard').onclick=()=>{naming='new';$('#nameTitle').textContent='新建布局';$('#boardName').value='';$('#nameDialog').showModal();};$('#rename').onclick=()=>{naming='rename';$('#nameTitle').textContent='重命名布局';$('#boardName').value=board().title;$('#nameDialog').showModal();};
  $('#nameForm').onsubmit=e=>{e.preventDefault();const title=$('#boardName').value.trim();if(!title)return;if(naming==='new'){if(layout.boards.length>=12)return;const id=uid();layout.boards.push({id,title,cards:[]});layout.active=id;}else board().title=title;$('#nameDialog').close();commit();};
  $('#removeBoard').onclick=()=>$('#deleteDialog').showModal();$('#confirmDelete').onclick=()=>{if(layout.boards.length<2)return;layout.boards=layout.boards.filter(b=>b.id!==layout.active);layout.active=layout.boards[0].id;$('#deleteDialog').close();commit();};
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$('#'+b.dataset.close).close());
  $('#canvas').onclick=e=>{if(suppressClick){suppressClick=false;return;}const button=e.target.closest('button');if(button){if(button.hasAttribute('data-add'))add();return;}const c=board().cards.find(c=>c.id===e.target.closest('.card')?.dataset.id);if(c)openCard(c);};
  $('#canvas').ondragstart=e=>e.preventDefault();
  async function load(initial=false){if(saving||gesture||(!initial&&(document.querySelector('dialog[open]')||!menu.hidden)))return;try{if(invoke){const data=await invoke('plugin_canvas_api',{action:'get',payload:{}});if(initial)layout=data.layout;sources=data.sources;}else if(initial){try{layout=JSON.parse(localStorage.getItem('flowhub-canvas-preview'))||layout;}catch{}if(previewBase){sources=[await fetch(new URL('widget-preview.json',previewBase)).then(r=>{if(!r.ok)throw Error('插件预览无法加载');return r.json();})];}$('#notice').textContent=previewBase?'浏览器预览 · 插件模拟数据':'使用 ?preview=插件预览地址 加载组件';}if(!initial&&(gesture||!menu.hidden||document.querySelector('dialog[open]')))return;render();}catch(e){$('#notice').textContent=String(e);}}

  // Pointer events work in native WebViews without OS HTML drag/drop interception.
  $('#canvas').addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    const node=e.target.closest('.card'),resize=e.target.closest('[data-resize]');
    if(!node||(!resize&&e.target.closest('button,select,input')))return;
    const rect=node.getBoundingClientRect();
    gesture={node,id:node.dataset.id,resize:!!resize,x:e.clientX,y:e.clientY,width:rect.width,height:rect.height,left:node.offsetLeft,top:node.offsetTop,moved:false,target:null};
    node.setPointerCapture(e.pointerId);e.preventDefault();
  });
  $('#canvas').addEventListener('pointermove',e=>{
    if(!gesture)return;const g=gesture,dx=e.clientX-g.x,dy=e.clientY-g.y;
    if(Math.abs(dx)+Math.abs(dy)<4&&!g.moved)return;g.moved=true;
    if(g.resize){g.node.style.width=Math.round(Math.max(160,Math.min(1600,dx+g.width)))+'px';g.node.style.height=Math.round(Math.max(120,Math.min(1200,dy+g.height)))+'px';}
    else {g.node.classList.add('moving');g.wanted={x:Math.max(0,g.left+dx),y:Math.max(0,g.top+dy)};g.node.style.left=g.wanted.x+'px';g.node.style.top=g.wanted.y+'px';if(invoke&&Date.now()-(g.grown||0)>150&&(e.clientX>innerWidth-40||e.clientY>innerHeight-40)){g.grown=Date.now();fitted='';invoke('plugin_canvas_api',{action:'fit',payload:{width:innerWidth+(e.clientX>innerWidth-40?160:0),height:innerHeight+(e.clientY>innerHeight-40?140:0)}}).catch(()=>{});}}

  });
  const finish=(e,cancel=false)=>{if(!gesture)return;const g=gesture;gesture=null;if(g.node.hasPointerCapture(e.pointerId))g.node.releasePointerCapture(e.pointerId);if(!cancel&&g.moved){suppressClick=true;setTimeout(()=>suppressClick=false,100);const items=board().cards,card=items.find(c=>c.id===g.id);if(g.resize){card.width=parseInt(g.node.style.width);card.height=parseInt(g.node.style.height);}else {card.width=g.width;card.height=g.height;positionCards(card.id,g.wanted);}commit();}else if(cancel)render();};
  $('#canvas').addEventListener('pointerup',e=>finish(e));$('#canvas').addEventListener('pointercancel',e=>finish(e,true));
  $('#canvas').addEventListener('keydown',e=>{if(!e.target.matches('[data-resize]')||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const node=e.target.closest('.card'),card=board().cards.find(c=>c.id===node.dataset.id),rect=node.getBoundingClientRect();card.width=Math.max(160,Math.min(1600,(card.width||rect.width)+(e.key==='ArrowRight'?10:e.key==='ArrowLeft'?-10:0)));card.height=Math.max(160,Math.min(1200,(card.height||rect.height)+(e.key==='ArrowDown'?10:e.key==='ArrowUp'?-10:0)));commit();document.querySelector(`[data-id="${CSS.escape(card.id)}"] [data-resize]`)?.focus();});
  load(true);setInterval(()=>{if(!document.hidden)load();},15000);
})();
