import {chmodSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const app=resolve(new URL('../..',import.meta.url).pathname);
const tauriConfig=JSON.parse(readFileSync(join(app,'src-tauri','tauri.conf.json'),'utf8'));
const root=join(app,'src-tauri','target','resource-monitor-helper');
const daemon=join(root,'daemon');
rmSync(root,{recursive:true,force:true});
mkdirSync(root,{recursive:true});

const run=(command,args)=>{
  const result=spawnSync(command,args,{cwd:app,stdio:'inherit'});
  if(result.error)throw result.error;
  if((result.status??1)!==0)throw new Error(`${command} failed (${result.status})`);
};

if(process.platform==='darwin'){
  const source=join(app,'scripts','privileged-monitor');
  run('swiftc',['-parse-as-library',join(source,'daemon.swift'),join(source,'control.swift'),'-o',daemon]);
  chmodSync(daemon,0o755);

  // The admin-authorized installer supports ad-hoc local builds. Developer ID
  // is optional here and remains available for signed/notarized releases.
  const configuredIdentity=tauriConfig.bundle?.macOS?.signingIdentity;
  const environmentIdentity=process.env.APPLE_SIGNING_IDENTITY;
  if(environmentIdentity!==undefined&&!environmentIdentity.trim()){
    throw new Error('APPLE_SIGNING_IDENTITY is set but empty.');
  }
  if(process.env.APPLE_CERTIFICATE&&!environmentIdentity){
    throw new Error('APPLE_SIGNING_IDENTITY must be set when APPLE_CERTIFICATE is used, so the app and daemon use the same identity.');
  }
  const identity=environmentIdentity??configuredIdentity??'-';
  if(typeof identity!=='string'||!identity.trim()){
    throw new Error('The macOS signing identity must be non-empty. Use "-" for a free local ad-hoc build.');
  }
  try{
    run('codesign',['--force','--sign',identity,'--options','runtime',daemon]);
  }catch(error){
    throw new Error(`Could not sign the resource-monitor daemon with "${identity}". Ensure this identity is valid and is also used by Tauri for the app.`,{cause:error});
  }
  run(daemon,['--self-check']);
  run(daemon,['--control-self-check']);
}else{
  writeFileSync(daemon,'#!/bin/sh\nexit 1\n');
  chmodSync(daemon,0o755);
}
