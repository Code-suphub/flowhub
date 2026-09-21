const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('theme colors keep switch states, icons and supporting text legible',()=>{
  const palette=fs.readFileSync(path.join(__dirname,'../../ui/shared/palette.css'),'utf8');
  const luminance=hex=>hex.match(/[a-f\d]{2}/gi).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const contrast=(a,b)=>{const values=[luminance(a),luminance(b)].sort((a,b)=>b-a);return(values[0]+.05)/(values[1]+.05);};
  for(const block of palette.matchAll(/:root\[data-theme(?:="light")?\]\s*\{([^}]+)\}/g)){
    const colors=Object.fromEntries([...block[1].matchAll(/--fh-([\w-]+):\s*(#[a-f\d]{6})/gi)].map(m=>[m[1],m[2]]));
    if(!colors.surface)continue; // Ignore the shared alias block below the palettes.
    for(const [a,b,min] of [['muted','surface',4.5],['muted','surface-soft',3],['accent','surface-soft',3],['on-accent','accent',3]]) assert.ok(contrast(colors[a],colors[b])>=min,`${a}/${b} contrast`);
  }
});
test('global theme restores preferences, follows OS, broadcasts only to child frames',()=>{
  const listeners={},messages=[],select={value:''},frame={contentWindow:{postMessage:m=>messages.push(m)}};
  const media={matches:false,addEventListener(_,fn){this.change=fn;}};
  const document={documentElement:{dataset:{},style:{}},querySelectorAll:s=>s==='iframe'?[frame]:[select],addEventListener:(n,f)=>listeners[n]=f};
  const storage=new Map([['flowhub.theme','dark']]);
  const window={addEventListener:(n,f)=>listeners[n]=f,dispatchEvent:()=>{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../ui/shared/theme.js'),'utf8'),{window,document,Event,matchMedia:()=>media,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}});
  assert.equal(document.documentElement.dataset.theme,'dark');
  window.FlowHubTheme.set('light');assert.equal(select.value,'light');assert.equal(messages.at(-1).theme,'light');
  window.FlowHubTheme.set('system');media.matches=true;media.change();assert.equal(messages.at(-1).theme,'dark');
  const before=messages.length;listeners.message({source:{},data:{type:'flowhub:theme-ready'}});assert.equal(messages.length,before);
  listeners.message({source:frame.contentWindow,data:{type:'flowhub:theme-ready'}});assert.equal(messages.length,before+1);
  listeners.storage({key:'flowhub.theme',newValue:'light'});assert.equal(document.documentElement.dataset.theme,'light');
});
