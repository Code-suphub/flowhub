document.querySelector('#privacyChecks').addEventListener('click',async()=>{
  const output=document.querySelector('#privacyReport');const passed=[];
  const check=(value,label)=>{if(!value)throw Error(label);passed.push(label);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const button=label=>[...document.querySelectorAll('#settings-root button')].find(node=>node.textContent.trim()===label);
  const toggle=(label,value)=>{const node=document.querySelector(`[role="switch"][aria-label="${label}"]`);if(!node)throw Error('missing switch '+label);if((node.getAttribute('aria-checked')==='true')!==value)node.click();};
  const settled=async()=>{for(let i=0;i<100;i++){await wait(20);if(document.querySelector('#settings-root [aria-busy]')?.getAttribute('aria-busy')!=='true')return;}throw Error('settings did not settle');};
  try {
    if(location.pathname.includes('settings')) {
      button('剪贴板').click();await wait(30);
      check(!document.querySelector('input[aria-label*="排除"],textarea[aria-label*="排除"]'),'selective exclusions have no editor');
      check(Boolean(button('清空旧列表并保存')),'imported exclusion shows recovery action');
      toggle('暂停采集',true);await wait(30);
      check(document.querySelector('[role="switch"][aria-label="暂停采集"]').getAttribute('aria-checked')==='true','pause shows draft state');
      check(fixtureConfig.plugins.clipboard.settings.capturePaused!==true,'pause does not reach native config before save');
      toggle('敏感标记保护',false);await wait(30);
      check(fixtureConfig.plugins.clipboard.settings.protectSensitive!==false,'protection is only a draft before save');
      button('保存').click();await settled();
      check(fixtureConfig.plugins.clipboard.settings.capturePaused===true,'pause saved through native adapter stub');
      check(fixtureConfig.plugins.clipboard.settings.protectSensitive===false,'protection saved through native adapter stub');
      check(fixtureConfig.plugins.clipboard.enabled===true,'history remains enabled');
      window.fixtureSaveFailure=true;button('清空旧列表并保存').click();await settled();
      check(fixtureConfig.plugins.clipboard.settings.excludedApps.length===1,'failed recovery leaves persisted exclusion intact');
      check(Boolean(button('清空旧列表并保存')),'failed save retains recovery action');
      window.fixtureSaveFailure=false;button('清空旧列表并保存').click();await settled();
      check(fixtureConfig.plugins.clipboard.settings.excludedApps.length===0,'legacy list cleared and saved');
      check(fixtureConfig.plugins.clipboard.settings.capturePaused===true,'recovery preserves explicit pause');
      check(!button('清空旧列表并保存'),'successful recovery hides action');
      toggle('暂停采集',false);await wait(30);toggle('敏感标记保护',true);await wait(30);
      check(fixtureConfig.plugins.clipboard.settings.capturePaused===true,'resume remains draft until saved');
      button('保存').click();await settled();
      check(fixtureConfig.plugins.clipboard.settings.capturePaused===false,'resume saved');
      check(fixtureConfig.plugins.clipboard.settings.protectSensitive===true,'protection restored on save');
    } else {
      const input=document.querySelector('#q');input.value='synthetic';input.dispatchEvent(new Event('input',{bubbles:true}));await wait(600);
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      check(document.body.textContent.includes('synthetic history'),'search renders isolated history');
    }
    const img=new Image();img.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK3cAAAAASUVORK5CYII=';
    await img.decode();check(img.naturalWidth===1,'managed data image allowed');
    const script=document.createElement('script');script.textContent='window.inlinePrivacyProbe=true';document.body.append(script);await wait(30);
    check(!window.inlinePrivacyProbe,'inline script blocked');
    let blocked=false;try{Function('return 1')();}catch{blocked=true;}check(blocked,'eval blocked');
    blocked=false;try{await fetch('https://blocked.invalid/');}catch{blocked=true;}check(blocked,'unlisted connection blocked');
    check(fixtureErrors.length===0,'no unexpected JS errors');
    output.textContent='PASS\n'+passed.join('\n');
  } catch(error) {output.textContent='FAIL '+error.message+'\n'+passed.join('\n');}
});
