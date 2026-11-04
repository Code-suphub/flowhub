const {test}=require('node:test'),assert=require('node:assert/strict');
const h=require('./settings-harness.test.cjs');
const {DataPanel,PathControl}=require('../../src/settings/DataPanel.tsx');
const {DraftReview}=require('../../src/settings/DraftReview.tsx');
const {ConfigChanges}=require('../../src/settings/ConfigChanges.tsx');
const {configChanges,changeValue,collectionChangeSummary,historyConfiguration}=require('../../src/settings/config-changes.ts');
const {Settings}=require('../../src/settings/index.tsx');
const dialog=()=>document.querySelector('[role=dialog]');
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>h.act(async()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))));
const entry={id:'one',created_at:1758096000000,bytes:2048,catalog_count:7};

test('comparison retains literal key paths, treats arrays atomically and summarizes catalog changes',()=>{
  const before=h.fixture(),after=h.model.clone(before);after.core.launchAtLogin=true;after.plugins.web.settings.items[0].children.push({id:'new',title:'新网页'});after.plugins.web.settings.items[1].title='改名';
  const changes=configChanges(before,after),catalog=changes.find(change=>change.path.join('.')==='plugins.web.settings.items');
  assert.equal(changes.length,2);assert.equal(changeValue(catalog.before,catalog.path),'8 个节点');assert.equal(changeValue(catalog.after,catalog.path),'9 个节点');assert.match(collectionChangeSummary(catalog),/新增 1（新网页）/);assert.match(collectionChangeSummary(catalog),/修改 1（改名）/);
  assert.deepEqual(configChanges({'a.b':1},{'a.b':2})[0].path,['a.b']);assert.deepEqual(configChanges(before,h.model.clone(before)),[]);
  assert.equal(changeValue(undefined,['core','hotkey']),'默认（Alt+Space）');assert.equal(changeValue(undefined,['plugins','memo','settings','items']),'内置命令库（默认）');
  const moved=h.model.moveNodes(before.plugins.web.settings.items,['b'],'a');assert.equal(collectionChangeSummary({path:catalog.path,before:catalog.before,after:moved}),'顺序或层级已调整');
});
test('sensitive fields never expose their contents in an ordinary review',async()=>{
  h.environment();const before={plugins:{custom:{settings:{apiKey:'old-secret',credentials:{password:'old-password'}}}}},after={plugins:{custom:{settings:{apiKey:'new-secret',credentials:{password:'new-password'}}}}};
  const view=await h.mount(ConfigChanges,{before,after});assert.match(view.container.textContent,/内容隐藏/);
  for(const value of ['old-secret','new-secret','old-password','new-password'])assert.equal(view.container.textContent.includes(value),false);
  await view.unmount();
});
test('history comparison preserves the active SQLite catalog and rejects invalid configuration envelopes',()=>{
  const current=h.fixture(),raw=h.fixture();raw.plugins.web.settings.items=[];raw.core.hotkey='F8';const original=JSON.stringify(raw),target=historyConfiguration(current,raw);
  assert.equal(target.core.hotkey,'F8');assert.deepEqual(target.plugins.web.settings.items,current.plugins.web.settings.items);assert.equal(JSON.stringify(raw),original);
  assert.throws(()=>historyConfiguration(current,{core:{}}),/core \/ plugins/);
});
test('global review crosses pages without saving and can navigate back to the changed setting group',async()=>{
  const {store,writes}=await h.loaded(),view=await h.mount(Settings,{store});
  await h.click(view.container.querySelector('[aria-label="开机自动启动"]'));await h.click(view.container.querySelector('[data-page="clipboard"]'));await h.click(view.container.querySelector('[aria-label="暂停采集"]'));
  await h.click(view.container.querySelector('[aria-label="查看未保存修改"]'));
  assert.match(dialog().textContent,/开机自动启动/);assert.match(dialog().textContent,/暂停剪贴板采集/);assert.match(dialog().textContent,/开启/);assert.equal(writes.length,0);
  await h.click(h.button(dialog(),'前往通用设置'));await flush();assert.equal(view.container.querySelector('h1').textContent,'通用设置');assert.equal(document.activeElement===view.container.querySelector('main'),true);assert.equal(store.dirty,true);assert.equal(writes.length,0);
  await h.click(view.container.querySelector('[aria-label="查看未保存修改"]'));await h.click(h.button(dialog(),'继续编辑'));await flush();assert.equal(document.activeElement===view.container.querySelector('[aria-label="查看未保存修改"]'),true);
  await view.unmount();store.dispose();
});
test('review save failures keep the draft and retry submits once while navigation is locked',async()=>{
  let fail=true,calls=0,closed=0;const wait=gate();
  const {store}=await h.loaded({saveConfig:async config=>{calls++;if(fail)throw Error('save unavailable');await wait.promise;return {ok:true,config};}});store.edit(c=>{c.core.launchAtLogin=true;});
  const view=await h.mount(DraftReview,{store,onClose:()=>closed++,onNavigate:()=>{throw Error('should stay locked');}});
  await h.click(h.button(dialog(),'保存全部修改'));assert.match(dialog().querySelector('[role=alert]').textContent,/save unavailable/);assert.equal(store.dirty,true);assert.equal(closed,0);
  fail=false;await h.click(h.button(dialog(),'保存全部修改'));assert.equal(store.snapshot().busy,true);assert.equal(h.button(dialog(),'继续编辑').disabled,true);assert.equal(h.button(dialog(),'前往通用设置').disabled,true);
  await h.click(h.button(dialog(),'正在保存…'));assert.equal(calls,2);await h.act(async()=>wait.resolve());assert.equal(store.dirty,false);assert.equal(closed,1);await view.unmount();store.dispose();
});
test('undoing or editing back to saved state clears only the current source draft and resets stale error status',async()=>{
  const {store}=await h.loaded();localStorage.setItem('foreign-source','keep');
  store.notice('old save error',true);store.edit(c=>{c.core.launchAtLogin=true;});store.persist();assert.equal(store.snapshot().error,false);assert.equal(localStorage.length,2);
  store.travel('undo');assert.equal(store.dirty,false);assert.equal(localStorage.length,1);assert.equal(localStorage.getItem('foreign-source'),'keep');assert.match(store.snapshot().notice,/已撤销/);
  store.travel('redo');store.persist();assert.equal(localStorage.length,2);store.edit(c=>{delete c.core.launchAtLogin;});assert.equal(store.dirty,false);assert.equal(localStorage.length,1);assert.match(store.snapshot().notice,/已还原为已保存配置/);store.dispose();
});
test('storage selection distinguishes active and target locations and can open the active location before saving',async()=>{
  let opens=0;const {store,writes}=await h.loaded({chooseClipboardStorage:async()=>({path:'/db/B'}),openClipboardStorage:async()=>{opens++;return {};},getClipboardStorageInfo:async()=>({activePath:'/db/A',configuredPath:'',defaultPath:'/db/default'})});
  const view=await h.mount(PathControl,{store,storage:true});await h.click(h.button(view.container,'选择位置…'));
  assert.match(view.container.textContent,/当前使用\/db\/A/);assert.equal(view.container.querySelector('[aria-label="数据目录目标位置"]').value,'/db/B');assert.match(view.container.textContent,/已有数据库/);assert.equal(writes.length,0);
  await h.click(h.button(view.container,'打开当前'));assert.equal(opens,1);await h.click(h.button(view.container,'恢复默认'));assert.equal(store.dirty,false);assert.equal(view.container.querySelector('[aria-label="数据目录目标位置"]'),null);
  await view.unmount();store.dispose();
});
test('a late directory chooser cannot overwrite a newer draft',async()=>{
  const wait=gate(),{store}=await h.loaded({chooseConfigPath:()=>wait.promise}),view=await h.mount(PathControl,{store});await h.click(h.button(view.container,'选择位置…'));assert.equal(h.button(view.container,'正在选择…').disabled,true);
  await h.act(async()=>store.edit(c=>{c.core.launchAtLogin=true;}));await h.act(async()=>wait.resolve({path:'/late/config.json'}));assert.match(view.container.textContent,/配置已改变/);assert.equal(store.snapshot().config.core.configPath,undefined);await view.unmount();store.dispose();
});
test('history requests show loading, reject stale restore plans, retry and never reopen after cancellation',async()=>{
  const wait=gate();let reads=0,restores=0;const {store}=await h.loaded({listConfigHistory:async()=>({entries:[entry]}),previewConfigHistory:async()=>{reads++;if(reads===1)return wait.promise;const config=h.fixture();config.core.hotkey='F8';return {config};},restoreConfigHistory:async()=>{restores++;return {ok:true};}}),view=await h.mount(DataPanel,{store});
  await h.click(h.button(view.container,'查看差异'));assert.match(dialog().textContent,/正在读取/);await h.click(h.button(dialog(),'取消'));await h.act(async()=>wait.resolve({config:h.fixture()}));assert.equal(dialog(),null);
  await h.click(h.button(view.container,'恢复'));assert.match(dialog().textContent,/F8/);assert.equal(restores,0);await h.act(async()=>store.edit(c=>{c.core.launchAtLogin=true;}));await h.click(h.button(dialog(),'确认恢复'));assert.match(dialog().querySelector('[role=alert]').textContent,/当前草稿已变化/);assert.equal(restores,0);
  await h.click(h.button(dialog(),'重新读取差异'));assert.equal(h.button(dialog(),'确认恢复').disabled,false);await h.click(h.button(dialog(),'确认恢复'));assert.equal(restores,1);assert.equal(dialog(),null);await view.unmount();store.dispose();
});
test('invalid history and changed import drafts cannot be committed',async()=>{
  let restores=0;const {store,writes}=await h.loaded({listConfigHistory:async()=>({entries:[entry]}),previewConfigHistory:async()=>({config:{core:{}}}),restoreConfigHistory:async()=>{restores++;},pickConfigImport:async()=>({path:'/fixture.json',scope:'core',config:{core:{hotkey:'F8'}}})}),view=await h.mount(DataPanel,{store});
  await h.click(h.button(view.container,'恢复'));assert.match(dialog().querySelector('[role=alert]').textContent,/core \/ plugins/);assert.equal(h.button(dialog(),'确认恢复').disabled,true);await h.click(h.button(dialog(),'取消'));
  await h.click(h.button(view.container,'导入配置…'));assert.match(dialog().textContent,/F8/);await h.act(async()=>store.edit(c=>{c.core.launchAtLogin=true;}));await h.click(h.button(dialog(),'应用为草稿'));assert.match(dialog().querySelector('[role=alert]').textContent,/草稿已变化/);assert.equal(store.snapshot().config.core.hotkey,'Alt+Space');assert.equal(restores,0);assert.equal(writes.length,0);await h.click(h.button(dialog(),'取消'));await view.unmount();store.dispose();
});
test('read-only history can be compared but storage, import, restore and diagnostics cannot write',async()=>{
  let mutations=0;const {store,writes}=await h.loaded({listConfigHistory:async()=>({entries:[entry]}),chooseConfigPath:async()=>{mutations++;},setDiagnosticsEnabled:async()=>{mutations++;}},true),view=await h.mount(DataPanel,{store});
  assert.equal(h.button(view.container,'选择位置…').disabled,true);assert.equal(h.button(view.container,'导入配置…').disabled,true);assert.equal(view.container.querySelector('[aria-label="性能采样"]').getAttribute('aria-disabled'),'true');
  await h.click(h.button(view.container,'查看差异'));assert.match(dialog().textContent,/没有配置差异/);assert.equal(h.button(dialog(),'恢复此版本…').disabled,true);assert.equal(mutations,0);assert.equal(writes.length,0);await h.click(h.button(dialog(),'取消'));await view.unmount();store.dispose();
});
test('initial history failures remain visible and can be refreshed without being mistaken for an empty history',async()=>{
  let fail=true;const {store}=await h.loaded({listConfigHistory:async()=>{if(fail)throw Error('history offline');return {entries:[entry]};}}),view=await h.mount(DataPanel,{store});
  assert.equal(view.container.querySelector('[role=alert]').textContent,'history offline');await h.act(async()=>store.refreshHistory());assert.equal(view.container.querySelector('[role=alert]').textContent,'history offline');fail=false;await h.click(h.button(view.container,'刷新历史'));assert.equal(view.container.querySelector('[role=alert]'),null);assert.ok(h.button(view.container,'查看差异'));await view.unmount();store.dispose();
});
