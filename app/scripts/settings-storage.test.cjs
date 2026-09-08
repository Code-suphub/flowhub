const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../ui/settings.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b}); return {promise,resolve,reject}; };
const draftKey = (file, storage = 'default') => `flowhub:settings-draft:v2:${JSON.stringify([file, storage])}`;
const config = label => ({core:{configPath:label}, plugins:{web:{settings:{items:[{id:label}]}}}});
function harness(mode = 'structure') {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {value:'', dataset:{}, classList:{add(){},remove(){},toggle(){}}, setAttribute(){},addEventListener(){}});
    return nodes.get(id);
  };
  const listeners = {}, timers = new Map(), storage = new Map();
  let timerId=0, calls=0, submitted;
  const saving=deferred(), metadata=deferred(), loading=deferred();
  const ctx=vm.createContext({console, URL, URLSearchParams, Set, Map, Date, JSON,
    setTimeout: fn => {timers.set(++timerId,fn); return timerId}, clearTimeout: id => timers.delete(id),
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    document:{querySelector:s=>s==='.settings-actionbar'?null:element(s),querySelectorAll:()=>[],addEventListener:(n,f)=>(listeners[n] ||= []).push(f)},
    window:{location:{search:''},addEventListener(){},confirm:()=>true,flowhubPerformance:{measure:(_,fn)=>fn()},weborg:{
      saveConfig: c=>{calls++;submitted=c;return saving.promise}, listPlugins:()=>metadata.promise,
      getClipboardStorageInfo:async()=>({}),getConfigPathInfo:async()=>({activePath:'B'}),getConfig:()=>loading.promise,
      closeSettings:async()=>{}, getUpdateState:async()=>({}), getDiagnosticsState:async()=>({}), getMenuBarManagementState:async()=>({}),
    }}
  });
  vm.runInContext(source.slice(0,source.lastIndexOf('\nPromise.all([window.weborg.listPlugins()')),ctx);
  vm.runInContext(`normalizeConfig = value => value; render = () => { syncJson(); }; renderUpdateNotice = () => {}; renderMemoSettings = () => {};`,ctx);
  const state=vm.runInContext('state',ctx);
  Object.assign(state,{mode,config:config('A'),savedConfig:config('baseline'),configFile:{activePath:'A'},dirty:true});
  element('#jsonEditor').value=JSON.stringify(state.config);
  const input=(target)=>listeners.input.forEach(fn=>fn({target}));
  const edit=value=>input({dataset:{coreField:'name'},type:'text',value});
  const json=text=>{element('#jsonEditor').value=text; input({id:'jsonEditor'})};
  return {ctx,state,saving,metadata,loading,storage,edit,json,element,
    configInput: input,
    change:target=>listeners.change.forEach(fn=>fn({target})),
    initialize:()=>vm.runInContext(source.slice(source.lastIndexOf('\nPromise.all([window.weborg.listPlugins()')),ctx), calls:()=>calls,submitted:()=>submitted,
    flush(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn())},
    commit(c=config('A'),operation='save'){saving.resolve({ok:true,config:c,storageState:{operation}})},
    async tick(){await new Promise(resolve=>setImmediate(resolve))},
  };
}
(async()=>{
  {
    const h=harness(); h.state.config.plugins.clipboard={enabled:true,settings:{}};
    h.configInput({dataset:{configField:'clipboardCapturePaused'},value:'true'});
    h.configInput({dataset:{configField:'clipboardProtectSensitive'},value:'false'});
    h.configInput({dataset:{configField:'clipboardExcludedApps'},value:'com.example.secret'});
    assert.deepEqual(clone(h.state.config.plugins.clipboard),{enabled:true,settings:{capturePaused:true,protectSensitive:false}},'removed editor cannot create an exclusion');
    assert(h.element('#clipboardStatusValue').textContent.includes('待保存：暂停采集'));
    const p=h.ctx.save();
    assert.equal(h.submitted().plugins.clipboard.settings.capturePaused,true);
    h.commit(clone(h.submitted())); h.metadata.resolve([]); await p;
    h.configInput({dataset:{configField:'clipboardCapturePaused'},value:'false'});
    assert(h.element('#clipboardStatusValue').textContent.includes('允许采集'));
    assert.equal(h.state.config.plugins.clipboard.enabled,true,'pause never disables history search');
    assert.equal(h.element('#clipboardLegacyExclusions').hidden,true);
    console.log('PASS: pause/resume preserves history, unsupported exclusion has no editor');
  }
  for (const mode of ['structure','json']) {
    const h=harness(mode);
    h.state.config.plugins.clipboard={enabled:true,settings:{capturePaused:true,excludedApps:['legacy.app']}};
    h.state.savedConfig=clone(h.state.config);
    h.element('#jsonEditor').value=JSON.stringify(h.state.config);
    h.ctx.renderClipboardSummary();
    assert.equal(h.element('#clipboardLegacyExclusions').hidden,false);
    const p=h.ctx.clearClipboardExclusions();
    assert.deepEqual(clone(h.submitted().plugins.clipboard.settings),{capturePaused:true,excludedApps:[]});
    await h.ctx.clearClipboardExclusions();assert.equal(h.calls(),1);
    h.commit(clone(h.submitted()));h.metadata.resolve([]);await p;
    h.ctx.renderClipboardSummary();
    assert.equal(h.element('#clipboardLegacyExclusions').hidden,true);
    assert.equal(h.state.config.plugins.clipboard.settings.capturePaused,true,'recovery never resumes an explicit pause');
  }
  {
    const h=harness();h.state.config.plugins.clipboard={settings:{excludedApps:['legacy.app']}};
    h.state.savedConfig=clone(h.state.config);
    const p=h.ctx.clearClipboardExclusions();h.saving.reject(Error('save failed'));await p;
    h.ctx.renderClipboardSummary();
    assert.equal(h.element('#clipboardLegacyExclusions').hidden,false,'failed save retains recovery notice');
    assert.deepEqual(h.state.savedConfig.plugins.clipboard.settings.excludedApps,['legacy.app']);
    h.state.saveConflict={draftKey:'source'};await h.ctx.clearClipboardExclusions();assert.equal(h.calls(),1);
    for(const value of [[null],123,['legacy.app']]) {
      h.state.config.plugins.clipboard.settings.excludedApps=value;
      assert(h.ctx.hasLegacyClipboardExclusions(h.state.config));
    }
    console.log('PASS: legacy exclusion recovery saves in structure/JSON mode, preserves pause, guards concurrent/conflicting saves and keeps failure notice');
  }
  for(const mode of ['structure','json']) {
    const h=harness(mode);const p=h.ctx.save();
    await h.ctx.save(); assert.equal(h.calls(),1);
    assert.equal(h.element('#saveBtn').disabled,true);
    await h.ctx.reload();assert.equal(h.state.reloading,false,'reload is blocked during save');
    if(mode==='json') h.json('{"unfinished":'); else h.edit('during-save');
    assert.equal(h.submitted().core.name,undefined,'submission snapshot is isolated');
    h.commit();await h.tick();
    await h.ctx.save(); assert.equal(h.calls(),1,'metadata phase also deduplicated');
    if(mode==='structure') h.edit('during-metadata');
    h.flush();assert.ok(h.storage.size,'timer retains draft');
    h.metadata.resolve([]);await p;
    assert.equal(h.state.dirty,true);assert.equal(h.state.saving,false);
    const draft=JSON.parse([...h.storage.values()][0]);
    if(mode==='json') {assert.equal(h.element('#jsonEditor').value,'{"unfinished":');assert.equal(draft.jsonText,'{"unfinished":');}
    else {assert.equal(h.state.config.core.name,'during-metadata');assert.equal(draft.config.core.name,'during-metadata');}
    assert.equal(h.state.savedConfig.core.name,undefined);
  }
  for(const mode of ['structure','json']) {
    const h=harness(mode);const p=h.ctx.save(); h.commit(config('B'),'open');h.metadata.resolve([]); await p;
    assert.deepEqual(clone(h.state.config),config('B'));assert.equal(h.state.dirty,false);assert.equal(h.storage.size,0);
    h.edit('after');h.flush();assert.equal(h.state.dirty,true);assert.ok(h.storage.has(draftKey('B')));
  }
  for(const mode of ['structure','json']) {
    const h=harness(mode);const p=h.ctx.save();
    if(mode==='json') h.json(JSON.stringify(config('new-json')));else h.edit('new-source');
    h.commit(config('B'),'open');h.metadata.resolve([]);await p;
    assert.equal(h.state.dirty,true);assert.ok(h.state.saveConflict);
    await h.ctx.save();assert.equal(h.calls(),1,'source cannot overwrite B');
    h.flush();assert.ok(h.storage.has(draftKey('A')));assert.equal(h.storage.has(draftKey('B')),false);
    const reload=h.ctx.reload();h.loading.resolve(config('B'));await reload;
    assert.deepEqual(clone(h.state.config),config('B'));assert.equal(h.state.dirty,false);
    assert.ok(h.storage.has(draftKey('A')),'reset to B preserves source recovery');
  }
  for(const mode of ['structure','json']) {
    const h=harness(mode);const p=h.ctx.save();
    if(mode==='json')h.json('{bad');else h.edit('retained');
    h.saving.reject(new Error('disk full'));await p;
    assert.equal(h.state.dirty,true);assert.equal(h.state.saving,false);assert.ok(h.storage.size);
    assert.deepEqual(clone(h.state.savedConfig),config('baseline'));
  }
  {
    const h=harness();const p=h.ctx.save();h.commit();h.metadata.reject(new Error('metadata unavailable'));await p;
    assert.deepEqual(clone(h.state.savedConfig),config('A'));
    assert.equal(h.state.dirty,false,'metadata error does not undo committed config');
  }
  {
    const h=harness();const p=h.ctx.reload();h.edit('reload-race');h.metadata.resolve([]);h.loading.resolve(config('B'));await p;
    assert.equal(h.state.config.core.name,'reload-race');assert.equal(h.state.dirty,true);assert.ok(h.storage.size);
  }
  {
    const h=harness();h.edit('close-race');await h.ctx.closeSettings();assert.ok(h.storage.size,'close synchronously flushes draft');
  }
  {
    const h=harness();h.ctx.window.weborg.getConfigPathInfo=async()=>{throw new Error('path unavailable')};
    const p=h.ctx.save();h.commit(config('B'),'open');h.metadata.resolve([]);await p;
    assert.ok(h.state.saveConflict);await h.ctx.save();assert.equal(h.calls(),1);
    assert.ok(h.storage.has(draftKey('A')));
  }
  {
    const h=harness();const p=h.ctx.reload();h.loading.reject(new Error('reload failed'));h.metadata.resolve([]);await p;
    assert.equal(h.state.dirty,true);assert.ok(h.storage.size);assert.equal(h.state.reloading,false);
  }
  for (const text of ['', '{invalid']) {
    const h=harness('json');h.json(text);h.state.mode='structure';h.flush();
    const draft=[...h.storage.values()][0];
    const recovered=harness();recovered.storage.set(draftKey('A'),draft);
    recovered.ctx.window.weborg.getConfigPathInfo=async()=>({activePath:'A'});
    const init=recovered.initialize();recovered.metadata.resolve([]);recovered.loading.resolve(config('A'));await init;
    assert.equal(recovered.state.mode,'json');assert.equal(recovered.element('#jsonEditor').value,text);
    assert.equal(recovered.state.dirty,true);
  }
  {
    const h=harness();const init=h.initialize();h.metadata.resolve([]);h.loading.resolve(config('A'));await init;
    assert.deepEqual(clone(h.state.config),config('A'),'startup without draft works');
  }
  {
    const h=harness('json');h.json('{invalid');await h.ctx.save();
    assert.equal(h.calls(),0);assert.equal(h.state.dirty,true);assert.equal(h.state.saving,false);
    assert.ok(h.storage.size,'invalid JSON is still recoverable');
  }
  {
    const h=harness();const p=h.ctx.save();h.edit('rejected');h.saving.resolve({ok:false,reason:'rejected'});await p;
    assert.equal(h.state.dirty,true);assert.equal(h.element('#saveBtn').disabled,false);
    assert.equal(h.state.config.core.name,'rejected');
  }
  {
    const h=harness();const p=h.ctx.save();h.commit();h.metadata.resolve([]);await p;
    h.edit('next-save');await h.ctx.save();assert.equal(h.calls(),2,'new submission allowed after completion');
    assert.equal(h.submitted().core.name,'next-save');
  }
  {
    const h=harness();const picker=deferred();h.ctx.window.weborg.chooseConfigPath=()=>picker.promise;
    const choosing=h.ctx.chooseConfigPath();const reload=h.ctx.reload();h.loading.resolve(config('B'));h.metadata.resolve([]);await reload;
    picker.resolve({ok:true,path:'stale-choice'});await choosing;
    assert.equal(h.state.config.core.configPath,'B','late picker cannot modify replacement config');
  }
  {
    const h=harness();h.state.config.plugins.memo={settings:{items:[{id:'memo',category:' A / B '}]}};
    h.state.selectedMemoId='memo';
    h.ctx.window.FlowHubMemoCatalog={categorySegments:()=>['A','B']};
    const p=h.ctx.save();h.change({dataset:{memoField:'category'}});
    h.commit();h.metadata.resolve([]);await p;
    assert.equal(h.state.config.plugins.memo.settings.items[0].category,'A / B');
    assert.equal(h.state.dirty,true,'change-only category normalization increments revision');
  }
  const commonFile = '/profile/config.json';
  const dbConfig = (db, item = db) => ({core:{configPath:commonFile},plugins:{
    clipboard:{settings:{storagePath:db}},web:{settings:{items:[{id:item}]}}
  }});
  async function reopen(db, stored, mode = 'structure') {
    const h=harness(mode);
    Object.assign(h.state,{dirty:false,jsonDirty:false});
    for (const [key,value] of stored) h.storage.set(key,value);
    h.ctx.window.weborg.getConfigPathInfo=async()=>({activePath:commonFile});
    h.ctx.window.weborg.getClipboardStorageInfo=async()=>({activePath:db,resolvedPath:db});
    h.ctx.window.weborg.getConfig=async()=>dbConfig(db);
    h.metadata.resolve([]);
    await h.initialize();
    return h;
  }
  for (const mode of ['structure','json']) {
    const h=await reopen('/A',[],mode);
    h.state.mode=mode;
    h.ctx.window.weborg.chooseClipboardStorage=async()=>({ok:true,path:'/B'});
    await h.ctx.chooseClipboardStorage();
    assert.equal(h.state.clipboardStorage.resolvedPath,'/B');
    assert.equal(h.state.draftOrigin.storagePath,'/A','picker preview is not the catalog source');
    if(mode==='json')h.json(JSON.stringify(h.state.config));
    const p=h.ctx.save();
    h.state.config.plugins.web.settings.items=[{id:'A-new'}];
    h.ctx.markDirty();
    if(mode==='json')h.json(JSON.stringify(h.state.config));
    h.ctx.window.weborg.getClipboardStorageInfo=async()=>({activePath:'/B',resolvedPath:'/B'});
    h.saving.resolve({ok:true,config:dbConfig('/B'),storageState:{operation:'open',activePath:'/B'}});
    await p;
    const keyA=draftKey(commonFile,'/A'),keyB=draftKey(commonFile,'/B');
    assert.ok(h.state.saveConflict);
    await h.ctx.closeSettings();
    const retained=JSON.parse(h.storage.get(keyA));
    assert.equal(retained.origin.storagePath,'/A');
    assert.equal(retained.saveConflict.sourceOrigin.storagePath,'/A');
    assert.equal(retained.config.plugins.clipboard.settings.storagePath,'/B');
    assert.equal(h.storage.has(keyB),false);

    const b=await reopen('/B',h.storage);
    assert.equal(b.state.config.plugins.web.settings.items[0].id,'/B','reopening B does not restore A catalog');
    assert.equal(b.state.saveConflict,null);
    const saveB=b.ctx.save();
    assert.equal(b.submitted().plugins.web.settings.items[0].id,'/B','saving after reopen cannot overwrite B with A');
    b.saving.resolve({ok:true,config:dbConfig('/B'),storageState:{operation:'save',activePath:'/B'}});await saveB;
    assert.ok(b.storage.has(keyA),'saving B does not clear A draft');
    b.edit('B-draft');b.flush();
    await b.ctx.reload();
    assert.ok(b.storage.has(keyA),'resetting B does not clear A draft');
    assert.equal(b.storage.has(keyB),false);
    b.edit('B-independent');b.flush();const independentB=b.storage.get(keyB);

    const a=await reopen('/A',b.storage);
    assert.equal(a.state.saveConflict,null,'returning to the actual source permits recovery');
    assert.equal(a.state.config.plugins.web.settings.items[0].id,'A-new');
    assert.equal(a.state.config.plugins.clipboard.settings.storagePath,'/A','recovery drops the old pending B destination');
    if(mode==='json')assert.equal(JSON.parse(a.element('#jsonEditor').value).plugins.clipboard.settings.storagePath,'/A');
    const saveA=a.ctx.save();
    assert.equal(a.submitted().plugins.clipboard.settings.storagePath,'/A');
    assert.equal(a.submitted().plugins.web.settings.items[0].id,'A-new');
    a.saving.resolve({ok:true,config:clone(a.submitted()),storageState:{operation:'save',activePath:'/A'}});await saveA;
    assert.equal(a.storage.has(keyA),false);
    assert.equal(a.storage.get(keyB),independentB,'saving A does not clear B draft');
  }
  {
    // Existing v1 drafts from the first implementation cannot prove origin.
    const legacyKey='flowhub:settings-draft:v1:'+commonFile;
    const stored=new Map([[legacyKey,JSON.stringify({version:1,config:dbConfig('/B','A-legacy'),mode:'structure',savedAt:1})]]);
    const b=await reopen('/B',stored);
    assert.ok(b.state.saveConflict);await b.ctx.save();assert.equal(b.calls(),0);
    await b.ctx.closeSettings();
    assert.equal(JSON.parse(b.storage.get(legacyKey)).origin,null,'unknown source is not relabeled as B');
    const again=await reopen('/B',b.storage);
    assert.ok(again.state.saveConflict);await again.ctx.save();assert.equal(again.calls(),0);
    await again.ctx.reload();assert.ok(again.storage.has(legacyKey),'reset does not erase unassigned source draft');
    assert.equal(again.state.config.plugins.web.settings.items[0].id,'/B');
  }
  {
    const a=await reopen('/A',[]);
    a.state.config.plugins.clipboard.settings.storagePath='/B';a.ctx.markDirty();
    const pending=a.ctx.save();a.edit('closing-in-flight');await a.ctx.closeSettings();
    const beforeResponse=new Map(a.storage);
    assert.equal(JSON.parse(beforeResponse.get(draftKey(commonFile,'/A'))).saveConflict,null);
    const b=await reopen('/B',beforeResponse);
    assert.equal(b.state.config.plugins.web.settings.items[0].id,'/B','origin isolates even when the window closes before the save response');
    const recoveredA=await reopen('/A',beforeResponse);
    assert.equal(recoveredA.state.config.core.name,'closing-in-flight');
    assert.equal(recoveredA.state.config.plugins.clipboard.settings.storagePath,'/A');
    a.saving.resolve({ok:false,reason:'test complete'});await pending;
  }
  console.log('PASS: shared config.json, A/B database draft isolation across close/reopen, source recovery, JSON rebinding, per-database cleanup and legacy quarantine');
  console.log('PASS: isolated snapshots, edits during save/metadata, deduplication, failure, JSON, target-open conflicts, draft timers, reload and close');
})().catch(error=>{console.error(error);process.exitCode=1});
