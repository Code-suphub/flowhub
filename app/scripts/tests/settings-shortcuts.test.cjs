const {test}=require('node:test'),assert=require('node:assert/strict');
const h=require('./settings-harness.test.cjs');
const {Shortcut}=require('../../src/settings/fields.tsx');
async function recorder(t,extra={}) {
  h.environment();
  const nav=window.navigator,descriptor=Object.getOwnPropertyDescriptor(nav,'platform');
  Object.defineProperty(nav,'platform',{configurable:true,value:'MacIntel'});
  const values=[],view=await h.mount(Shortcut,{label:'测试快捷键',value:'Meta+Space',taken:[],onChange:value=>values.push(value),...extra});
  t.after(async()=>{await view.unmount();if(descriptor)Object.defineProperty(nav,'platform',descriptor);else delete nav.platform;});
  return {view,values,button:view.container.querySelector('[aria-label="测试快捷键"]')};
}
test('recorded Command survives saving to config and legacy Meta displays as Command',async t=>{
  const {button,values}=await recorder(t);
  assert.equal(button.textContent,'⌘ + Space');await h.click(button);
  await h.key(button,'Meta',{code:'MetaLeft',metaKey:true});assert.equal(button.getAttribute('aria-pressed'),'true');
  await h.key(button,' ',{code:'Space',metaKey:true});
  assert.deepEqual(values,['Command+Space']);assert.equal(button.getAttribute('aria-pressed'),'false');
  const config=h.fixture();config.core.hotkey=values[0];assert.equal(h.model.normalize(config).core.hotkey,'Command+Space');
});
test('alias-equivalent shortcuts are blocked by the same conflict detector',async t=>{
  const {button,values,view}=await recorder(t,{taken:['CmdOrControl+Space']});
  await h.click(button);await h.key(button,' ',{code:'Space',metaKey:true});
  assert.deepEqual(values,[]);assert.match(view.container.querySelector('[role="alert"]').textContent,/冲突/);
  await h.key(button,' ',{code:'Space',ctrlKey:true});assert.deepEqual(values,['Ctrl+Space']);
});
test('modified Delete and Escape record normally while bare Delete clears and bare Escape cancels',async t=>{
  const {button,values}=await recorder(t,{allowBare:true});
  await h.click(button);await h.key(button,'Backspace',{code:'Backspace',metaKey:true});
  await h.click(button);await h.key(button,'Escape',{code:'Escape',ctrlKey:true});
  await h.click(button);await h.key(button,'Escape',{code:'Escape'});
  await h.click(button);await h.key(button,'Delete',{code:'Delete'});
  assert.deepEqual(values,['Command+Backspace','Ctrl+Escape','']);
});
test('composition is ignored and invalid media keys never reach saved config',async t=>{
  const {button,values,view}=await recorder(t);
  await h.click(button);await h.key(button,'Process',{code:'KeyK',isComposing:true,metaKey:true});assert.deepEqual(values,[]);
  await h.key(button,'AudioVolumeUp',{code:'AudioVolumeUp',metaKey:true});assert.deepEqual(values,[]);assert.match(view.container.querySelector('[role="alert"]').textContent,/不支持/);
  await h.key(button,'˚',{code:'KeyK',altKey:true});assert.deepEqual(values,['Alt+K']);
});
test('import normalization recognizes aliases, numpad scope keys and empty malformed tokens',()=>{
  const config=h.fixture();config.core.scopeShortcuts={all:'Super+Space',app:'Command+Space',web:'Numpad1'};
  const next=h.model.normalize(config);assert.equal(next.core.scopeShortcuts.all,'Super+Space');assert.equal(next.core.scopeShortcuts.app,'');assert.equal(next.core.scopeShortcuts.web,'Numpad1');
  config.core.scopeShortcuts.app='Ctrl++';assert.throws(()=>h.model.normalize(config),/无效快捷键/);
});
