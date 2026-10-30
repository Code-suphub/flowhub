const {test}=require('node:test');
const assert=require('node:assert/strict');
const keys=require('../../ui/shared/shortcuts.js');
const stroke=(code,key,extra={})=>({code,key,ctrlKey:false,altKey:false,shiftKey:false,metaKey:false,...extra});

test('Command capture uses the native spelling and formats legacy Meta as the macOS key',()=>{
  const event=stroke('Space',' ',{metaKey:true});
  assert.deepEqual(keys.capture(event,false,true),{value:'Command+Space'});
  assert.deepEqual(keys.capture(event,false,false),{value:'Super+Space'});
  for(const alias of ['Meta','Cmd','Command','Super','OS']) {
    assert.equal(keys.format(`${alias}+Space`,true),'⌘ + Space');
    assert.equal(keys.canonical(`${alias}+Space`,true),keys.canonical('Command+Space',true));
    assert.equal(keys.matches(event,`${alias}+Space`,true),true);
  }
});
test('all primary-modifier aliases resolve consistently on each platform',()=>{
  for(const alias of ['CommandOrControl','CommandOrCtrl','CmdOrControl','CmdOrCtrl']) {
    assert.equal(keys.canonical(`${alias}+Space`,true),keys.canonical('Command+Space',true));
    assert.equal(keys.canonical(`${alias}+Space`,false),keys.canonical('Ctrl+Space',false));
    assert.equal(keys.matches(stroke('Space',' ',{ctrlKey:true}),`${alias}+Space`,true),false);
    assert.equal(keys.matches(stroke('Space',' ',{ctrlKey:true}),`${alias}+Space`,false),true);
  }
  assert.equal(keys.canonical('Shift+Option+Control+Meta+KeyK',true),keys.canonical('Command+Alt+Ctrl+Shift+K',true));
  assert.equal(keys.canonical('Command+Meta+Space',true),keys.canonical('Command+Space',true));
  assert.notEqual(keys.canonical('Ctrl+K+K',true),keys.canonical('Ctrl+K',true));
  for(const [alias,key] of [['Num1','Numpad1'],['NumPlus','NumpadAdd'],['VolumeUp','AudioVolumeUp'],['MediaTrackPrev','MediaTrackPrevious']])assert.equal(keys.canonical('Ctrl+'+alias),keys.canonical('Ctrl+'+key));
});
test('physical keys survive Option characters, Shift punctuation, Caps Lock and non-Latin layouts',()=>{
  for(const [event,expected] of [
    [stroke('KeyK','˚',{altKey:true}),'Alt+K'],
    [stroke('Equal','+',{ctrlKey:true,shiftKey:true}),'Ctrl+Shift+Equal'],
    [stroke('Digit1','!',{shiftKey:true}),'Shift+1'],
    [stroke('KeyA','ф',{metaKey:true}),'Command+A'],
    [stroke('Semicolon',':',{metaKey:true,shiftKey:true}),'Shift+Command+Semicolon'],
    [stroke('KeyK','K',{metaKey:true}),'Command+K'],
    [stroke('NumpadAdd','+',{metaKey:true}),'Command+NumpadAdd'],
  ]) {
    assert.equal(keys.capture(event,false,true).value,expected);
    assert.equal(keys.matches(event,expected,true),true);
  }
  assert.equal(keys.canonical('Ctrl+Shift+=',true),keys.canonical('Ctrl+Shift+Equal',true));
});
test('numpad, number row and Enter keys retain distinct identities',()=>{
  for(const [code,key] of [['Numpad1','1'],['NumpadEnter','Enter'],['Enter','Enter']]) {
    const event=stroke(code,key,{metaKey:true}),value=keys.capture(event,false,true).value;
    assert.equal(value,`Command+${code}`);assert.equal(keys.matches(event,value,true),true);
  }
  assert.equal(keys.matches(stroke('Digit1','1',{metaKey:true}),'Command+Numpad1',true),false);
  assert.equal(keys.matches(stroke('Numpad1','1',{metaKey:true}),'Command+1',true),false);
  assert.equal(keys.capture(stroke('Numpad1','1'),true,true).value,'Numpad1');
});
test('IME, repeat and modifier-only events never become bindings; unsupported keys stay explicit',()=>{
  for(const event of [stroke('KeyK','Process',{isComposing:true,metaKey:true}),stroke('KeyK','Process',{metaKey:true}),stroke('KeyK','k',{keyCode:229,metaKey:true}),stroke('KeyK','k',{repeat:true,metaKey:true}),stroke('MetaLeft','Meta')])assert.equal(keys.capture(event,false,true),null);
  for(const event of [stroke('IntlBackslash','\\',{metaKey:true}),stroke('AudioVolumeUp','AudioVolumeUp',{metaKey:true}),stroke('','Unidentified',{metaKey:true}),stroke('F21','F21',{metaKey:true})])assert.ok(keys.capture(event,false,true).error);
  assert.equal(keys.capture(stroke('F24','F24'),true,true).value,'F24');
  assert.equal(keys.capture(stroke('AudioVolumeUp','AudioVolumeUp',{ctrlKey:true}),false,false).value,'Ctrl+AudioVolumeUp');
  assert.equal(keys.matches(stroke('KeyK','k',{metaKey:true,isComposing:true}),'Command+K',true),false);
  assert.equal(keys.matches(stroke('KeyK','Process',{metaKey:true}),'Command+K',true),false);
  assert.ok(keys.capture(stroke('KeyE','€',{ctrlKey:true,altKey:true,getModifierState:()=>true}),false,false).error);
  assert.equal(keys.capture(stroke('KeyK','˚',{altKey:true,getModifierState:key=>key==='AltGraph'}),false,true).value,'Alt+K');
});
test('matching requires the exact modifiers and rejects malformed shortcuts',()=>{
  for(const shortcut of ['Meta++Space','Meta','Ctrl+Shift'])assert.equal(keys.matches(stroke('Space',' ',{metaKey:true}),shortcut,true),false);
  assert.equal(keys.matches(stroke('KeyK','k',{metaKey:true,shiftKey:true}),'Command+K',true),false);
  assert.equal(keys.capture(stroke('',' ',{metaKey:true}),false,true).value,'Command+Space');
  assert.equal(keys.capture(stroke('','k',{metaKey:true}),false,true).value,'Command+K');
});
