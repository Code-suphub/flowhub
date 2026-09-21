(() => {
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const bounded=(task,ms=10000)=>{
    let timer;return Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture-timeout')),ms);})]).finally(()=>clearTimeout(timer));
  };
  const buttons=[...document.querySelectorAll('[data-stress-run]')];
  const reportEl=document.querySelector('#stressReport');
  let busy=false;
  async function run(kind) {
    if(busy)return;
    busy=true;buttons.forEach(button=>{button.disabled=true;});
    reportEl.textContent='Running synthetic checks…';
    const fixture=window.FlowHubSearchFixture;
    let observer;
    try {
      if(!fixture || window.__TAURI__)throw new Error('fixture-unavailable');
      const bridge=await bounded(fixture.connected);await bounded(bridge.ready);
      if(!bridge.inspect().initialized)throw new Error('fixture-not-initialized');
      const results=document.querySelector('#results'),input=document.querySelector('#q');
      const scope=async id=>{
        const button=document.querySelector(`[data-scope="${id}"]`);
        if(!button)throw new Error('fixture-scope-unavailable');
        button.click();await frame();
      };
      const query=text=>{input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));};
      const settle=async()=>{
        await sleep(220);const deadline=performance.now()+10000;
        while(bridge.inspect().loading){if(performance.now()>deadline)throw new Error('fixture-timeout');await sleep(10);}
        await frame();
      };
      const seed=async(count,long=false,options={})=>{fixture.configure({count,long,...options});await bounded(bridge.reset());await frame();};
      // Prime through real pagination instead of injecting internal state.
      const prime=async(n,long=false)=>{
        await seed(n,long);await scope('clipboard');
        let pages=0;while(bridge.inspect().hasMore && pages++<110)await bounded(bridge.loadMore());
        await frame();if(bridge.inspect().loaded!==n)throw new Error('fixture-prime-incomplete');
      };
      let report={engine:navigator.userAgent};
      if(kind==='stress') {
        report.scopes=[];report.reopen=[];
        for(const n of [30,300,1000,3000]) {
          await prime(n);const times=[];
          for(let i=0;i<5;i++) {
            await scope('all');const start=performance.now();await scope('clipboard');
            void results.scrollHeight;times.push(performance.now()-start);
          }
          report.scopes.push({n,ms:times,domRows:results.querySelectorAll('.result').length,nodes:results.querySelectorAll('*').length});
          const start=performance.now();bridge.reopen();await frame();
          report.reopen.push({n,ms:performance.now()-start,rows:results.querySelectorAll('.result').length});
        }
        await prime(30,true);await scope('all');let start=performance.now();await scope('clipboard');
        report.longRecord={chars:140000,ms:performance.now()-start,domChars:results.textContent.length};
        for(const id of ['clipboard','app','web','memo']) {
          await seed(30);const start=performance.now();await scope(id);report.scopes.push({scope:id,n:30,ms:performance.now()-start});
        }
        await seed(0);fixture.configure({count:1,marker:'FAST_RESULT',sourceDelays:{app:900,clipboard:20}});
        let first=null;observer=new MutationObserver(()=>{if(results.textContent.includes('FAST_RESULT'))first??=performance.now();});
        observer.observe(results,{childList:true,subtree:true,characterData:true});
        start=performance.now();query('FAST_RESULT');await settle();
        report.slow={firstResultMs:first===null?null:first-start,allCompleteMs:performance.now()-start};
      } else if(kind==='paging') {
        await prime(3000);results.scrollTop=results.scrollHeight;results.dispatchEvent(new Event('scroll'));await frame();await frame();
        const atEnd=Number([...results.querySelectorAll('.result')].at(-1)?.dataset.i);
        bridge.select(1200);await frame();const keyboardVisible=!!results.querySelector('.result[data-i="1200"]');
        results.scrollTop=0;results.dispatchEvent(new Event('scroll'));await frame();await frame();
        const atStart=Number(results.querySelector('.result')?.dataset.i);
        await seed(3000);let pages=0,maxDOM=0;const start=performance.now();
        while(bridge.inspect().hasMore && pages<300) {
          await bounded(bridge.loadMore());await frame();pages++;
          maxDOM=Math.max(maxDOM,results.querySelectorAll('.result').length);
        }
        const {loaded,unique,hasMore}=bridge.inspect();
        report={...report,atEnd,atStart,keyboardVisible,pages,loaded,unique,hasMore,maxDOM,totalMs:performance.now()-start};
      } else if(kind==='timing') {
        await seed(0);fixture.configure({count:1,marker:'TIMING_RESULT',sourceDelays:{app:900,clipboard:20}});
        window.flowhubSearchTiming.enable(true);window.flowhubSearchTiming.reset();query('TIMING_RESULT');await settle();
        report={...report,runs:window.flowhubSearchTiming.report()};
      } else throw new Error('fixture-check-unknown');
      reportEl.textContent=JSON.stringify(report,null,2);return report;
    } catch(error) {
      const report={error:String(error.message || 'fixture-failed')};reportEl.textContent=JSON.stringify(report);return report;
    } finally {
      observer?.disconnect();
      try {fixture?.configure();if(fixture?.bridge())await bounded(fixture.bridge().reset());} catch {}
      window.flowhubSearchTiming?.enable(false);
      busy=false;buttons.forEach(button=>{button.disabled=false;});
    }
  }
  for(const button of buttons)button.addEventListener('click',()=>{void run(button.dataset.stressRun);});
})();
