const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

function setup(){
  let now=0,id=0,position={x:20,y:20};const timers=new Map();
  const element=()=>({isConnected:true,hidden:true,setAttribute(){},contains(){return false;},getBoundingClientRect(){return {left:0,top:0,right:100,bottom:100};}});
  const source=fs.readFileSync(require('node:path').join(__dirname,'../ui/plugin-canvas.js'),'utf8').split('  function openCard')[0];
  const context=vm.createContext({window:{__TAURI__:{core:{invoke:async()=>position}}},document:{querySelector(){},createElement:element,body:{append(){}}},setTimeout(fn,ms){timers.set(++id,{fn,time:now+ms});return id;},clearTimeout(id){timers.delete(id);}});
  vm.runInContext(source+'globalThis.api={open(){closeMenu();menu.hidden=false;menuCard=menu;watchMenu();},hidden:()=>menu.hidden,move:trackMenuPosition,close:closeMenu};})();',context);
  return {api:context.api,setPosition(p){position=p;},async advance(ms){const end=now+ms;while(true){const next=[...timers].filter(([,v])=>v.time<=end).sort((a,b)=>a[1].time-b[1].time)[0];if(!next)break;now=next[1].time;timers.delete(next[0]);next[1].fn();await Promise.resolve();await Promise.resolve();}now=end;},timers};
}
test('native cursor closes menu after crossing another card without DOM leave events',async()=>{
  const s=setup();for(let i=0;i<6;i++){s.setPosition({x:20,y:20});s.api.open();await s.advance(120);assert.equal(s.api.hidden(),false);s.setPosition({x:240,y:20});await s.advance(120);s.setPosition({x:700,y:500});await s.advance(200);assert.equal(s.api.hidden(),true);assert.equal(s.timers.size,0);}
});
test('moving into menu cancels dismissal and switching menus clears old timers',async()=>{
  const s=setup();s.api.open();s.api.move(240,20);s.api.move(20,20);await s.advance(200);assert.equal(s.api.hidden(),false);s.api.move(240,20);s.api.open();await s.advance(200);assert.equal(s.api.hidden(),false);s.api.close();assert.equal(s.timers.size,0);
});
