const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const runner=fs.readFileSync(path.resolve(__dirname,'../stress/native-run.js'),'utf8');
async function run(extra={}) {
  let now=0;const saved=[];
  const window={__TAURI__:{core:{invoke:async(command,args)=>saved.push({command,...args})}},refreshSearchTiming:async()=>{},flowhubSearchTiming:{enable(){},reset(){}},...extra};
  const context=vm.createContext({window,navigator:{userAgent:'fixture'},performance:{now:()=>now},Date,Promise,clearTimeout(){},setTimeout:fn=>{now+=1000;queueMicrotask(fn);}});
  await vm.runInContext(runner,context);
  return saved;
}
test('native runner always finishes when React bridge is unavailable or initialization rejects',async()=>{
  for(const extra of [{},{FlowHubSearchDiagnostics:{ready:Promise.reject(new Error('fixture')),inspect:()=>({initialized:false})}}]) {
    const saved=await run(extra);assert.equal(saved.length,1);assert.equal(saved[0].command,'save_search_diagnostic_run');assert.equal(saved[0].report.error,'runner-failed');
  }
});
test('restoration and timing failures cannot skip native finish or leak original query',async()=>{
  const saved=await run({FlowHubSearchDiagnostics:{ready:Promise.resolve(),inspect:()=>({initialized:true}),checkpoint:()=>()=>{throw new Error('private query');},resultsElement:()=>({}),setScope:()=>{throw new Error('private result');}},refreshSearchTiming:async()=>{throw new Error('private settings');}});
  assert.equal(saved.length,1);assert.equal(saved[0].report.restoreError,'restore-failed');assert.equal(saved[0].report.timingError,'timing-reset-failed');assert.doesNotMatch(JSON.stringify(saved),/private/);
});
test('diagnostic bridge is local, native-only, reports lengths and cleans up on unmount',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../../ui/search/search.js'),'utf8');
  assert.match(source,/if \(window\.__TAURI__\?\.core\?\.invoke\) window\.FlowHubSearchDiagnostics = diagnosticBridge/);
  assert.match(source,/delete window\.FlowHubSearchDiagnostics/);
  assert.doesNotMatch(runner,/\bq\.value|\bstate\.|\bmatches\(|\bsetScope\(scope\)(?!;)/);
});
test('hung initialization and timing reset are bounded and still finish the native session',async()=>{
  const saved=await run({FlowHubSearchDiagnostics:{ready:new Promise(()=>{})},refreshSearchTiming:()=>new Promise(()=>{})});
  assert.equal(saved.length,1);assert.equal(saved[0].report.error,'query-timeout');assert.equal(saved[0].report.timingError,'timing-reset-failed');
});
