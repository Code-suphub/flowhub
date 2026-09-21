const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {JSDOM}=require('jsdom');
const app=path.resolve(__dirname,'../..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(fn){const end=Date.now()+30000;while(!fn()){if(Date.now()>end)assert.fail('fixture did not settle');await sleep(10);}}
function generated(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowhub-fixture-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  execFileSync('python3',['-B','-c',"import runpy,sys; runpy.run_path(sys.argv[1])['build_fixture'](sys.argv[2])",path.join(app,'scripts/stress/serve.py'),root]);
  return root;
}
async function setup(t,{native=false}={}) {
  const root=generated(t),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.doesNotMatch(html,/tauri-adapter|browser-adapter/);
  assert.equal(fs.existsSync(path.join(root,'shared/tauri-adapter.js')),false);
  assert.equal(fs.existsSync(path.join(root,'config.json')),false);
  const dom=new JSDOM(html,{url:'http://synthetic.invalid',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window;
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.requestAnimationFrame=fn=>w.setTimeout(()=>fn(w.performance.now()),1);w.cancelAnimationFrame=id=>w.clearTimeout(id);
  // No resources are fetched; execute only the copied local script bytes.
  w.fetch=()=>{throw new Error('fixture attempted a network request');};
  for(const script of w.document.querySelectorAll('script[src]')) {
    if(native && script.getAttribute('src')==='search/search.js')w.__TAURI__={};
    w.eval(fs.readFileSync(path.join(root,script.getAttribute('src')),'utf8'));
  }
  if(!native){await wait(()=>w.FlowHubSearchFixture.bridge()?.inspect().initialized);
    const results=w.document.getElementById('results');
    Object.defineProperty(results,'clientHeight',{get:()=>480});
    Object.defineProperty(results,'scrollHeight',{get:()=>w.FlowHubSearchFixture.bridge().inspect().loaded*80});
  }
  return {w,root};
}
test('generated isolated fixture executes stress, paging and React timing with no legacy globals or real adapter',async t=>{
  const {w}=await setup(t);const bridge=w.FlowHubSearchFixture.bridge();
  assert.equal(w.FlowHubSearchDiagnostics,undefined);assert.equal(w.state,undefined);assert.equal(w.matches,undefined);assert.equal(w.setScope,undefined);
  assert.deepEqual(Object.keys(bridge.inspect()).sort(),['hasMore','initialized','loaded','loading','scope','unique']);
  const reportNode=w.document.getElementById('stressReport');
  for(const kind of ['stress','paging','timing']) {
    const button=w.document.querySelector(`[data-stress-run="${kind}"]`);button.click();
    await wait(()=>!button.disabled && reportNode.textContent.startsWith('{'));
    const report=JSON.parse(reportNode.textContent);assert.equal(report.error,undefined,JSON.stringify(report));
    if(kind==='stress') {
      assert.equal(report.scopes.filter(s=>Array.isArray(s.ms)).length,4);
      assert.ok(report.scopes.filter(s=>s.n>80).every(s=>s.domRows<80));
      assert.ok(report.longRecord.domChars<20000);
      assert.ok(report.slow.firstResultMs>0 && report.slow.firstResultMs<report.slow.allCompleteMs-300);
    } else if(kind==='paging') {
      assert.equal(report.loaded,3000);assert.equal(report.unique,3000);assert.equal(report.hasMore,false);
      assert.equal(report.keyboardVisible,true);assert.equal(report.atStart,0);assert.equal(report.atEnd,2999);assert.ok(report.maxDOM<=80);
    } else {
      assert.ok(report.runs.some(run=>run.firstResponseDomMs!=null && run.reactCommitsMs?.length));
      assert.ok(report.runs.some(run=>run.sources.some(source=>source.source==='app' && source.status==='ok')));
    }
    assert.equal(bridge.inspect().loaded,0,'synthetic data cleaned after run');
  }
});
test('fixture control bridge is never connected when a native host is present',async t=>{
  const {w}=await setup(t,{native:true});await sleep(30);
  assert.equal(w.FlowHubSearchFixture.bridge(),null);
  w.document.querySelector('[data-stress-run="stress"]').click();await wait(()=>!w.document.querySelector('[data-stress-run="stress"]').disabled);
  assert.match(w.document.getElementById('stressReport').textContent,/fixture-unavailable/);
});
