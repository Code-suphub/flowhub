const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../ui/plugin-canvas.js'),'utf8');
const fn=source.slice(source.indexOf('  function minimum('),source.indexOf('  function render('));
test('plugin minimum sizing preserves generic defaults and bounds manifest input',()=>{
 const ctx=vm.createContext({sources:[{id:'machine',widget:{minWidth:220,minHeight:150}},{id:'docker',widget:{interactive:true}},{id:'bad',widget:{minWidth:99999,minHeight:-1}}]});vm.runInContext(fn,ctx);
 const size=id=>JSON.parse(JSON.stringify(ctx.minimum({plugin:id})));
 assert.deepEqual(size('machine'),{width:220,height:150});assert.deepEqual(size('other'),{width:160,height:120});assert.deepEqual(size('docker'),{width:320,height:280});assert.deepEqual(size('bad'),{width:1600,height:120});
});
