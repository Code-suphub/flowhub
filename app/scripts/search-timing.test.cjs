const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
let time = 0, frames = [];
const window = {};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../ui/search-timing.js'), 'utf8'), {
 window, performance: { now: () => time }, requestAnimationFrame: cb => frames.push(cb)
});
(async () => {
 await Promise.resolve();
 const t = window.flowhubSearchTiming;
 t.begin('input'); assert.equal(t.report().length, 0);
 t.enable(true); t.begin('input');
 time = 180; t.dispatch(t.capture());
 let complete;
 const slow = t.query('app', () => new Promise(r => complete = r));
 await t.query('clipboard', async () => { time = 200; return []; });
 t.render(() => { time = 202; });
 assert.equal(t.report()[0].firstResponseDomMs, undefined, 'unapplied response cannot count as DOM publication');
 t.applied(); t.render(() => { time = 205; });
 time = 216; frames.shift()();
 time = 1080; complete([]); await slow;
 let r = t.report()[0];
 assert.equal(r.dispatchMs, 180); assert.equal(r.sources[0].durationMs, 900);
 assert.equal(r.sources[1].durationMs, 20); assert.equal(r.firstResponseDomMs, 205);
 assert.equal(r.nextFrameWaitMs, 11);
 let reject; const old = t.query('web', () => new Promise((_,r) => reject=r));
 t.begin('scope'); reject(new Error('private content must not be recorded'));
 await assert.rejects(old);
 assert.equal(t.report()[0].sources[2].stale, true);
 assert.equal(t.report()[0].sources[2].status, 'error');
 assert(!JSON.stringify(t.report()).includes('private content'));
 for(let i=0;i<120;i++) t.begin('input');
 assert.equal(t.report().length,100);
 t.enable(false); const count=t.report().length;
 assert.equal(await t.query('memo',async()=>42),42); t.begin('input');
 assert.equal(t.report().length,count); t.reset(); assert.equal(t.report().length,0);
 console.log('PASS: stage boundaries, unapplied response, slow source, next frame, stale/error isolation, opt-in and bounded samples');
})().catch(e=>{console.error(e);process.exitCode=1});
