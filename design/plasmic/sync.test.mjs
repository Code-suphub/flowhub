import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bundleDetails, normalizePresentation, substituteTokens, validateLibrary} from './sync.mjs';
const library = components => ({schema:1,projectId:'rKroot8WmpiogJg8366SaB',components});
test('table column and measuring nodes do not push visible rows out of the viewport',()=>{
 const body={type:'box',children:[{type:'box',styles:{display:'table-column-group',height:'322px'},children:[{type:'box',styles:{display:'table-column'}}]},{type:'box',styles:{display:'table-cell',height:'0px'},children:[{type:'text',value:'measurement'}]},{type:'text',styles:{display:'table-cell',height:'35px'},value:'应用 / 工具'},{type:'text',value:'Codex'}]};
 const result=normalizePresentation(body);
 assert.equal(result.children.length,2);assert.equal(result.children[0].styles.display,'block');assert.equal(result.children[1].value,'Codex');
});
test('the importer restricts its destination and preserves dependency order',()=>{
 assert.throws(()=>validateLibrary({...library([]),projectId:'flowbook'}),/dedicated/);
 assert.throws(()=>validateLibrary(library([{name:'Page',body:{type:'component',name:'Missing'}}])),/forward/);
 assert.deepEqual(validateLibrary(library([{name:'Row',body:{type:'text',value:'Example'}},{name:'Page',path:'/example',body:{type:'component',name:'Row'}}])),{components:2,pages:1,nodes:2});
 assert.throws(()=>validateLibrary(library([{name:'A',path:'/same',body:'a'},{name:'B',path:'/same',body:'b'}])),/Duplicate/);
});
test('application names retain intrinsic text width across font environments',()=>{
 const title={type:'text',tag:'button',value:'Codex',styles:{width:'37px',maxWidth:'100%',overflowWrap:'anywhere'}};
 assert.equal(normalizePresentation(title).styles.width,'auto');
 assert.equal(title.styles.maxWidth,'100%');
});
test('unequal grid gutters survive the importer without moving adjacent labels together',()=>{
 const grid={type:'box',styles:{display:'grid',gap:'normal 18px',columnGap:'18px',gridTemplateColumns:'205px 205px',gridTemplateRows:'35px 35px'},children:[{type:'text',value:'型号',styles:{width:'205px'}},{type:'text',value:'产品',styles:{width:'205px'}}]};
 normalizePresentation(grid);
 assert.equal(grid.styles.gridTemplateColumns,'223px 205px');
 assert.equal(grid.styles.gridTemplateRows,'35px 35px');
 assert.equal(grid.styles.gap,'0px');
 assert.equal(grid.styles.columnGap,undefined);
 assert.equal(grid.children[0].styles.width,'205px');
 assert.deepEqual(normalizePresentation(structuredClone(grid)),grid);
});
test('design nodes cannot inject scripts or load external assets',()=>{
 for(const body of [{type:'img',src:'https://example.com/private.png'},{type:'text',value:'x',attrs:{onclick:'run()'}},{type:'text',tag:'a',value:'x',attrs:{href:'javascript:run()'}},{type:'box',styles:{backgroundImage:'url(https://example.com/pixel)'}}])assert.throws(()=>validateLibrary(library([{name:'Unsafe',body}])));
 assert.equal(validateLibrary(library([{name:'Icon',body:{type:'img',src:'data:image/svg+xml,%3Csvg/%3E'}}])).nodes,1);
});
test('token names resolve to project token UUIDs without changing source objects',()=>{
 const body={type:'text',value:'Example',styles:{color:'$token(FH Text)'}};
 assert.throws(()=>substituteTokens(body,[]),/Missing design token/);
 assert.equal(substituteTokens(body,[{name:'FH Text',uuid:'public-style-id'}]).styles.color,'var(--token-public-style-id)');
 assert.equal(body.styles.color,'$token(FH Text)');
});
test('read-back receipts contain design identifiers and counts',()=>{
 const response={project:{projectApiToken:'must-not-copy'},rev:{revision:7,data:JSON.stringify({map:{a:{__type:'Component',name:'Page',uuid:'page-id'},b:{__type:'StyleToken',name:'Text',uuid:'text-id',value:'#000'},c:{__type:'TplTag'},d:{__type:'ApiToken',value:'must-not-copy'}}})}};
 const data=bundleDetails(response);
 assert.equal(data.revision,7);assert.equal(data.nodes,1);
 assert.deepEqual(data.components,[{name:'Page',uuid:'page-id'}]);
 assert.doesNotMatch(JSON.stringify(data),/must-not-copy/);
});
