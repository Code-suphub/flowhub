const {test}=require('node:test');const assert=require('node:assert/strict');const {arrange,overlaps}=require('../ui/widget-layout.js');
test('moving a middle card down pulls the far-right server into its gap',()=>{
 const cards=[{id:'a',width:270,height:160,x:0,y:0},{id:'b',width:270,height:160,x:280,y:0},{id:'job',width:384,height:184,x:560,y:0},{id:'cloud',width:160,height:160,x:954,y:0}];
 const p=arrange(cards,'job',{x:0,y:180});const cloud=p.find(c=>c.id==='cloud'),job=p.find(c=>c.id==='job');assert.equal(cloud.x,560);assert.equal(cloud.y,0);assert.equal(job.y,170);
 const saved=arrange(p.map(c=>({id:c.id,width:c.w,height:c.h,x:c.x,y:c.y})));assert.deepEqual(saved,p);
 for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++)assert(!overlaps(p[i],p[j]));
});
test('removal closes horizontal and vertical holes',()=>{const p=arrange([{id:'a',width:160,height:120,x:0,y:0},{id:'b',width:160,height:120,x:600,y:0},{id:'c',width:330,height:120,x:0,y:500}]);assert.equal(p[1].x,170);assert.equal(p[2].y,130);});
test('cards dock beside and below without fixed row constraints',()=>{const cards=[{id:'a',size:'small',width:160,height:120,x:0,y:0},{id:'b',size:'small',width:160,height:160,x:0,y:130}];let p=arrange(cards,'b',{x:175,y:0});assert.equal(p[1].x,170);assert.equal(p[1].y,0);assert(!overlaps(...p));p=arrange(cards,'b',{x:0,y:135});assert.equal(p[1].x,0);assert.equal(p[1].y,130);});
test('different sizes never overlap and empty outer space is removed',()=>{const cards=Array.from({length:12},(_,i)=>({id:String(i),size:'small',width:160+i*5,height:120+i*3}));const p=arrange(cards);for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++)assert(!overlaps(p[i],p[j]));const one=arrange([{id:'a',width:160,height:120,x:400,y:300}]);assert.equal(one[0].x,0);assert.equal(one[0].y,0);});
