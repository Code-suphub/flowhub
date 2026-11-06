import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runPlan,validatePlan} from '../dev/ui-test-plan.mjs';

test('invalid plans cannot dispatch arbitrary code or unbounded actions',()=>{
  for(const plan of [[],[{op:'execute',script:'private'}],[{op:'click'}],[{op:'inspect',frames:[-1]}],[{op:'wait',target:{css:'button'},timeout:Infinity}]])assert.throws(()=>validatePlan(plan));
});
test('plan stops on failure and preserves evidence without logging submitted field contents',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fh-ui-plan-'));let calls=0;
  const client={
    async requestForPlan(step){calls++;if(step.op==='click')throw Error('control-disabled');return {dispatched:true};},
    async inspect(){return {controls:[],mode:'synthetic-dom'};},
    async screenshot(path){return {path};}
  };
  try{
    const result=await runPlan(client,[{op:'fill',target:{role:'textbox'},value:'private-draft'},{op:'click',target:{role:'button'}},{op:'click',target:{role:'button'}}],join(root,'report'));
    assert.equal(result.success,false);assert.equal(calls,2);assert.equal(result.completedSteps,1);assert.equal(result.attemptedSteps,2);
    const saved=await readFile(result.report,'utf8');assert.doesNotMatch(saved,/private-draft/);
    const report=JSON.parse(saved);assert.equal(report.steps[1].error,'control-disabled');assert.match(report.steps[1].screenshot.path,/failure\.png$/);
  }finally{await rm(root,{recursive:true});}
});
