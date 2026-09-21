const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
test('React owns all sources, escaped previews, stable expansion, clipboard edit cancellation and read-only actions',async t=>{
  const {w,q,scope,key,calls}=await setup(t,{readonly:true});
  for(const id of ['app','web','memo','twofa','clipboard']){await scope(id);assert.ok(w.document.querySelector('.result'),id);}
  const row=w.document.querySelector('.clipboard-result'), toggle=row.querySelector('[data-clipboard-toggle]');
  assert.equal(row.querySelector('script'),null);assert.match(row.textContent,/<script>/);
  toggle.click();await wait(()=>toggle.getAttribute('aria-expanded')==='true');assert.equal(w.document.querySelector('.clipboard-result'),row);
  row.querySelector('[data-clipboard-action="pin"]').click();await delay(20);assert.equal(calls.filter(c=>c[0]==='action').length,0);
  row.querySelector('[data-clipboard-action="edit"]').click();await wait(()=>w.document.querySelector('textarea'));
  key('Escape');await wait(()=>!w.document.querySelector('textarea'));assert.equal(w.document.activeElement,q);assert.equal(calls.filter(c=>c[0]==='hide').length,0);
});
test('React renders type-specific clipboard and result actions, preserves editor input and saves only on explicit action',async t=>{
  const {w,scope,calls}=await setup(t,{search:(id,args,fixture)=>id==='clipboard'?[...fixture.clipboard,{id:2,kind:'image',imageUrl:'data:image/png;base64,fixture'},{id:3,kind:'file',fileNames:['a.txt']}]:fixture[id] || []});
  await scope('clipboard');
  const rows=[...w.document.querySelectorAll('.clipboard-result')];
  assert.ok(rows[0].querySelector('[data-clipboard-action="edit"]'));
  assert.equal(rows[1].querySelector('[data-clipboard-action="plain"]'),null);
  assert.equal(rows[1].querySelector('[data-clipboard-action="edit"]'),null);
  assert.ok(rows[2].querySelector('[data-clipboard-action="plain"]'));
  rows[0].querySelector('[data-clipboard-action="edit"]').click();await wait(()=>w.document.querySelector('textarea'));
  const editor=w.document.querySelector('textarea');editor.value='new copy';
  w.document.querySelector('[data-clipboard-action="edit-save"]').click();await wait(()=>calls.some(c=>c[0]==='action'&&c[2]==='edit'));
  assert.equal(calls.find(c=>c[2]==='edit')[3].content,'new copy');
  for(const [scopeId,label] of [['app','复制路径'],['web','复制链接'],['memo','复制命令'],['twofa','复制验证码']]) {
    await scope(scopeId);const row=w.document.querySelector('.result');assert.ok(row.textContent.includes(label),scopeId);
    row.querySelector('[data-result-action="copy"]').click();await delay(20);
  }
  assert.ok(calls.some(c=>c[0]==='copy'&&c[1]==='https://example.com'));
  assert.ok(calls.some(c=>c[0]==='copy'&&c[1]==='123456'));
});
