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
 console.log('PASS: progressive IP results, partial failure, loading, stale response suppression, address/command copy');
})().catch(error=>{console.error(error);process.exitCode=1});
