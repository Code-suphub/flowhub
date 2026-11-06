// Injected into every frame by the feature-gated test binary, never a UI asset.
(() => {
  'use strict';
  const token = __FLOWHUB_UI_TEST_TOKEN__;
  const pid = __FLOWHUB_UI_TEST_PID__;
  const channel = 'flowhub-ui-test-v1';
  const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const refs = new Map(), ids = new WeakMap();
  let sequence = 0;
  const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const role = el => el.getAttribute('role') || ({ BUTTON:'button', TEXTAREA:'textbox', SELECT:'combobox', A:'link', IFRAME:'frame' }[el.tagName]) || (el.tagName === 'INPUT' ? ['checkbox','radio'].includes(el.type) ? el.type : 'textbox' : '');
  const name = el => clean(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') || el.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.textContent || el.title);
  const visible = el => {
    const style = getComputedStyle(el);
    return el.isConnected && !el.closest('[hidden],[inert],[aria-hidden="true"]') && style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
  };
  const disabled = el => el.matches(':disabled') || !!el.closest('[aria-disabled="true"],[inert]');
  function ref(el) {
    if (!ids.has(el)) { const id = `${generation}:${++sequence}`; ids.set(el,id); refs.set(id,el); }
    return ids.get(el);
  }
  function find(target = {}) {
    if (target.ref) {
      const el = refs.get(target.ref);
      if (!el?.isConnected) throw Error('stale-reference: inspect the current page again');
      return el;
    }
    if (!target.css && !target.role) throw Error('a ref, css selector, or role is required');
    const candidates = [...document.querySelectorAll(target.css || 'button,input,textarea,select,a,[role]')]
      .filter(el => visible(el) && (!target.role || role(el) === target.role) && (target.name === undefined || name(el) === target.name));
    if (candidates.length !== 1) throw Error(`expected-one-control: found ${candidates.length}`);
    return candidates[0];
  }
  function control(el) {
    return { ref:ref(el),role:role(el),name:name(el),disabled:disabled(el),focused:document.activeElement===el,selected:el.hasAttribute('aria-selected')?el.getAttribute('aria-selected')==='true':undefined,checked:el.matches('input[type=checkbox],input[type=radio]')?el.checked:undefined };
  }
  function available(el) {
    if (!visible(el)) throw Error('control-not-visible');
    if (disabled(el)) throw Error('control-disabled');
    const modal = [...document.querySelectorAll('dialog[open],[aria-modal="true"]')].filter(visible).at(-1);
    if (modal && !modal.contains(el)) throw Error('control-blocked-by-modal');
  }
  function perform(request) {
    const {op,target} = request;
    if (op === 'inspect') {
      for (const [id,el] of refs) if (!el.isConnected) refs.delete(id);
      return {mode:'synthetic-dom',pid,generation,readyState:document.readyState,url:location.href,title:document.title,
        controls:[...document.querySelectorAll('button,input,textarea,select,a,[role=button],[role=tab],[role=combobox]')].filter(visible).slice(0,300).map(control),
        frames:[...document.querySelectorAll('iframe')].map((el,index)=>({index,title:el.title,src:el.getAttribute('src'),sandbox:el.getAttribute('sandbox')})),
        alerts:[...document.querySelectorAll('[role=alert]')].filter(visible).map(el=>clean(el.textContent)),
        dialogs:[...document.querySelectorAll('dialog[open],[role=dialog]')].filter(visible).map(name)};
    }
    const el = find(target);
    if (op === 'read') {
      if (el.matches('input[type=password]')) throw Error('password-read-refused');
      return { ...control(el),text:String(el.innerText ?? el.textContent ?? '').slice(0,16000),value:'value' in el?String(el.value).slice(0,16000):undefined };
    }
    available(el);
    if (op === 'click') { el.scrollIntoView({block:'center',inline:'center'}); el.focus({preventScroll:true}); el.click(); }
    else if (op === 'fill') {
      if (!el.matches('input,textarea') || el.readOnly || el.type === 'password') throw Error('control-not-editable');
      const value = String(request.value ?? '');
      if (value.length > 16384) throw Error('input-too-long');
      el.focus({preventScroll:true});
      const prototype = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,value);
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    } else if (op === 'key') {
      if (!['Enter','Escape','Tab','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(request.key)) throw Error('unsupported-key');
      el.focus({preventScroll:true});
      const options={key:request.key,code:request.key,bubbles:true,cancelable:true,shiftKey:!!request.shift};
      el.dispatchEvent(new KeyboardEvent('keydown',options)); el.dispatchEvent(new KeyboardEvent('keyup',options));
    } else throw Error('unsupported-operation');
    return {dispatched:true,mode:'synthetic-dom',trusted:false,target:{role:role(el),name:name(el)}};
  }
  async function dispatch(request) {
    if (Array.isArray(request.frames) && request.frames.length) {
      const [index,...remaining] = request.frames;
      const frame = document.querySelectorAll('iframe')[index];
      if (!Number.isInteger(index) || index < 0 || !frame?.contentWindow) throw Error('frame-not-found');
      const child = frame.contentWindow, id = `${generation}:request:${++sequence}`;
      return new Promise((resolve,reject) => {
        const timer = setTimeout(()=>finish(Error('frame-response-timeout')),4000);
        function finish(error,value) { clearTimeout(timer);window.removeEventListener('message',receive);error?reject(error):resolve(value); }
        function receive(event) {
          const data=event.data;
          if(event.source!==child || data?.channel!==channel || data.token!==token || data.id!==id || data.type!=='response')return;
          data.error?finish(Error(data.error)):finish(null,data.result);
        }
        window.addEventListener('message',receive);
        child.postMessage({channel,token,id,type:'request',request:{...request,frames:remaining}},'*');
      });
    }
    return perform(request);
  }
  window.addEventListener('message',event => {
    const data=event.data;
    if(window===window.top || event.source!==window.parent || data?.channel!==channel || data.token!==token || data.type!=='request')return;
    void dispatch(data.request).then(result=>event.source.postMessage({channel,token,id:data.id,type:'response',result},'*'),error=>event.source.postMessage({channel,token,id:data.id,type:'response',error:String(error.message)},'*'));
  });
  Object.defineProperty(window,'FlowHubUITest',{value:Object.freeze({token,request:dispatch}),configurable:false});
})();
