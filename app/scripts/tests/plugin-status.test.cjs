const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const bundle=fs.readFileSync(require('node:path').join(__dirname,'../../ui/react/host.js'),'utf8');
const settle=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.ok(predicate(),'React state did not settle');};
function setup(invoke,root='plugin-status-root',options={}){
  const dom=new JSDOM(`<div id="${root}"></div>`,{url:options.url||'http://localhost/?id=machines',runScripts:'outside-only',pretendToBeVisual:true});
  const intervals=[];dom.window.setInterval=(callback,ms)=>{intervals.push({callback,ms});return intervals.length;};dom.window.clearInterval=()=>{};
  if(options.now)dom.window.Date.now=()=>options.now;
  if(invoke)dom.window.__TAURI__={core:{invoke}};
  dom.window.eval(bundle);
  return {dom,w:dom.window,intervals,button:label=>[...dom.window.document.querySelectorAll('button')].find(x=>x.textContent===label)};
}
test('React status saves zero or multiple favorites and does not submit twice',async t=>{
  for(const favorites of [[],['a','b']]){
    const calls=[];let finish;
    const data={preferences:{tray:true,pinned:true,favorites:[]},snapshot:{rows:[{id:'a',name:'A',status:'healthy'},{id:'b',name:'B',status:'unknown'}]}};
    const {dom,w,button}=setup(async(command,args)=>{calls.push(args);if(args.action==='save')return new Promise(resolve=>{finish=()=>resolve({...data,preferences:args.payload});});return data;});t.after(()=>dom.window.close());
    await settle(()=>w.document.querySelectorAll('.fh-status-favorites [role=checkbox]').length===2);
    assert.equal(w.document.querySelector('label[for="favorite-a"]')?.textContent,'A');
    await settle(()=>w.document.body.textContent.includes('后台采集未开启') && w.document.querySelector('[aria-label="窗口始终置顶"]')?.getAttribute('aria-checked')==='true');
    assert.equal(w.document.querySelectorAll('.fh-status-summary [data-slot=badge]').length,4);
    assert.equal(w.document.querySelectorAll('.fh-status-row [data-slot=badge]').length,2);
    for(const [index,id] of ['a','b'].entries())if(favorites.includes(id)){
      w.document.querySelectorAll('.fh-status-favorites [role=checkbox]')[index].click();
      await settle(()=>w.document.querySelectorAll('.fh-status-favorites [role=checkbox]')[index].getAttribute('aria-checked')==='true');
    }
    button('保存设置').click();button('保存设置')?.click();await settle(()=>finish);
    const saved=calls.filter(c=>c.action==='save');assert.equal(saved.length,1);assert.deepEqual(Array.from(saved[0].payload.favorites),favorites);assert.equal(saved[0].payload.pinned,true);
    finish();await settle(()=>w.document.body.textContent.includes('显示设置已保存') && !button('保存设置').disabled);
  }
});
test('status preview is readonly; backend failures remain visible',async t=>{
  const preview=setup();t.after(()=>preview.dom.window.close());await settle(()=>preview.button('打开插件 ↗'));
  assert.equal(preview.button('打开插件 ↗').disabled,true);assert.equal(preview.w.document.querySelector('details'),null);
  const failure=setup(async()=>{throw Error('读取失败');});t.after(()=>failure.dom.window.close());await settle(()=>failure.w.document.body.textContent.includes('读取失败'));
});
test('menu-bar actions are locked until native state is available and rechecked after changing',async t=>{
  let hidden=false;const calls=[];
  const {dom,w}=setup(async(command,args)=>{calls.push(command);if(command==='set_menu_bar_item_hidden'){hidden=args.hidden;return {ok:true};}return {ok:true,trusted:true,organizerEnabled:true,items:[{windowId:1,displayName:'测试图标',hideable:true,section:hidden?'alwaysHidden':'visible'}]};},'menu-bar-root');t.after(()=>dom.window.close());
  await settle(()=>w.document.querySelector('[role=switch]')&&!w.document.querySelector('[role=switch]').disabled);
  const control=w.document.querySelector('[role=switch]');control.click();control.click();
  await settle(()=>control.getAttribute('aria-checked')==='false'&&!control.disabled);
  assert.equal(calls.filter(c=>c==='set_menu_bar_item_hidden').length,1);assert.equal(calls.filter(c=>c==='list_menu_bar_items').length,2);
});
test('detail surface binds native RPC to the host-provided plugin and preserves sandbox',async t=>{
  const calls=[],dom=new JSDOM('<div id="plugin-detail-root"></div>',{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
  let mount;
  dom.window.FlowHubWidgetFrame={mount:(frame,options)=>{mount={frame,options};return {dispose(){}};}};
  dom.window.__TAURI__={core:{invoke:async(command,args)=>{calls.push({command,args});if(command==='plugin_canvas_api')return {plugin:'bound-plugin',url:'flowhub-plugin://bound-plugin/detail.html',context:{title:'详情'}};return {ok:true};}}};
  dom.window.eval(bundle);await settle(()=>mount);
  assert.equal(mount.frame.getAttribute('sandbox'),'allow-scripts');assert.equal(mount.options.context.title,'详情');
  await mount.options.rpc({action:'get',id:'foreign-plugin'});
  assert.equal(calls[1].command,'plugin_widget_rpc');assert.equal(calls[1].args.id,'bound-plugin');
});
test('status poll started before save cannot replace saved preferences with stale data',async t=>{
  let reads=0,finishPoll;
  const original={preferences:{tray:false,pinned:false,favorites:[]},snapshot:{rows:[]}};
  const {dom,w,button}=setup(async(command,args)=>{
    if(args.action==='get'){reads++;if(reads===1)return original;return new Promise(resolve=>{finishPoll=()=>resolve(original);});}
    if(args.action==='save')return {...original,preferences:args.payload};
  });t.after(()=>dom.window.close());
  await settle(()=>w.document.body.textContent.includes('后台采集未开启，显示已有缓存'));
  w.document.dispatchEvent(new w.Event('visibilitychange'));await settle(()=>finishPoll);
  w.document.querySelector('[aria-label="窗口始终置顶"]').click();
  await settle(()=>w.document.querySelector('[aria-label="窗口始终置顶"]').getAttribute('aria-checked')==='true');button('保存设置').click();
  await settle(()=>w.document.body.textContent.includes('显示设置已保存'));finishPoll();await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(w.document.querySelector('[aria-label="窗口始终置顶"]').getAttribute('aria-checked'),'true');
});

const rowIds=w=>[...w.document.querySelectorAll('.fh-status-row')].map(row=>row.dataset.rowId);
const summaryButton=(w,label)=>[...w.document.querySelectorAll('.fh-status-summary button')].find(button=>button.textContent.startsWith(label+' '));
const scopeButton=(w,label)=>[...w.document.querySelectorAll('.fh-status-scopes button')].find(button=>button.textContent===label);
test('demo overview summarizes all states, limits to five and provides scopes and toggleable filters',async t=>{
  const {dom,w,button}=setup(undefined,'plugin-status-root',{url:'http://localhost/plugin-status.html?preview=demo'});t.after(()=>dom.window.close());
  await settle(()=>rowIds(w).length===5);
  assert.deepEqual(rowIds(w),['gateway','worker','archive','new-node','database']);
  assert.equal(summaryButton(w,'正常').textContent,'正常 4');
  assert.equal(summaryButton(w,'异常').textContent,'异常 2');
  assert.equal(summaryButton(w,'过期').textContent,'过期 1');
  assert.equal(summaryButton(w,'未采集').textContent,'未采集 1');
  assert.match(w.document.body.textContent,/演示数据.*只读预览/);
  assert.equal(button('打开插件 ↗').disabled,true);assert.equal(button('保存设置').disabled,true);assert.equal(button('打开菜单栏下拉').disabled,true);
  summaryButton(w,'正常').click();await settle(()=>rowIds(w).length===4);
  assert.equal(summaryButton(w,'正常').getAttribute('aria-pressed'),'true');
  assert.equal(summaryButton(w,'异常').textContent,'异常 2');
  button('查看全部 8 台').click();await settle(()=>rowIds(w).length===8);
  assert.equal(scopeButton(w,'全部').getAttribute('aria-pressed'),'true');
  assert.equal(summaryButton(w,'全部状态').getAttribute('aria-pressed'),'true');
  scopeButton(w,'关注').click();await settle(()=>rowIds(w).length===2);
  assert.deepEqual(rowIds(w),['database','backup']);assert.equal(summaryButton(w,'正常').textContent,'正常 2');
  summaryButton(w,'异常').click();await settle(()=>w.document.body.textContent.includes('当前筛选无结果'));
  summaryButton(w,'异常').click();await settle(()=>rowIds(w).length===2);
});

test('overview fills healthy machines and unknown status never becomes healthy from its metrics',async t=>{
  const data={preferences:{tray:false,pinned:false,favorites:['b']},snapshot:{monitoring:true,rows:[
    {id:'a',name:'普通机器',status:'healthy',values:{}},
    {id:'b',name:'关注机器',status:'healthy'},
    {id:'c',name:'未知状态',status:'unexpected',values:{cpu:0}},
  ]}};
  const {dom,w}=setup(async()=>data);t.after(()=>dom.window.close());await settle(()=>rowIds(w).length===3);
  assert.deepEqual(rowIds(w),['c','b','a']);
  assert.equal(summaryButton(w,'正常').textContent,'正常 2');assert.equal(summaryButton(w,'未采集').textContent,'未采集 1');
  assert.match(w.document.querySelector('[data-row-id=c]').textContent,/未采集.*CPU 0.0%/);
  assert.match(w.document.querySelector('[data-row-id=a] .fh-status-key-metric').textContent,/—/);
});

test('row expansion exposes complete metrics and timestamps without turning missing or invalid data into zero',async t=>{
  const now=1700000000000;
  const data={preferences:{tray:false,pinned:false,favorites:[]},snapshot:{rows:[
    {id:'a',name:'有限数据',status:'healthy',at:now-125000,values:{memory:12.5,disk:Infinity}},
    {id:'b',name:'未来时间',status:'stale',at:now+60000,values:{cpu:NaN}},
    {id:'c',name:'无效时间',status:'unknown',at:1e40},
  ]}};
  const {dom,w}=setup(async()=>data,'plugin-status-root',{now});t.after(()=>dom.window.close());await settle(()=>rowIds(w).length===3);
  const row=w.document.querySelector('[data-row-id=a]'),toggle=row.querySelector('button');
  assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(w.document.getElementById(toggle.getAttribute('aria-controls')).hidden,true);
  assert.equal(row.querySelector('.fh-status-key-metric').textContent,'内存 12.5%');
  assert.equal(row.querySelector('.fh-status-age').textContent,'更新于 2 分钟前');
  toggle.click();await settle(()=>toggle.getAttribute('aria-expanded')==='true');
  assert.deepEqual([...row.querySelectorAll('dd')].map(node=>node.textContent),['—','12.5%','—']);
  assert.equal(row.querySelector('time').dateTime,new Date(now-125000).toISOString());
  assert.equal(w.document.querySelector('[data-row-id=b] .fh-status-age').textContent,'采集时间在未来');
  assert.equal(w.document.querySelector('[data-row-id=c] .fh-status-age').textContent,'尚无有效采集时间');
});

test('polls preserve row order, expanded DOM and focus while appending and removing machine IDs',async t=>{
  let state={preferences:{tray:false,pinned:false,favorites:[]},snapshot:{monitoring:true,rows:[
    {id:'a',name:'A',status:'error'}, {id:'b',name:'B',status:'healthy'}, {id:'c',name:'C',status:'healthy'},
  ]}};
  const {dom,w,intervals}=setup(async()=>structuredClone(state));t.after(()=>dom.window.close());await settle(()=>rowIds(w).length===3);
  const row=w.document.querySelector('[data-row-id=b]'),toggle=row.querySelector('button');toggle.click();toggle.focus();
  await settle(()=>toggle.getAttribute('aria-expanded')==='true');
  state.snapshot.rows=[{id:'c',name:'C',status:'error'},{id:'d',name:'D',status:'error'},{id:'b',name:'B',status:'stale'},{id:'a',name:'A',status:'healthy'}];
  intervals.find(timer=>timer.ms===15000).callback();await settle(()=>rowIds(w).length===4);
  assert.deepEqual(rowIds(w),['a','b','c','d']);
  assert.equal(w.document.querySelector('[data-row-id=b]'),row);assert.equal(w.document.activeElement,toggle);assert.equal(toggle.getAttribute('aria-expanded'),'true');
  state.snapshot.rows=state.snapshot.rows.filter(row=>row.id!=='a');intervals[0].callback();await settle(()=>rowIds(w).length===3);
  assert.deepEqual(rowIds(w),['b','c','d']);assert.equal(w.document.activeElement,toggle);
  scopeButton(w,'全部').click();await settle(()=>scopeButton(w,'全部').getAttribute('aria-pressed')==='true');
  assert.deepEqual(rowIds(w),['c','d','b']);
  state.snapshot.rows=state.snapshot.rows.filter(row=>row.id!=='b');intervals[0].callback();await settle(()=>rowIds(w).length===2);
  state.snapshot.rows.push({id:'b',name:'重新接入的 B',status:'healthy'});intervals[0].callback();await settle(()=>rowIds(w).length===3);
  assert.equal(w.document.querySelector('[data-row-id=b] button').getAttribute('aria-expanded'),'false');
});

test('empty machines, empty favorites, unmatched filters, waiting and failed reads have distinct messages',async t=>{
  const base={preferences:{tray:false,pinned:false,favorites:[]},snapshot:{rows:[]}};
  const empty=setup(async()=>base);t.after(()=>empty.dom.window.close());await settle(()=>empty.w.document.body.textContent.includes('暂无机器'));
  const waiting=setup(async()=>({preferences:base.preferences}));t.after(()=>waiting.dom.window.close());await settle(()=>waiting.w.document.body.textContent.includes('等待插件状态'));
  assert.equal(waiting.w.document.querySelector('.fh-status-empty'),null);
  const normal=setup(async()=>({...base,snapshot:{rows:[{id:'a',name:'A',status:'healthy'}]}}));t.after(()=>normal.dom.window.close());await settle(()=>rowIds(normal.w).length===1);
  scopeButton(normal.w,'关注').click();await settle(()=>normal.w.document.body.textContent.includes('尚未关注机器'));
  scopeButton(normal.w,'全部').click();await settle(()=>rowIds(normal.w).length===1);
  summaryButton(normal.w,'异常').click();await settle(()=>normal.w.document.body.textContent.includes('当前筛选无结果'));
  let fail=false;
  const cached=setup(async()=>{if(fail)throw Error('service unavailable');return {...base,snapshot:{monitoring:false,rows:[{id:'s',name:'旧缓存',status:'stale'}]}};});t.after(()=>cached.dom.window.close());await settle(()=>rowIds(cached.w).length===1);
  fail=true;cached.intervals[0].callback();await settle(()=>cached.w.document.body.textContent.includes('继续显示上次缓存'));
  assert.match(cached.w.document.body.textContent,/后台采集未开启/);assert.equal(summaryButton(cached.w,'过期').textContent,'过期 1');
  fail=false;cached.intervals[0].callback();await settle(()=>!cached.w.document.querySelector('[role=alert]'));
});

test('dirty preferences survive a poll and native status ignores the browser demo flag',async t=>{
  const calls=[],data={preferences:{tray:false,pinned:false,favorites:[]},snapshot:{title:'真实机器',rows:[{id:'a',name:'A',status:'healthy'}]}};
  const {dom,w,intervals,button}=setup(async(command,args)=>{calls.push(args);return structuredClone(data);},'plugin-status-root',{url:'http://localhost/plugin-status.html?id=machines&preview=demo'});t.after(()=>dom.window.close());
  await settle(()=>rowIds(w).length===1);assert.equal(w.document.querySelector('h1').textContent,'真实机器');assert.doesNotMatch(w.document.body.textContent,/演示数据/);
  w.document.querySelector('[aria-label="窗口始终置顶"]').click();await settle(()=>w.document.querySelector('[aria-label="窗口始终置顶"]').getAttribute('aria-checked')==='true');
  intervals[0].callback();await settle(()=>calls.filter(call=>call.action==='get').length===2);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(w.document.querySelector('[aria-label="窗口始终置顶"]').getAttribute('aria-checked'),'true');
  assert.equal(button('保存设置').disabled,false);
});
