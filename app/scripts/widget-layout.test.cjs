const {test}=require('node:test');const assert=require('node:assert/strict');const {arrange,overlaps}=require('../ui/widget-layout.js');
const cards=p=>p.map(({id,x,y,w,h})=>({id,x,y,width:w,height:h}));
const positions=p=>Object.fromEntries(p.map(({id,x,y})=>[id,{x,y}]));
const noOverlap=p=>{for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++)assert(!overlaps(p[i],p[j]));};
test('refresh and reload preserve intentional gaps and reverse creation order',()=>{
 const layout=[{id:'b',width:220,height:130,x:230,y:280},{id:'a',width:220,height:130,x:0,y:0},{id:'c',width:220,height:130,x:0,y:280}];
 let p=arrange(layout);assert.deepEqual(positions(p),positions(layout));
 for(let i=0;i<20;i++){p=arrange(cards(p));assert.deepEqual(positions(p),positions(layout));}
 assert.deepEqual(positions(arrange([...layout].reverse())),positions(layout));
});
test('moving a card does not compact neighbouring servers into its former position',()=>{
 const layout=[{id:'a',width:220,height:130,x:0,y:0},{id:'b',width:220,height:130,x:230,y:0},{id:'c',width:220,height:130,x:460,y:0}];
 const p=arrange(layout,'b',{x:0,y:140});assert.deepEqual(positions(p),{a:{x:0,y:0},c:{x:460,y:0},b:{x:0,y:140}});noOverlap(p);
 assert.deepEqual(positions(arrange(cards(p))),positions(p));
});
test('removal and a single offset card keep saved coordinates',()=>{
 const layout=[{id:'a',width:160,height:120,x:400,y:300}];assert.deepEqual(positions(arrange(layout)),positions(layout));
});
test('new cards reserve existing positions even when prepended to the array',()=>{
 const layout=[{id:'new',width:220,height:130},{id:'a',width:220,height:130,x:230,y:140},{id:'b',width:220,height:130,x:0,y:0}];const p=arrange(layout);assert.deepEqual(positions(p).a,{x:230,y:140});assert.deepEqual(positions(p).b,{x:0,y:0});noOverlap(p);
});
test('size changes resolve collisions consistently in visual order',()=>{
 const layout=[{id:'right',width:220,height:130,x:230,y:0},{id:'left',width:300,height:130,x:0,y:0}];const p=arrange(layout);assert.deepEqual(positions(p).left,{x:0,y:0});noOverlap(p);assert.deepEqual(positions(arrange([...layout].reverse())),positions(p));assert.deepEqual(positions(arrange(cards(p))),positions(p));
});
test('cards can dock beside or below a neighbour',()=>{
 const layout=[{id:'a',width:160,height:120,x:0,y:0},{id:'b',width:160,height:160,x:0,y:130}];const beside=arrange(layout,'b',{x:175,y:0});assert.deepEqual(positions(beside).b,{x:170,y:0});const below=arrange(layout,'b',{x:0,y:135});assert.deepEqual(positions(below).b,{x:0,y:130});noOverlap(beside);noOverlap(below);
});
test('dropping on the target centre swaps only the two cards and survives refresh',()=>{
 const {swapTarget}=require('../ui/widget-layout.js');const layout=[{id:'top',x:230,y:140,width:220,height:130},{id:'bottom',x:230,y:280,width:220,height:130},{id:'other',x:0,y:0,width:220,height:130}];
 const target=swapTarget(layout,'bottom',{x:340,y:200});assert.equal(target,'top');const p=arrange(layout,'bottom',{x:230,y:140},target);assert.deepEqual(positions(p),{top:{x:230,y:280},bottom:{x:230,y:140},other:{x:0,y:0}});noOverlap(p);assert.deepEqual(positions(arrange(cards(p))),positions(p));assert.deepEqual(layout[0].y,140);
 assert.equal(swapTarget(layout,'bottom',{x:231,y:141}),null);assert.equal(swapTarget(layout,'bottom',{x:340,y:320}),null);
});
test('different sizes swap only when both fit without displacing neighbours',()=>{
 const {swap}=require('../ui/widget-layout.js');const layout=[{id:'a',x:0,y:0,width:160,height:120},{id:'b',x:0,y:300,width:300,height:180}];assert(swap(layout,'a','b'));layout.push({id:'c',x:170,y:0,width:160,height:120});assert.equal(swap(layout,'a','b'),null);assert.equal(swap(layout,'a','missing'),null);
});
