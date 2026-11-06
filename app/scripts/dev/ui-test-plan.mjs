import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export function validatePlan(plan) {
  if(!Array.isArray(plan) || !plan.length || plan.length>100)throw Error('plan requires 1–100 steps');
  const operations=new Set(['inspect','read','click','fill','key','wait','screenshot']);
  for(const step of plan){
    if(!step || !operations.has(step.op))throw Error('unsupported plan operation');
    if(step.frames && (!Array.isArray(step.frames)||step.frames.length>8||step.frames.some(index=>!Number.isInteger(index)||index<0)))throw Error('invalid plan frame path');
    if(!['inspect','screenshot'].includes(step.op) && (!step.target || !['ref','css','role'].some(key=>typeof step.target[key]==='string' && step.target[key])))throw Error('plan step requires a target');
    if(step.timeout!==undefined && (!Number.isFinite(step.timeout)||step.timeout<=0||step.timeout>120000))throw Error('invalid plan timeout');
    if(step.op==='fill' && (typeof step.value!=='string'||step.value.length>16384))throw Error('invalid plan input');
  }
  return plan;
}

export async function runPlan(client,plan,directory) {
  validatePlan(plan);
  await mkdir(directory,{mode:0o700});
  const report={mode:'synthetic-dom',startedAt:new Date().toISOString(),steps:[],success:true};
  const reportFile=join(directory,'report.json');
  const save=()=>writeFile(reportFile,JSON.stringify(report,null,2),{mode:0o600});
  for(const [index,step] of plan.entries()){
    const entry={index,op:step.op,target:step.target,frames:step.frames||[]};
    report.steps.push(entry);
    try{
      entry.result=step.op==='screenshot'?await client.screenshot(join(directory,`step-${index}.png`)):await client.requestForPlan(step);
      entry.after=await client.inspect(entry.frames);
      entry.ok=true;
    }catch(error){
      entry.ok=false;entry.error=error.message;report.success=false;
      try {entry.screenshot=await client.screenshot(join(directory,'failure.png'));}catch {entry.screenshotUnavailable=true;}
      await save();break;
    }
    await save();
  }
  report.finishedAt=new Date().toISOString();await save();
  return {success:report.success,attemptedSteps:report.steps.length,completedSteps:report.steps.filter(step=>step.ok).length,report:reportFile};
}
