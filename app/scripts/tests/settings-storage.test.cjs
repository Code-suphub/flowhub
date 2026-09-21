const {test}=require('node:test'),assert=require('node:assert/strict');const h=require('./settings-harness.test.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('save isolates submitted snapshot and prevents edits/reload/duplicate submits throughout metadata',async()=>{
 const gate=deferred();let calls=0;const {store}=await h.loaded({saveConfig:async config=>{calls++;await gate.promise;return {ok:true,config};}});
 store.edit(c=>{c.core.name='submitted';});const operation=store.save();assert.equal(store.snapshot().busy,true);
 store.edit(c=>{c.core.name='late';});store.setJson('{"late":');await store.save();await store.reset();assert.equal(calls,1);assert.equal(store.snapshot().config.core.name,'submitted');
 gate.resolve();await operation;assert.equal(store.dirty,false);assert.equal(store.snapshot().busy,false);assert.equal(localStorage.length,0);store.dispose();
});
test('opening an existing database adopts its catalog and next draft is bound to its actual origin',async()=>{
 let target=false;const config=h.fixture();config.plugins.web.settings.items=[{id:'B'}];
 const {store}=await h.loaded({saveConfig:async()=>{target=true;return {ok:true,config,storageState:{operation:'open',activePath:'/db/B'}};},getClipboardStorageInfo:async()=>({activePath:target?'/db/B':'/db/A'})});
 store.edit(c=>{c.plugins.clipboard.settings.storagePath='/db/B';});await store.save();assert.equal(store.snapshot().config.plugins.web.settings.items[0].id,'B');assert.equal(store.dirty,false);
 store.edit(c=>{c.core.name='next';});store.persist();assert.ok(localStorage.getItem(h.model.draftKey({configPath:'/config/A',storagePath:'/db/B'})));store.dispose();
});
test('metadata failure after commit preserves source recovery and blocks further writes until reset',async()=>{
 let fail=false,calls=0;const {store}=await h.loaded({saveConfig:async config=>{calls++;fail=true;return {ok:true,config};},getClipboardStorageInfo:async()=>{if(fail)throw Error('metadata offline');return {activePath:'/db/A'};}});
 store.edit(c=>{c.core.name='draft';});await store.save();assert.equal(store.snapshot().conflict,true);assert.equal(calls,1);assert.ok(localStorage.getItem(h.model.draftKey({configPath:'/config/A',storagePath:'/db/A'})));
 await assert.rejects(store.save(),/源草稿/);assert.equal(calls,1);fail=false;await store.reset();assert.equal(store.snapshot().conflict,false);assert.equal(localStorage.length,1,'reset preserves source draft');store.dispose();
});
test('failed saves and reloads preserve drafts; invalid JSON remains recoverable and never reaches adapter',async()=>{
 const {store,writes}=await h.loaded({saveConfig:async()=>{throw Error('disk full');}});
 store.edit(c=>{c.core.name='unsaved';});await assert.rejects(store.save(),/disk full/);assert.equal(store.snapshot().busy,false);assert.equal(store.dirty,true);assert.ok(localStorage.length);
 store.setJson('{"unfinished":');store.persist();await assert.rejects(store.save());assert.equal(writes.length,0);assert.equal(JSON.parse(localStorage.getItem(localStorage.key(0))).jsonText,'{"unfinished":');
 window.weborg.getConfig=async()=>{throw Error('offline');};await assert.rejects(store.reset(),/offline/);assert.equal(store.snapshot().jsonText,'{"unfinished":');assert.ok(localStorage.length);store.dispose();
});
test('same-source recovery drops old destination, preserves invalid JSON; unknown source cannot overwrite active DB',async()=>{
 const {store}=await h.loaded();const draft=h.fixture();draft.plugins.web.settings.items=[{id:'source'}];draft.plugins.clipboard.settings.storagePath='/db/B';draft.core.configPath='/config/B';
 store.patch({recovery:{origin:{configPath:'/config/A',storagePath:'/db/A'},config:draft,jsonDirty:true,jsonText:'{"unfinished":'}});
 store.recoverDraft();assert.equal(store.snapshot().config.plugins.web.settings.items[0].id,'source');assert.equal(store.snapshot().config.plugins.clipboard.settings.storagePath,'');assert.equal(store.snapshot().config.core.configPath,'');assert.equal(store.snapshot().jsonText,'{"unfinished":');
 store.patch({recovery:{origin:null,config:draft}});assert.throws(()=>store.recoverDraft(),/来源数据库/);store.dispose();
});
test('valid raw JSON recovery also drops pending source/destination switches',async()=>{
 const {store}=await h.loaded(),draft=h.fixture();draft.plugins.clipboard.settings.storagePath='/db/B';
 store.patch({recovery:{origin:{configPath:'/config/A',storagePath:'/db/A'},config:draft,jsonDirty:true,jsonText:JSON.stringify(draft)}});
 store.recoverDraft();assert.equal(JSON.parse(store.snapshot().jsonText).plugins.clipboard.settings.storagePath,'');store.dispose();
});
test('conflicted same-source recovery preserves raw JSON-only edits and rebinds only source paths',async()=>{
 const {store}=await h.loaded(),draft=h.fixture(),raw=h.fixture();raw.core.onlyInJson='keep me';raw.core.configPath='/config/B';raw.plugins.clipboard.settings.storagePath='/db/B';raw.plugins.web.settings.items=[{id:'only-in-json'}];
 store.patch({recovery:{origin:{configPath:'/config/A',storagePath:'/db/A'},config:draft,jsonDirty:true,jsonText:JSON.stringify(raw),saveConflict:{sourceOrigin:{configPath:'/config/A',storagePath:'/db/A'}}}});
 store.recoverDraft();const recovered=JSON.parse(store.snapshot().jsonText);assert.equal(recovered.core.onlyInJson,'keep me');assert.equal(recovered.plugins.web.settings.items[0].id,'only-in-json');assert.equal(recovered.core.configPath,'');assert.equal(recovered.plugins.clipboard.settings.storagePath,'');
 store.persist();const persisted=JSON.parse(localStorage.getItem(h.model.draftKey({configPath:'/config/A',storagePath:'/db/A'})));assert.equal(JSON.parse(persisted.jsonText).core.onlyInJson,'keep me');
 store.patch({recovery:{origin:{configPath:'/config/A',storagePath:'/db/A'},config:draft,jsonDirty:true,jsonText:'{"invalid":',saveConflict:{sourceOrigin:{configPath:'/config/A',storagePath:'/db/A'}}}});store.recoverDraft();store.persist();assert.equal(store.snapshot().jsonText,'{"invalid":');assert.equal(JSON.parse(localStorage.getItem(h.model.draftKey({configPath:'/config/A',storagePath:'/db/A'}))).jsonText,'{"invalid":');store.dispose();
});
test('preview cannot edit, save, persist drafts or call native mutation API',async()=>{
 const {store,writes}=await h.loaded({},true);store.edit(c=>{c.core.name='forbidden';});store.setJson('{}');await store.save();store.persist();
 assert.equal(store.dirty,false);assert.equal(writes.length,0);assert.equal(localStorage.length,0);
 await assert.rejects(require('../../src/settings/api.ts').write('sendTestNotification'),/只读/);store.dispose();
});
test('update locks editor until completion, failure restores retry, dirty drafts block installation',async()=>{
 const gate=deferred();let calls=0;const {store}=await h.loaded({downloadAndInstallUpdate:async()=>{calls++;return gate.promise;}});
 const {primaryUpdate}=require('../../src/settings/Core.tsx');const operation=primaryUpdate(store);await primaryUpdate(store);assert.equal(calls,1);assert.equal(store.snapshot().busy,true);
 store.edit(c=>{c.core.name='late';});assert.equal(store.dirty,false);gate.reject(Error('network unavailable'));await assert.rejects(operation,/network unavailable/);assert.equal(store.snapshot().busy,false);
 store.edit(c=>{c.core.name='dirty';});await assert.rejects(primaryUpdate(store),/保存/);assert.equal(calls,1);store.dispose();
});
test('clipboard limits clamp/floor finite values and recover invalid values',()=>{
 for(const key of ['retentionDays','maxRecords','maxBytes']) {assert.equal(h.model.clipboardLimit(3.9,key),3);assert.equal(h.model.clipboardLimit(-1,key),0);assert.equal(h.model.clipboardLimit('bad',key),0);assert.equal(h.model.clipboardLimit(NaN,key),0);assert.equal(h.model.clipboardLimit(Infinity,key),0);assert.equal(h.model.clipboardLimit(Number.MAX_VALUE,key),key==='retentionDays'?3650:Number.MAX_SAFE_INTEGER);}
});
test('clipboard pause/protection save boundaries and legacy recovery retain pause; failed save keeps recovery action',async()=>{
 const config=h.fixture();config.plugins.clipboard.settings={capturePaused:true,protectSensitive:false,excludedApps:['legacy']};let fail=true,submitted;
 const {store}=await h.loaded({getConfig:async()=>config,saveConfig:async c=>{submitted=c;if(fail)throw Error('save failed');return {ok:true,config:c};}});
 const {Clipboard}=require('../../src/settings/Core.tsx'),view=await h.mount(Clipboard,{store});
 assert.equal(view.container.querySelector('[aria-label="暂停采集"]').getAttribute('aria-checked'),'true');
 await h.click(h.button(view.container,'清空旧列表并保存'));assert.deepEqual(submitted.plugins.clipboard.settings.excludedApps,[]);assert.equal(submitted.plugins.clipboard.settings.capturePaused,true);assert.equal(submitted.plugins.clipboard.enabled,true);assert.ok(h.button(view.container,'清空旧列表并保存'),'saved legacy data remains until commit');
 fail=false;await h.click(h.button(view.container,'清空旧列表并保存'));assert.equal(h.button(view.container,'清空旧列表并保存'),undefined);assert.equal(store.snapshot().config.plugins.clipboard.settings.capturePaused,true);
 await h.click(view.container.querySelector('[aria-label="暂停采集"]'));assert.equal(store.snapshot().config.plugins.clipboard.settings.capturePaused,false);assert.equal(store.snapshot().saved.plugins.clipboard.settings.capturePaused,true);
 await view.unmount();store.dispose();
});
