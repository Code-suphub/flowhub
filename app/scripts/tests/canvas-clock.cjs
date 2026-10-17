/** Deterministic host timer fixture. Short React tasks and animation frames stay real. */
exports.installCanvasClock = function(w) {
  let now=0,id=0;
  const tasks=new Map(),realSet=w.setTimeout.bind(w),realClear=w.clearTimeout.bind(w);
  const add=(callback,ms,interval)=>{const key=--id;tasks.set(key,{callback,ms,interval,at:now+ms});return key;};
  w.setTimeout=(callback,ms=0,...args)=>ms<20?realSet(callback,ms,...args):add(()=>callback(...args),ms,false);
  w.clearTimeout=key=>{tasks.delete(key);if(key>=0)realClear(key);};
  w.setInterval=(callback,ms,...args)=>add(()=>callback(...args),ms,true);
  w.clearInterval=key=>tasks.delete(key);
  return {
    async advance(ms) {
      const end=now+ms;let steps=0;
      while(true) {
        const next=[...tasks].filter(([,task])=>task.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next)break;if(++steps>10000)throw Error('virtual clock did not settle');
        const [key,task]=next;now=task.at;
        if(task.interval)task.at+=task.ms;else tasks.delete(key);
        task.callback();await new Promise(setImmediate);
      }
      now=end;await new Promise(setImmediate);
    },
    pending:()=>[...tasks.values()].map(task=>task.ms).sort((a,b)=>a-b),
  };
};
