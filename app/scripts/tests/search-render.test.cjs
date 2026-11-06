const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
test('React owns all sources, escaped previews, independent detail previews, clipboard edit cancellation and read-only actions',async t=>{
  const {w,q,scope,key,calls}=await setup(t,{readonly:true});
  for(const [id,type] of [['app','app'],['web','page'],['memo','memo'],['twofa','twofa'],['clipboard','clipboard']]){
    await scope(id);await wait(()=>w.document.querySelector(`.${type}-result`));
  }
  const row=w.document.querySelector('.clipboard-result');
  assert.equal(row.querySelector('script'),null);assert.match(row.textContent,/<script>/);
  row.querySelector('.result-preview-button').click();await wait(()=>w.document.querySelector('.preview-content'));assert.equal(w.document.querySelector('.clipboard-result'),row);assert.equal(w.document.querySelector('.preview-content script'),null);assert.match(w.document.querySelector('.preview-content').textContent,/<script>/);
  row.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await wait(()=>w.document.querySelector('.search-actions-dialog'));
  for(const action of ['clipboard:pin','clipboard:edit']) {
    const option=w.document.querySelector(`[data-command-id="${action}"]`);assert.equal(option.getAttribute('aria-disabled'),'true');option.click();
  }
  await delay(20);assert.equal(calls.filter(c=>c[0]==='action').length,0);assert.equal(w.document.querySelector('textarea'),null);
  w.document.querySelector('input[aria-label="搜索结果操作"]').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await wait(()=>!w.document.querySelector('.search-actions-dialog') && w.document.activeElement===q);assert.equal(calls.filter(c=>c[0]==='hide').length,0);
});
test('React renders type-specific clipboard and result actions, preserves editor input and saves only on explicit action',async t=>{
  const {w,scope,calls}=await setup(t,{search:(id,args,fixture)=>id==='clipboard'?[...fixture.clipboard,{id:2,kind:'image',imageUrl:'data:image/png;base64,fixture'},{id:3,kind:'file',fileNames:['a.txt']}]:fixture[id] || []});
  await scope('clipboard');
  const rows=[...w.document.querySelectorAll('.clipboard-result')];
  assert.equal(rows[0].querySelector('[data-clipboard-action="edit"]'),null);
  const close=async()=>{w.document.querySelector('.search-actions-dialog [aria-label="关闭"]').click();await wait(()=>!w.document.querySelector('.search-actions-dialog'));};
  rows[1].dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await wait(()=>w.document.querySelector('.search-actions-dialog'));
  assert.equal(w.document.querySelector('[data-command-id="clipboard:plain"]'),null);
  assert.equal(w.document.querySelector('[data-command-id="clipboard:edit"]'),null);await close();
  rows[2].dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await wait(()=>w.document.querySelector('[data-command-id="clipboard:plain"]'));await close();
  rows[0].dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await wait(()=>w.document.querySelector('[data-command-id="clipboard:edit"]'));
  w.document.querySelector('[data-command-id="clipboard:edit"]').click();await wait(()=>w.document.querySelector('textarea'));
  const editor=w.document.querySelector('textarea');editor.value='new copy';
  w.document.querySelector('[data-clipboard-action="edit-save"]').click();await wait(()=>calls.some(c=>c[0]==='action'&&c[2]==='edit'));
  assert.equal(calls.find(c=>c[2]==='edit')[3].content,'new copy');
  for(const [scopeId,label] of [['app','复制路径'],['web','复制链接'],['memo','复制命令'],['twofa','复制验证码']]) {
    await scope(scopeId);const row=w.document.querySelector('.result');
    assert.equal(row.querySelector('[data-result-action]'),null,scopeId);
    row.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    await wait(()=>w.document.querySelector('[data-command-id="result:copy"]'));
    assert.ok(w.document.querySelector('.search-actions-dialog').textContent.includes(label),scopeId);
    w.document.querySelector('[data-command-id="result:copy"]').click();await delay(40);
  }
  assert.ok(calls.some(c=>c[0]==='copy'&&c[1]==='https://example.com'));
  assert.ok(calls.some(c=>c[0]==='copy'&&c[1]==='123456'));
});
test('web result context menu waits for an explicit edit choice',async t=>{
  const {w,scope,calls}=await setup(t);
  await scope('web');
  const row=w.document.querySelector('.page-result');
  assert.ok(row);
  assert.equal(row.querySelector('[data-result-action]'),null);
  row.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  await wait(()=>w.document.querySelector('[data-command-id="result:edit"]'));
  assert.equal(calls.some(call=>call[0]==='settings'),false);
  w.document.querySelector('[data-command-id="result:edit"]').click();
  await wait(()=>calls.some(call=>call[0]==='settings'));
});
