import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('privileged control verifies socket audit token, signed client and parent host; signal policy is restrictive',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'flowhub-control-')));
 try {
  const host=join(root,'FlowHub.app/Contents/MacOS/flowhub-tauri'),client=join(root,'flowhub-resource-monitor');mkdirSync(join(root,'FlowHub.app/Contents/MacOS'),{recursive:true});
  const source=join(root,'client.swift');
  writeFileSync(source,`import Foundation\nimport Darwin\nlet fd=socket(AF_UNIX,SOCK_STREAM,0)\nvar a=sockaddr_un();a.sun_family=sa_family_t(AF_UNIX);a.sun_len=UInt8(MemoryLayout<sockaddr_un>.size)\nlet p=Array(CommandLine.arguments[1].utf8CString).map(UInt8.init(bitPattern:))\nwithUnsafeMutableBytes(of:&a.sun_path){$0.copyBytes(from:p)}\nlet result=withUnsafePointer(to:&a){$0.withMemoryRebound(to:sockaddr.self,capacity:1){connect(fd,$0,socklen_t(MemoryLayout<sockaddr_un>.size))}}\nguard result==0 else{exit(1)}\nvar byte:UInt8=0;_ = read(fd,&byte,1);close(fd)\n`);
  execFileSync('swiftc',[source,'-o',client],{stdio:'pipe',timeout:60000});
  const directory=fileURLToPath(new URL('../privileged-monitor/',import.meta.url));
  execFileSync('swiftc',['-D','FLOWHUB_CONTROL_TESTS','-parse-as-library',...['daemon.swift','control.swift','services.swift','control-tests.swift'].map(file=>join(directory,file)),'-o',host],{stdio:'pipe',timeout:60000});
  assert.match(execFileSync(host,['--auth-self-check',client],{encoding:'utf8',timeout:10000}),/checks passed/);
  assert.match(execFileSync(host,['--control-self-check'],{encoding:'utf8',timeout:10000}),/checks passed/);
  assert.match(execFileSync(host,['--services-self-check'],{encoding:'utf8',timeout:10000}),/checks passed/);
  // Headless macOS sessions may not have a GUI launchd domain.
  if(spawnSync('/bin/launchctl',['print',`gui/${process.getuid()}`],{stdio:'ignore'}).status===0)assert.match(execFileSync(host,['--services-transport-self-check'],{encoding:'utf8',timeout:60000}),/checks passed/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
