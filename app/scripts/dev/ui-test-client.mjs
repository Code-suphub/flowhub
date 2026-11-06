import {readFile,writeFile} from 'node:fs/promises';

export async function webdriver(endpoint,path,body,method=body===undefined?'GET':'POST') {
  const url=new URL(endpoint);
  if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password || url.pathname!=='/')throw Error('only a loopback test driver is allowed');
  const response=await fetch(`${url.origin}${path}`,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  if(!response.ok)throw Error(result.value?.message || `driver HTTP ${response.status}`);
  return result.value;
}

export class UITestClient {
  constructor(session){this.session=session;}
  static async open(file){return new UITestClient(JSON.parse(await readFile(file,'utf8')));}
  async execute(script,args=[]) { return webdriver(this.session.endpoint,`/session/${this.session.id}/execute/async`,{script,args}); }
  async request(request) {
    return this.execute(`const done=arguments[arguments.length-1];
      if(window.FlowHubUITest?.token!==arguments[0])return done({error:'test-instance-mismatch'});
      window.FlowHubUITest.request(arguments[1]).then(result=>done({result}),error=>done({error:String(error.message)}));`,[this.session.token,request]).then(value=>{
      if(value?.error)throw Error(value.error);return value.result;
    });
  }
  inspect(frames=[]){return this.request({op:'inspect',frames});}
  read(target,frames=[]){return this.request({op:'read',target,frames});}
  click(target,frames=[]){return this.request({op:'click',target,frames});}
  fill(target,value,frames=[]){return this.request({op:'fill',target,value,frames});}
  requestForPlan(step){return step.op==='wait'?this.wait(step.target,step):this.request(step);}
  async wait(target,{frames=[],text,enabled,absent=false,timeout=30000}={}) {
    const deadline=Date.now()+timeout;let last;
    do {
      try {const value=await this.read(target,frames);if(!absent && (enabled===undefined || value.disabled!==enabled) && (text===undefined || `${value.text}\n${value.value??''}`.includes(text)))return value;last='state-not-matched';}
      catch(error){if(absent && /^(expected-one-control: found 0|stale-reference:)/.test(error.message))return {absent:true};last=error.message;}
      await new Promise(resolve=>setTimeout(resolve,150));
    }while(Date.now()<deadline);
    throw Error(`wait-timeout: ${last}`);
  }
  async screenshot(file) {
    const value=await webdriver(this.session.endpoint,`/session/${this.session.id}/screenshot`);
    await writeFile(file,Buffer.from(value,'base64'),{mode:0o600});return {path:file};
  }
}
