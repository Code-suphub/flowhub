const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const vm=require('node:vm');
const script=resolve(__dirname,'../build/local-build.mjs');
const source=readFileSync(script,'utf8').replace(/^import[^\n]+;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(pathToFileURL(script).href));
function simulate(extra){
 const calls=[];
 const context={join,resolve,URL,Date,console:{log(){}},tmpdir:()=>'/tmp',existsSync:()=>true,
  readFileSync:()=>JSON.stringify({version:'0.1.18'}),mkdtempSync:()=>'/tmp/fixture-build',writeFileSync(){},rmSync(){},
  process:{argv:['node',script,...extra],execPath:'/fixture/node',platform:'darwin',exit(){throw Error('unexpected exit');}},
  spawnSync(command,args){calls.push({command,args});return command==='pgrep'?{status:1,stdout:''}:{status:0,stdout:''};}};
 vm.runInNewContext(source,context,{filename:script});return calls;
}
test('background installation uses LaunchServices without activating the app and filters internal flags',()=>{
 const calls=simulate(['--install','--background']);
 assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c=>c.command==='open').args)),['-g','-a','/Applications/FlowHub.app']);
 const build=calls.find(c=>c.command==='/fixture/node');
 assert.equal(build.args.includes('--background'),false);assert.equal(build.args.includes('--install'),false);
 assert.ok(build.args.includes('--bundles'));assert.ok(build.args.includes('app'));
});
test('ordinary installation retains its foreground launch and background-only usage is rejected',()=>{
 const calls=simulate(['--install']);
 assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c=>c.command==='open').args)),['-a','/Applications/FlowHub.app']);
 assert.throws(()=>simulate(['--background']),/仅用于/);
});
