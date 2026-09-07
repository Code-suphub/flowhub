const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const read=file=>fs.readFileSync(`${__dirname}/../ui/${file}`,'utf8');
(async()=>{
 let finish6; const updates=[];
 const ctx=vm.createContext({window:{},setTimeout,clearTimeout,AbortController,fetch:async url=>{
   if(url.includes('api6')) return new Promise(resolve=>finish6=()=>resolve({ok:false,status:503}));
   return {ok:true,json:async()=>({ip:'203.0.113.1'})};
 }});
 vm.runInContext(read('public-ip.js'),ctx);
 const pending=ctx.window.FlowHubLookupPublicIp(value=>updates.push(value));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(updates[0].ipv4,'203.0.113.1');assert(updates[0].pending.includes('ipv6'));
 finish6();const result=await pending;assert.equal(result.ipv4,'203.0.113.1');assert(result.errors.ipv6);assert.equal(result.pending.length,0);
 for(const file of ['tool-registry.js','local-ip-tool.js'])vm.runInContext(read(file),ctx);
 let query='ip',copied='',resolveLookup;
 const context={query,queryNow:()=>query,enabled:()=>true,render(){},status(){},copy:async text=>copied=text,api:{lookupLocalIp:()=>new Promise(resolve=>resolveLookup=resolve)}};
 const registry=ctx.window.FlowHubTools;
 const refresh=registry.action('localIp','refresh',{},context);
 assert(registry.render(registry.suggestions(context)[0],{esc:String,index:0,active:true}).includes('正在查询'));
 query='something else';registry.queryChanged({...context,query});resolveLookup(result);await refresh;
 assert.equal(registry.suggestions({...context,query}).length,0);
 query='公网 ip';context.query=query;context.api.lookupLocalIp=async()=>result;
 await registry.action('localIp','refresh',{},context);
 await registry.choose(registry.suggestions(context)[0],context);assert(copied.includes('203.0.113.1'));
 await registry.action('localIp','command',{},context);assert(copied.includes('--max-time 6'));
 // A failed primary provider falls back without hiding the other family.
 const requested=[];
 ctx.fetch=async url=>{requested.push(url);if(url.includes('ipify'))throw new Error('offline');return {ok:true,text:async()=>url.includes('4.ident')?'203.0.113.2':'2001:db8::2'};};
 const fallback=await ctx.window.FlowHubLookupPublicIp();assert.equal(fallback.ipv4,'203.0.113.2');assert.equal(fallback.ipv6,'2001:db8::2');assert.equal(requested.length,4);
 let abortCount=0;
 ctx.fetch=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{abortCount++;const error=new Error('aborted');error.name='AbortError';reject(error);},{once:true}));
 const controller=new AbortController();
 const aborted=ctx.window.FlowHubLookupPublicIp(()=>assert.fail('cancelled lookup published'),{signal:controller.signal});
 controller.abort();await assert.rejects(aborted,{name:'AbortError'});assert.equal(abortCount,2);
 // Both providers time out and settle; timers are shortened only in this fixture.
 ctx.setTimeout=callback=>setTimeout(callback,10);
 const beforeTimeout=abortCount;
 const timedOut=await ctx.window.FlowHubLookupPublicIp();
 assert.equal(abortCount-beforeTimeout,4);assert.equal(timedOut.pending.length,0);assert(timedOut.errors.ipv4.includes('超时'));
 // Replacing the query actively aborts the request, not just its UI publication.
 let capturedSignal;
 context.api.lookupLocalIp=async(cb,options)=>{capturedSignal=options.signal;return result;};
 await registry.action('localIp','refresh',{},context);
 registry.queryChanged({...context,query:'unrelated'});assert(capturedSignal.aborted);
 console.log('PASS: progressive IP results, partial failure, loading, stale response suppression, address/command copy, fallback, cancellation, timeout');
})().catch(error=>{console.error(error);process.exitCode=1});
