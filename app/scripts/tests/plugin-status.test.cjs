const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('status preferences save with zero or multiple favorite selections',async()=>{
  for(const favoriteIds of [[],['a','b']]){
    const elements=new Map(),calls=[];
    const element=selector=>{if(!elements.has(selector))elements.set(selector,{});return elements.get(selector);};
    element('#tray').checked=true;element('#pinned').checked=true;
    const document={hidden:false,querySelector:element,querySelectorAll:()=>favoriteIds.map(value=>({value})),addEventListener(){}};
    const invoke=async(method,args)=>{calls.push(args);return {preferences:{favorites:favoriteIds},snapshot:null};};
    vm.runInNewContext(fs.readFileSync('ui/plugin-status.js','utf8'),{document,location:{search:'?id=machines'},URLSearchParams,window:{__TAURI__:{core:{invoke}}},setInterval(){}});
    await element('#save').onclick();
    const saved=calls.find(c=>c.action==='save');assert(saved);assert.equal(saved.payload.pinned,true);
    assert.deepEqual(Array.from(saved.payload.favorites),favoriteIds);assert.equal(element('#save').disabled,false);
    assert.equal(element('#message').textContent,'显示设置已保存');
  }
});
