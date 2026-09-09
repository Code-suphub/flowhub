const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'../ui/focus-diagnostics.js'),'utf8');
async function fixture(enabled,loopEnabled=true) {
  let now=100,focused=true,timer;
  const events={},samples=[],timers=[];
  const q={id:'q'};
  const document={body:{},activeElement:q,hasFocus:()=>focused,querySelector:()=>({dataset:{scope:'all'}}),addEventListener:(name,fn)=>events[name]=fn};
  const window={addEventListener(){},__TAURI__:{core:{invoke:async (name,args)=>{
    if(name==='focus_diagnostics_enabled') return enabled;
    if(name==='focus_diagnostics_loop_enabled') return loopEnabled;
    samples.push(args.sample);
  }}}};
  vm.runInNewContext(source,{window,document,performance:{now:()=>now},requestAnimationFrame(){},setInterval(fn,ms){timer=fn;timers.push(ms);return 1;},clearInterval(){timer=null;}});
  await new Promise(resolve=>setImmediate(resolve));
  return {samples,timers,tick(t){now=t;timer?.();},focus(value){focused=value;},press(t,stamp){now=t;events.mousedown({timeStamp:stamp,target:q});}};
}
(async()=>{
  const off=await fixture(false); assert.equal(off.timers.length,0); assert.equal(off.samples.length,0);
  const noLoop=await fixture(true,false); noLoop.press(200,150);
  assert.equal(noLoop.timers.length,0); assert.equal(noLoop.samples.at(-1).metrics.eventDelayMs,50);
  assert.equal(noLoop.samples.at(-1).metrics.eventLoopGapMs,undefined);
  const f=await fixture(true); f.tick(100); f.tick(116); f.tick(132); f.press(140,110);
  assert.equal(f.samples.at(-1).metrics.eventLoopGapMs,16);
  f.press(340,140); assert.equal(f.samples.at(-1).metrics.eventLoopGapMs,208);
  f.focus(false);f.tick(350);f.tick(1000);f.focus(true);f.tick(1010);f.tick(1026);f.press(1030,1028);
  assert.equal(f.samples.at(-1).metrics.eventLoopGapMs,16);
  assert(f.samples.every(s=>!('value' in s)&&!('text' in s)));
  console.log('PASS: diagnostic opt-in, timer-free control, event-loop stalls and hidden-window reset');
})().catch(error=>{console.error(error);process.exitCode=1;});
