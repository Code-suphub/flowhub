import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {createServer} from 'node:http';
import {UITestClient,webdriver} from '../dev/ui-test-client.mjs';
const exec=promisify(execFile);
test('help and argument errors produce parseable JSON',async()=>{
  const {stdout}=await exec(process.execPath,['scripts/dev/flowhub-ui-test.mjs','help']);
  assert.match(JSON.parse(stdout).scope,/not system input/);
  await assert.rejects(exec(process.execPath,['scripts/dev/flowhub-ui-test.mjs','click','--session']),error=>{
    assert.match(JSON.parse(error.stderr).error,/require values/);return true;
  });
});
test('start rejects the real home before creating a marker or starting an application',async()=>{
  await assert.rejects(exec(process.execPath,['scripts/dev/flowhub-ui-test.mjs','start','--data',homedir()]),error=>{
    assert.match(JSON.parse(error.stderr).error,/production or home/);return true;
  });
});
test('driver refuses remote, credentialed and non-HTTP endpoints before network access',async()=>{
  for(const endpoint of ['http://example.invalid','http://localhost:4445','http://user:password@127.0.0.1:4445','https://127.0.0.1:4445']) {
    await assert.rejects(webdriver(endpoint,'/status'),/only a loopback/);
  }
});
test('a page rejection retains its reason and is not mistaken for a WebDriver HTTP error',async()=>{
  const server=createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({value:{error:'control-disabled'}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const client=new UITestClient({endpoint:`http://127.0.0.1:${server.address().port}`,id:'fixture',token:'fixture'});
    await assert.rejects(client.click({role:'button',name:'断开'}),/^Error: control-disabled$/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('wait tolerates rendering and disabled states, and bounds a missing result',async()=>{
  const client=new UITestClient({}),target={role:'button',name:'执行'};let calls=0;
  client.read=async()=>{calls++;if(calls===1)throw Error('not mounted');return {disabled:calls<3,text:'执行'};};
  assert.equal((await client.wait(target,{enabled:true,timeout:2000})).disabled,false);assert.equal(calls,3);
  client.read=async()=>({disabled:false,text:'wrong target state'});
  await assert.rejects(client.wait(target,{text:'已断开',timeout:1}),/wait-timeout/);
  client.read=async()=>{throw Error('frame-response-timeout');};
  await assert.rejects(client.wait(target,{absent:true,timeout:1}),/wait-timeout/);
  client.read=async()=>{throw Error('expected-one-control: found 0');};
  assert.equal((await client.wait(target,{absent:true})).absent,true);
});
