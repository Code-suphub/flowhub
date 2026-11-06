const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync('scripts/dev/ui-test-agent.js','utf8').replace('__FLOWHUB_UI_TEST_TOKEN__',JSON.stringify('fixture-token-for-isolated-test-only')).replace('__FLOWHUB_UI_TEST_PID__','12345');
function page(html){
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://fixture.invalid'});
  dom.window.HTMLElement.prototype.getClientRects=function(){return this.isConnected?[{}]:[];};
  dom.window.HTMLElement.prototype.scrollIntoView=function(){};
  dom.window.eval(source);
  return {window:dom.window,api:dom.window.FlowHubUITest,close:()=>dom.window.close()};
}
test('click traverses the DOM handler and confirmation, but refuses disabled controls',async()=>{
  const p=page('<button disabled>连接</button><button>断开</button><section id="confirm" hidden><button>确认断开</button></section><p role="status">已连接</p>');
  try{
    const d=p.window.document;let stopped=0;
    d.querySelectorAll('button')[1].onclick=()=>d.querySelector('#confirm').hidden=false;
    d.querySelectorAll('button')[2].onclick=()=>{stopped++;d.querySelector('[role=status]').textContent='已断开';};
    await assert.rejects(p.api.request({op:'click',target:{role:'button',name:'连接'}}),/control-disabled/);
    await p.api.request({op:'click',target:{role:'button',name:'断开'}});assert.equal(stopped,0);
    await p.api.request({op:'click',target:{role:'button',name:'确认断开'}});
    assert.equal(stopped,1);assert.equal((await p.api.request({op:'read',target:{css:'[role=status]'}})).text,'已断开');
  }finally{p.close();}
});
test('ambiguous and stale references fail instead of activating a different control',async()=>{
  const p=page('<button>保存</button><button>保存</button>');
  try{
    await assert.rejects(p.api.request({op:'click',target:{role:'button',name:'保存'}}),/found 2/);
    const snapshot=await p.api.request({op:'inspect'});const ref=snapshot.controls[0].ref;
    p.window.document.querySelector('button').remove();
    await assert.rejects(p.api.request({op:'click',target:{ref}}),/stale-reference/);
  }finally{p.close();}
});
test('modal isolation, hidden controls and password fields remain protected',async()=>{
  const p=page('<button id="outside">外部</button><div role="dialog" aria-modal="true"><input aria-label="密码" type="password" value="private"><button hidden>隐藏</button></div>');
  try{
    await assert.rejects(p.api.request({op:'click',target:{css:'#outside'}}),/blocked-by-modal/);
    await assert.rejects(p.api.request({op:'click',target:{role:'button',name:'隐藏'}}),/found 0/);
    await assert.rejects(p.api.request({op:'read',target:{role:'textbox',name:'密码'}}),/password-read-refused/);
    assert.doesNotMatch(JSON.stringify(await p.api.request({op:'inspect'})),/private/);
  }finally{p.close();}
});
test('native HTML dialog blocks outside controls even without an explicit ARIA role',async()=>{
  const p=page('<button>背景</button><dialog open aria-label="配置"><button>保存</button></dialog>');
  try {
    await assert.rejects(p.api.request({op:'click',target:{role:'button',name:'背景'}}),/blocked-by-modal/);
    assert.deepEqual(Array.from((await p.api.request({op:'inspect'})).dialogs),['配置']);
    assert.equal((await p.api.request({op:'click',target:{role:'button',name:'保存'}})).dispatched,true);
  } finally {p.close();}
});
test('fill dispatches editable input events and key reports synthetic handler coverage',async()=>{
  const p=page('<textarea aria-label="命令"></textarea>');
  try{
    const input=p.window.document.querySelector('textarea'),events=[];
    input.addEventListener('input',e=>events.push([e.type,e.target.value,e.isTrusted]));
    input.addEventListener('keydown',e=>events.push([e.type,e.key,e.isTrusted]));
    await p.api.request({op:'fill',target:{role:'textbox',name:'命令'},value:'机器验收'});
    const sent=await p.api.request({op:'key',target:{role:'textbox',name:'命令'},key:'Enter'});
    assert.deepEqual(events,[['input','机器验收',false],['keydown','Enter',false]]);
    assert.equal(sent.mode,'synthetic-dom');assert.equal(sent.trusted,false);
    assert.equal((await p.api.request({op:'read',target:{role:'textbox',name:'命令'}})).value,'机器验收');
  }finally{p.close();}
});
