#!/usr/bin/env node
// The design library is independent of the native application's runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const allowedTypes = new Set(['box', 'vbox', 'hbox', 'page-section', 'text', 'button', 'input', 'password', 'textarea', 'img', 'component']);
export function normalizePresentation(node) {
  if(typeof node!=='object'||!node)return node;
  const display=node.styles?.display;
  if(display==='grid'){
    // Plasmic's element importer treats gap as one value and maps atomic gaps
    // to flex-only properties. Preserve measured grid gutters in the tracks;
    // the captured children keep their original widths/heights inside them.
    const styles=node.styles;
    const gapParts=String(styles.gap??'0px').trim().split(/\s+/);
    const row=styles.rowGap??gapParts[0];
    const column=styles.columnGap??gapParts[1]??gapParts[0];
    const gap=value=>value==='normal'?0:/^\d+(?:\.\d+)?px$/.test(value)?parseFloat(value):null;
    const addGutter=(key,value)=>{
      if(styles[key]==null&&value===0)return undefined;
      const tracks=String(styles[key]??'').trim().split(/\s+/);
      if(value===null||!tracks.every(track=>/^\d+(?:\.\d+)?px$/.test(track)))return null;
      return tracks.map((track,index)=>`${parseFloat(track)+(index<tracks.length-1?value:0)}px`).join(' ');
    };
    const rows=addGutter('gridTemplateRows',gap(row)),columns=addGutter('gridTemplateColumns',gap(column));
    if(rows!==null&&columns!==null){
      if(rows!==undefined)styles.gridTemplateRows=rows;
      if(columns!==undefined)styles.gridTemplateColumns=columns;
      styles.gap='0px';delete styles.rowGap;delete styles.columnGap;
    }
  }
  // COL / COLGROUP influence a browser table's layout without occupying a
  // normal-flow box. Their computed rectangles must not become content boxes.
  if(display==='table-column'||display==='table-column-group'||display==='table-cell'&&node.styles.height==='0px')return null;
  if(display==='table-cell')node.styles.display='block';
  // A text link's measured width depends on the source platform's font. Let
  // its text size itself after import so names such as Codex stay on one line.
  if(node.type==='text'&&node.tag==='button'&&node.styles?.overflowWrap==='anywhere')node.styles.width='auto';
  if(node.children!=null){
    const children=(Array.isArray(node.children)?node.children:[node.children]).map(normalizePresentation).filter(child=>child!==null);
    node.children=children;
  }
  return node;
}
export function validateLibrary(library) {
  if (library.schema !== 1 || library.projectId !== 'rKroot8WmpiogJg8366SaB') throw new Error('Expected the dedicated FlowHub design project.');
  const names = new Set();
  const paths = new Set();
  let nodes = 0;
  const visit = (node, owner) => {
    nodes++;
    if (typeof node === 'string') return;
    if (!node || !allowedTypes.has(node.type)) throw new Error(`Invalid element in ${owner}.`);
    if (node.type === 'component' && !names.has(node.name)) throw new Error(`Unknown or forward component reference: ${node.name}.`);
    if (node.type === 'img' && !/^data:image\/(?:png|jpeg|webp|svg\+xml)[;,]/.test(node.src ?? '')) throw new Error(`Use a reviewed, embedded image in ${owner}.`);
    for (const [key, value] of Object.entries(node.attrs ?? {})) {
      if (/^on/i.test(key) || /javascript:/i.test(String(value))) throw new Error(`Executable attribute in ${owner}.`);
      if (key === 'href' && !String(value).startsWith('/')) throw new Error(`Only design-library navigation is allowed in ${owner}.`);
    }
    for (const [key, value] of Object.entries(node.styles ?? {})) {
      if (key === 'border' || /^border(?:Top|Bottom|Left|Right)$/.test(key)) throw new Error(`Expand border shorthand in ${owner}.`);
      if (/url\(/i.test(String(value))) throw new Error(`External CSS assets are not allowed in ${owner}.`);
    }
    const children = node.children == null ? [] : Array.isArray(node.children) ? node.children : [node.children];
    children.forEach(child => visit(child, owner));
    for (const prop of Object.values(node.props ?? {})) {
      if (Array.isArray(prop)) prop.forEach(child => typeof child === 'object' && child?.type !== 'json' && visit(child, owner));
      else if (prop && typeof prop === 'object' && prop.type && prop.type !== 'json') visit(prop, owner);
    }
  };
  for (const component of library.components ?? []) {
    if (!component.name || names.has(component.name)) throw new Error(`Duplicate or empty component: ${component.name}.`);
    if (component.path && (!component.path.startsWith('/') || paths.has(component.path))) throw new Error(`Duplicate or invalid page path: ${component.path}.`);
    visit(component.body, component.name);
    names.add(component.name);
    if (component.path) paths.add(component.path);
  }
  if (!names.size) throw new Error('The library has no components.');
  return { components: names.size, pages: paths.size, nodes };
}

export function bundleDetails(response) {
  const bundle = typeof response.rev?.data === 'string' ? JSON.parse(response.rev.data) : response.rev?.data;
  if (!bundle?.map) throw new Error('The remote project has no readable design bundle.');
  const objects = Object.values(bundle.map);
  return {
    revision: response.rev.revision,
    components: objects.filter(o => o.__type === 'Component').map(o => ({ name: o.name, uuid: o.uuid })),
    tokens: objects.filter(o => o.__type === 'StyleToken').map(o => ({ name: o.name, uuid: o.uuid, value: o.value })),
    nodes: objects.filter(o => ['TplTag', 'TplComponent', 'TplSlot'].includes(o.__type)).length
  };
}

export function substituteTokens(body, tokens) {
  const ids = new Map(tokens.map(token => [token.name, token.uuid]));
  return JSON.parse(JSON.stringify(body).replace(/\$token\(([^)]+)\)/g, (_, name) => {
    const id = ids.get(name);
    if (!id) throw new Error(`Missing design token: ${name}.`);
    return `var(--token-${id})`;
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const known = new Set(['--apply', '--update-existing', '--auth', '--receipt', '--library']);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
    if (['--auth', '--receipt', '--library'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}.`);
      i++;
    }
  }
  const libraryPath=value('--library');
  if(!libraryPath){
    if(args.includes('--apply'))throw new Error('Pass --library with a reviewed public-fixture export; production application data is not an import source.');
    const catalog=JSON.parse(await fs.readFile(path.join(root,'project.json'),'utf8'));
    console.log(JSON.stringify({mode:'catalog',projectId:catalog.projectId,components:catalog.components.length,pages:catalog.components.filter(component=>component.path).length}));
    return;
  }
  const library = JSON.parse(await fs.readFile(libraryPath, 'utf8'));
  const counts = validateLibrary(library);
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ mode: 'local-plan', projectId: library.projectId, ...counts }));
    return;
  }
  const authPath = value('--auth') ?? process.env.PLASMIC_AUTH_FILE;
  if (!authPath) throw new Error('Set PLASMIC_AUTH_FILE or pass --auth with an existing private Plasmic auth file.');
  const auth = JSON.parse(await fs.readFile(authPath, 'utf8'));
  if (auth.host !== 'https://studio.plasmic.app' || !auth.user || !auth.token) throw new Error('Expected an authenticated official Plasmic account.');
  const receiptPath = value('--receipt') ?? path.join(os.homedir(), '.local/state/flowhub-plasmic/import-receipt.json');
  const receipt = await fs.readFile(receiptPath, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const request = async (method, body) => {
    const response = await fetch(`${auth.host}/api/v1/projects/${library.projectId}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-plasmic-api-user': auth.user, 'x-plasmic-api-token': auth.token },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90_000)
    });
    if (!response.ok) throw new Error(`Plasmic HTTP ${response.status}; inspect the remote revision before retrying. Credentials and response bodies are omitted.`);
    return response.json();
  };
  let remote = bundleDetails(await request('GET'));
  if (args.includes('--update-existing') && (!receipt || receipt.projectId !== library.projectId || receipt.revision !== remote.revision)) {
    throw new Error('Remote revision differs from the last receipt. Export and review Studio edits before replacing existing designs.');
  }
  const saveReceipt = async () => {
    await fs.mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    const data = { projectId: library.projectId, revision: remote.revision, components: remote.components, nodes: remote.nodes, checkedAt: new Date().toISOString() };
    const temporary = `${receiptPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, receiptPath);
  };
  if (library.tokens?.length) {
    // Initial imports may append missing tokens but never reset a Studio edit.
    const missing = library.tokens.filter(token => !remote.tokens.some(existing => existing.name === token.name));
    if (missing.length) {
      await request('POST', { tokens: missing });
      remote = bundleDetails(await request('GET'));
      await saveReceipt();
    }
  }
  const pending=library.components.filter(component=>args.includes('--update-existing')||!remote.components.some(candidate=>candidate.name===component.name));
  for (let offset=0;offset<pending.length;offset+=20) {
    const batch=pending.slice(offset,offset+20),payload={newComponents:[],updateComponents:[]};
    for(const component of batch){
      const existing=remote.components.find(candidate=>candidate.name===component.name);
      const key=existing?'updateComponents':'newComponents';
      const entry={name:component.name,...(component.path?{path:component.path}:{}),body:substituteTokens(component.body,remote.tokens)};
      if(existing)entry.byUuid=existing.uuid;
      payload[key].push(entry);
    }
    const saved = await request('POST', payload);
    const warnings = saved.result?.warnings ?? [];
    remote = bundleDetails(await request('GET'));
    for(const component of batch)if (!remote.components.some(candidate => candidate.name === component.name)) throw new Error(`Read-back did not contain ${component.name}. Do not replay automatically.`);
    await saveReceipt();
    console.log(JSON.stringify({ saved: batch.map(component=>component.name), revision: remote.revision, ...(warnings.length ? { warnings } : {}) }));
  }
  await saveReceipt();
  console.log(JSON.stringify({ mode: 'verified', projectId: library.projectId, ...counts, remoteComponents: remote.components.length, remoteNodes: remote.nodes, receipt: receiptPath }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
