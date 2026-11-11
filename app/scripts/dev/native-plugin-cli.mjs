import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';

export async function runPluginCli(args, {bundle=process.env.FLOWHUB_APP || '/Applications/FlowHub.app', run=promisify(execFile)}={}) {
  const validId=id=>typeof id==='string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
  if (!(args.length===1 && args[0]==='list' || args.length===2 && ['verify','migrate'].includes(args[0]) && validId(args[1]) || args.length===3 && args[0]==='migrate' && validId(args[1]) && args[2]==='--dry-run')) {
    throw Error('用法：plugin list | verify <id> | migrate <id> [--dry-run]');
  }
  // Older binaries treat unknown arguments as a launcher toggle. Check their
  // advertised capability before executing any native command.
  let supported=false;
  try { supported=(await run('/usr/libexec/PlistBuddy',['-c','Print FlowHubPluginCLIProtocol',join(bundle,'Contents/Info.plist')])).stdout.trim()==='1'; } catch {}
  if (!supported) throw Error('当前 FlowHub 安装版不支持插件管理 CLI，请先更新主程序；未启动旧版程序或操作桌面。');
  let output;
  try { output=(await run(join(bundle,'Contents/MacOS/flowhub-tauri'),['--plugin-cli',...args],{timeout:65000,maxBuffer:4*1024*1024})).stdout; }
  catch(error) {
    try { const response=JSON.parse(error.stdout);if(response.ok===false)throw Error(response.error || '插件 CLI 操作失败'); }
    catch(parsed) { if(parsed instanceof SyntaxError)throw Error('插件 CLI 连接失败，请确认 FlowHub 正在运行');throw parsed; }
    throw error;
  }
  let response;
  try { response=JSON.parse(output); } catch { throw Error('插件 CLI 返回了无效 JSON'); }
  if(response?.ok!==true || response.protocol!==1)throw Error(response?.error || '插件 CLI 协议不支持');
  return response;
}
