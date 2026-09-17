document.querySelector('#privacyChecks').addEventListener('click',async()=>{
  const output=document.querySelector('#privacyReport');const passed=[];
  const check=(value,label)=>{if(!value)throw Error(label);passed.push(label);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const change=(id,value)=>{const node=document.getElementById(id);node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));};
  try {
    if(location.pathname.includes('settings')) {
      check(!document.querySelector('#clipboardExcludedApps'),'selective exclusions have no editor');
      check(!document.querySelector('#clipboardLegacyExclusions').hidden,'imported exclusion shows recovery notice');
      change('clipboardCapturePaused','true');
      check(document.querySelector('#clipboardStatusValue').textContent.includes('待保存：暂停采集'),'pause shows draft state');
      document.querySelector('#saveBtn').click();await wait(400);
      check(fixtureConfig.plugins.clipboard.settings.capturePaused===true,'pause saved through native adapter stub');
      check(fixtureConfig.plugins.clipboard.enabled===true,'history remains enabled');
      document.querySelector('[data-action="clear-clipboard-exclusions"]').click();await wait(400);
      check(fixtureConfig.plugins.clipboard.settings.excludedApps.length===0,'legacy list cleared and saved');
      check(fixtureConfig.plugins.clipboard.settings.capturePaused===true,'recovery preserves explicit pause');
      check(document.querySelector('#clipboardLegacyExclusions').hidden,'successful recovery hides notice');
      change('clipboardCapturePaused','false');change('clipboardProtectSensitive','true');
      document.querySelector('#saveBtn').click();await wait(400);
      check(fixtureConfig.plugins.clipboard.settings.capturePaused===false,'resume saved');
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
