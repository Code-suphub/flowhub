import {chmodSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const app=resolve(new URL('../..',import.meta.url).pathname);
const root=join(app,'src-tauri','target','resource-monitor-helper');
const daemon=join(root,'daemon');
const plist=join(root,'cn.ac.camellia.flowhub.resource-monitor.plist');
rmSync(root,{recursive:true,force:true});
mkdirSync(root,{recursive:true});

const run=(command,args)=>{
  const result=spawnSync(command,args,{cwd:app,stdio:'inherit'});
  if(result.error)throw result.error;
  if((result.status??1)!==0)throw new Error(`${command} failed (${result.status})`);
};

if(process.platform==='darwin'){
  const source=join(app,'scripts','privileged-monitor');
  run('swiftc',['-parse-as-library',join(source,'daemon.swift'),'-o',daemon]);
  const service=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>cn.ac.camellia.flowhub.resource-monitor</string>
<key>BundleProgram</key><string>Contents/Resources/FlowHubResourceMonitorHelper/daemon</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`;
  writeFileSync(plist,service);
  chmodSync(daemon,0o700);

  // Sign the daemon before Tauri signs the containing application.
  const identities=spawnSync('security',['find-identity','-v','-p','codesigning'],{encoding:'utf8'}).stdout??'';
  const preferred=process.env.APPLE_SIGNING_IDENTITY??process.env.FLOWHUB_MACOS_SIGNING_IDENTITY??'FlowHub Local Development';
  const available=[...identities.matchAll(/"([^"]+)"/g)].map(match=>match[1]);
  const identity=available.find(item=>item===preferred||item.includes(preferred))??'-';
  run('codesign',['--force','--sign',identity,'--options','runtime',daemon]);
}else{
  writeFileSync(daemon,'#!/bin/sh\nexit 1\n');
  writeFileSync(plist,'<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n');
  chmodSync(daemon,0o700);
}
