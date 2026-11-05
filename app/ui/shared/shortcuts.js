// Shared by the React settings recorder and the classic launcher event handler.
(function (root) {
  if (root.FlowHubShortcuts) {
    if (typeof module !== 'undefined') module.exports = root.FlowHubShortcuts;
    return;
  }
  const modifiers = ['ctrl', 'alt', 'shift', 'meta'];
  const aliases = { control:'ctrl', option:'alt', command:'meta', cmd:'meta', super:'meta', os:'meta' };
  const primaryAliases = ['commandorcontrol', 'commandorctrl', 'cmdorcontrol', 'cmdorctrl'];
  const punctuation = { Backquote:'`', Minus:'-', Equal:'=', BracketLeft:'[', BracketRight:']', Backslash:'\\', Semicolon:';', Quote:"'", Comma:',', Period:'.', Slash:'/' };
  const media = ['AudioVolumeDown','AudioVolumeUp','AudioVolumeMute','MediaPlay','MediaPause','MediaPlayPause','MediaStop','MediaTrackNext','MediaTrackPrevious'];
  const named = ['Space','Tab','Enter','Escape','Backspace','Delete','CapsLock','PrintScreen','NumLock','Insert','Home','End','PageUp','PageDown','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',...media,
    'NumpadAdd','NumpadSubtract','NumpadMultiply','NumpadDivide','NumpadDecimal','NumpadEnter','NumpadEqual'];
  const keyNames = Object.fromEntries([...named, ...Object.keys(punctuation)].map(key => [key.toLowerCase(),key]));
  const symbolKeys = Object.fromEntries(Object.entries(punctuation).map(([key,value]) => [value,key.toLowerCase()]));
  const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key)?object[key]:undefined;
  function isMac() { const n=root.navigator; return /Mac|iPhone|iPad/.test(n?.userAgentData?.platform || n?.platform || n?.userAgent || ''); }
  function keyName(key) {
    key=key.toLowerCase();
    if (/^key[a-z]$/.test(key)) return key.slice(3);
    if (/^digit\d$/.test(key)) return key.slice(5);
    if (/^num\d$/.test(key)) return 'numpad'+key.slice(3);
    const num=key.match(/^num(?:pad)?(add|plus|decimal|divide|enter|equal|multiply|subtract)$/);
    if (num) return 'numpad'+(num[1]==='plus'?'add':num[1]);
    return (own({esc:'escape',up:'arrowup',down:'arrowdown',left:'arrowleft',right:'arrowright',volumeup:'audiovolumeup',volumedown:'audiovolumedown',volumemute:'audiovolumemute',mediatrackprev:'mediatrackprevious'},key) || own(symbolKeys,key) || key);
  }
  function parts(text,mac) {
    return String(text || '').split('+').map(part => {
      const key=part.trim().toLowerCase();
      return primaryAliases.includes(key) ? (mac?'meta':'ctrl') : own(aliases,key) || keyName(key);
    });
  }
  function canonical(text,mac=isMac()) { const tokens=parts(text,mac); return tokens.filter((key,index)=>!modifiers.includes(key)||tokens.indexOf(key)===index).sort().join('+'); }
  function eventKey(event) {
    const code=event.code || '';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1\d|2[0-4])$/.test(code) || /^Numpad\d$/.test(code)) return code;
    if (named.includes(code) || own(punctuation,code)!==undefined) return code;
    if (code) return null; // Don't turn an unsupported physical key into another key.
    if (/^[a-z0-9]$/i.test(event.key)) return event.key.toUpperCase();
    if (event.key===' ') return 'Space';
    const key=keyName(event.key || '');
    return own(keyNames,key) || (/^f([1-9]|1\d|2[0-4])$/.test(key)?key.toUpperCase():null);
  }
  function capture(event,allowBare=false,mac=isMac()) {
    if (event.isComposing || event.key==='Process' || event.keyCode===229 || event.repeat || ['Shift','Control','Alt','Meta','OS','Super','AltGraph','Fn'].includes(event.key)) return null;
    if (!mac && event.getModifierState?.('AltGraph')) return {error:'暂不支持 AltGraph 组合，请换一组快捷键'};
    const key=eventKey(event);
    if (!key) return {error:'该按键暂不支持，请换一组快捷键'};
    if (mac && !allowBare && (/^F(2[1-4])$/.test(key) || media.includes(key))) return {error:'macOS 全局快捷键暂不支持该按键，请换一组快捷键'};
    const mods=[event.ctrlKey&&'Ctrl',event.altKey&&'Alt',event.shiftKey&&'Shift',event.metaKey&&(mac?'Command':'Super')].filter(Boolean);
    if (!mods.length && !(allowBare && /^(?:\d|Numpad\d|F([1-9]|1\d|2[0-4]))$/.test(key))) return {error:'请使用组合键'};
    return {value:[...mods,key].join('+')};
  }
  function matches(event,shortcut,mac=isMac()) {
    if (event.isComposing || event.key==='Process' || event.keyCode===229) return false;
    const tokens=parts(shortcut,mac),keys=tokens.filter(key=>!modifiers.includes(key));
    if (tokens.some(key=>!key) || keys.length!==1) return false;
    const flags=[event.ctrlKey,event.altKey,event.shiftKey,event.metaKey];
    if (modifiers.some((modifier,index)=>!!flags[index]!==tokens.includes(modifier))) return false;
    const key=eventKey(event);
    return !!key && keyName(key)===keys[0];
  }
  function format(text,mac=isMac()) {
    if (!text) return '';
    const tokens=parts(text,mac),labels=mac?{ctrl:'⌃',alt:'⌥',shift:'⇧',meta:'⌘'}:{ctrl:'Ctrl',alt:'Alt',shift:'Shift',meta:/Win/.test(root.navigator?.platform || '')?'Win':'Super'};
    const keys=tokens.filter(key=>!modifiers.includes(key));
    const pretty=key=>(own({arrowup:'↑',arrowdown:'↓',arrowleft:'←',arrowright:'→'},key) || own(punctuation,own(keyNames,key)) || own(keyNames,key) || (/^numpad\d$/.test(key)?'Num '+key.slice(-1):key.toUpperCase()));
    return [...modifiers.filter(key=>tokens.includes(key)).map(key=>labels[key]),...keys.map(pretty)].join(' + ');
  }
  const api={isMac,canonical,capture,matches,format};
  root.FlowHubShortcuts=api;
  if (typeof module !== 'undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
