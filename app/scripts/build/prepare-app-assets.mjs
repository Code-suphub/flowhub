import {spawnSync} from 'node:child_process';

const environment={...process.env};
for(const key of [
  'APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID',
  'APPLE_API_KEY','APPLE_API_ISSUER','APPLE_API_KEY_PATH','TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD','FLOWHUB_MACOS_CERTIFICATE','FLOWHUB_MACOS_CERTIFICATE_PASSWORD'
])delete environment[key];

function run(command,args){
  const result=spawnSync(command,args,{stdio:'inherit',env:environment});
  if(result.error)throw result.error;
  if((result.status??1)!==0)process.exit(result.status??1);
}

run('pnpm',['run','build:ui']);
run(process.execPath,['scripts/build/build-resource-monitor-helper.mjs']);
