const {test}=require('node:test');
const assert=require('node:assert/strict');
const load=()=>import('../dev/native-plugin-cli.mjs');

test('native plugin CLI validates commands before launching anything',async()=>{
  const {runPluginCli}=await load();let calls=0;
  for(const args of [['migrate','../bad'],['reload','../bad'],['reload','docker','--force'],['install','docker'],['verify','docker','--force'],[]]) {
    await assert.rejects(runPluginCli(args,{run:async()=>{calls++;}}),/用法/);
  }
  assert.equal(calls,0);
});
test('reload supports a dry-run and uses only the native maintenance client',async()=>{
  const {runPluginCli}=await load();
  for(const extra of [[],['--dry-run']]) {
    const calls=[];
    await runPluginCli(['reload','device-center',...extra],{run:async(...args)=>{
      calls.push(args);return {stdout:calls.length===1?'1':JSON.stringify({ok:true,protocol:1,result:{}})};
    }});
    assert.deepEqual(calls[1][1],['--plugin-cli','reload','device-center',...extra]);
  }
});
test('old installed host is rejected before it can interpret CLI arguments as a launcher toggle',async()=>{
  const {runPluginCli}=await load();const calls=[];
  await assert.rejects(runPluginCli(['list'],{run:async(...args)=>{calls.push(args);throw Error('No such key');}}),/不支持插件管理 CLI/);
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/usr/libexec/PlistBuddy');
});
test('dry-run and native response pass through without shell, desktop input or HTTP',async()=>{
  const {runPluginCli}=await load();const calls=[];
  const run=async(...args)=>{calls.push(args);return {stdout:calls.length===1?'1\n':JSON.stringify({ok:true,protocol:1,result:{dryRun:true}})};};
  const result=await runPluginCli(['migrate','twofa','--dry-run'],{bundle:'/custom/FlowHub.app',run});
  assert.equal(result.result.dryRun,true);
  assert.equal(calls[1][0],'/custom/FlowHub.app/Contents/MacOS/flowhub-tauri');
  assert.deepEqual(calls[1][1],['--plugin-cli','migrate','twofa','--dry-run']);
});
test('structured native errors and invalid replies are reported without a success claim',async()=>{
  const {runPluginCli}=await load();
  for(const [stdout,expected] of [['not JSON',/无效 JSON/],[JSON.stringify({ok:true,protocol:2}),/协议不支持/]]) {
    let calls=0;await assert.rejects(runPluginCli(['verify','docker'],{run:async()=>({stdout:++calls===1?'1':stdout})}),expected);
  }
  let calls=0;
  await assert.rejects(runPluginCli(['migrate','docker'],{run:async()=>{if(++calls===1)return {stdout:'1'};throw Object.assign(Error('exit 1'),{stdout:JSON.stringify({ok:false,error:'固定目录内容不同'})});}}),/固定目录内容不同/);
});
