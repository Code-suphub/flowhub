// Reproducible host refresh counts. No native process, external plugin or CPU inference.
const {test}=require('node:test');
const {setup,ready}=require('./widget-canvas-react.test.cjs');
const {installCanvasClock}=require('./canvas-clock.cjs');
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
test('60-second virtual canvas lifecycle refresh measurement',async t=>{
  const started=performance.now();let clock;
  const s=setup(t,{installClock:w=>clock=installCanvasClock(w)});await ready(s);
  const frame=s.w.document.querySelector('iframe');s.frameMessages(frame);s.message(frame,{type:'flowhub:widget-ready'});await new Promise(setImmediate);
  let hidden=false;Object.defineProperty(s.w.document,'hidden',{configurable:true,get:()=>hidden});
  const report=[];
  async function sample(label,change) {
    if(change)await change();await new Promise(resolve=>setTimeout(resolve,20));
    const start=s.calls.length,messages=s.responses.length;
    await clock.advance(60000);await new Promise(resolve=>setTimeout(resolve,20));
    const calls=s.calls.slice(start);
    report.push({label,virtualSeconds:60,hostGet:calls.filter(call=>call.action==='get').length,cursor:calls.filter(call=>call.action==='cursor').length,iframeContextMessages:s.responses.slice(messages).filter(message=>message.type==='flowhub:widget-init').length,frames:s.w.document.querySelectorAll('iframe').length,pendingMs:clock.pending()});
  }
  await sample('native visible; document.hidden=false');
  await sample('native still visible; document.hidden=true',()=>{hidden=true;s.w.document.dispatchEvent(new s.w.Event('visibilitychange'));});
  await sample('native hide/occlusion; no pagehide',()=>s.w.dispatchEvent(new s.w.CustomEvent('flowhub:canvas-lifecycle',{detail:{active:false,revision:1}})));
  await sample('native show; document.hidden remains true',()=>s.w.dispatchEvent(new s.w.CustomEvent('flowhub:canvas-lifecycle',{detail:{active:true,revision:2}})));
  await sample('visible compact mode',()=>s.w.dispatchEvent(new s.w.CustomEvent('flowhub:canvas-presentation',{detail:{enabled:true,collapsed:true,favorites:[{boardId:'default',cardId:'one'}],revision:3}})));
  const oldMessages=s.responses.length;s.message(frame,{type:'flowhub:widget-ready'});await new Promise(setImmediate);
  report.push({label:'already-disposed compact card bridge',messages:s.responses.length-oldMessages});
  await sample('pagehide',()=>s.w.dispatchEvent(new s.w.Event('pagehide')));
  s.root.unmount();await clock.advance(60000);report.push({label:'React unmount',pendingMs:clock.pending()});
  const ref=process.env.FLOWHUB_CANVAS_BASELINE_REF,root=path.resolve(__dirname,'../../..');
  const sources=Object.fromEntries(['Canvas.tsx','WidgetSurface.tsx'].map(name=>{const file=`app/src/canvas/${name}`,bytes=ref?execFileSync('git',['show',`${ref}:${file}`],{cwd:root}):fs.readFileSync(path.join(root,file));return [file,createHash('sha256').update(bytes).digest('hex')];}));
  console.log(JSON.stringify({source:ref||'working tree',resolvedCommit:execFileSync('git',['rev-parse',ref||'HEAD'],{cwd:root,encoding:'utf8'}).trim(),sources,fixtureElapsedMs:Math.round(performance.now()-started),report},null,2));
});
