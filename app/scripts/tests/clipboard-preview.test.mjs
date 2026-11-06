import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import initSqlJs from 'sql.js';

const fixture=await mkdtemp(join(tmpdir(),'flowhub-clipboard-organization-')),previous=process.env.HOME;
process.env.HOME=join(fixture,'home');
after(async()=>{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;await rm(fixture,{recursive:true,force:true});});
const support=join(process.env.HOME,'Library','Application Support','FlowHub'),storage=join(fixture,'storage'),configPath=join(fixture,'config.json'),databasePath=join(storage,'weborg.db');
await mkdir(support,{recursive:true});await mkdir(storage);await writeFile(configPath,JSON.stringify({plugins:{clipboard:{settings:{storagePath:storage}}}}));await writeFile(join(support,'config-location.json'),JSON.stringify({configPath}));
const SQL=await initSqlJs(),db=new SQL.Database();
db.run('CREATE TABLE clipboard_records(id INTEGER PRIMARY KEY,kind TEXT,hash TEXT,content TEXT,source_name TEXT,file_name TEXT,file_paths TEXT,file_types TEXT,size INTEGER,created_at TEXT,last_seen_at TEXT,copy_count INTEGER)');
for(const [id,kind,source,content] of [[1,'text',' Editor ','original'],[2,'file','Editor',''],[3,'text',null,'unknown'],[4,'text','Other','other']])db.run('INSERT INTO clipboard_records VALUES(?,?,?,?,?,NULL,?,?,1,?,?,1)',[id,kind,String(id),content,source,kind==='file'?'["/fixture/a.png"]':'[]',kind==='file'?'["image"]':'[]','2026-11-05T10:00:00Z',`2026-11-05T10:00:0${id}Z`]);
await writeFile(databasePath,db.export());db.close();
const {searchClipboardRecords,clipboardSources}=await import('../../dev/preview-helpers.mjs');
const {localClipboardApi}=await import('../../dev/clipboard-api.mjs');
const routes=new Map();localClipboardApi().configureServer({middlewares:{use:(route,callback)=>routes.set(route,callback)}});
async function invoke(route,method,url='/') {const headers={};const response={setHeader:(key,value)=>{headers[key]=value;},end(value){this.body=value;}};await routes.get(route)({method,url,async *[Symbol.asyncIterator](){assert.fail('readonly endpoint must not consume write bodies');}},response);return {...response,headers};}

test('readonly clipboard organization supports old schemas, exact source filters and file classification without writing',async()=>{
  const before=await readFile(databasePath);
  const rows=await searchClipboardRecords('',1,'image',0,'Editor',false);assert.equal(rows.records[0].id,2);assert.equal(rows.records[0].note,'');
  assert.equal((await searchClipboardRecords('',30,'all',0,null,true)).records.length,0);
  assert.equal((await searchClipboardRecords('',30,'all',0,'',false)).records[0].id,3);
  assert.equal((await clipboardSources()).find(source=>source.name==='Editor').count,2);
  for(const route of routes.keys())for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await invoke(route,method)).statusCode,405);
  assert.deepEqual(await readFile(databasePath),before);
});
test('readonly notes and pin/source predicates apply before pagination, and sources endpoint only returns metadata',async()=>{
  const updated=new SQL.Database(await readFile(databasePath));updated.run("ALTER TABLE clipboard_records ADD COLUMN note TEXT DEFAULT ''");updated.run('ALTER TABLE clipboard_records ADD COLUMN pinned_at TEXT');updated.run("UPDATE clipboard_records SET note='release 100% ready',pinned_at='pinned' WHERE id=1");await writeFile(databasePath,updated.export());updated.close();
  const before=await readFile(databasePath);
  const response=await invoke('/__weborg/clipboard/records','GET','/?q=release&kind=text&source=Editor&pinnedOnly=1&limit=1');assert.equal(response.statusCode,200);const rows=JSON.parse(response.body).records;assert.equal(rows.length,1);assert.equal(rows[0].id,1);assert.equal(rows[0].content,'original');assert.equal(rows[0].note,'release 100% ready');assert.equal((await searchClipboardRecords('%')).records.length,1);
  const sources=JSON.parse((await invoke('/__weborg/clipboard/sources','GET')).body);assert.equal(sources.readonly,true);assert.deepEqual(Object.keys(sources.sources[0]).sort(),['count','name']);assert.deepEqual(await readFile(databasePath),before);
});
