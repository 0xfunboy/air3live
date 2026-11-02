import test from'node:test';import assert from'node:assert/strict';import{newsTicker}from'../src/news-ticker.mjs';
test('ticker alternates publishers internally but displays no publisher labels or URLs',()=>{
 const time=Date.parse('2026-11-01T17:00:00Z'),story=(name,title)=>({title,publishedAt:time,source:{name}});
 const list=newsTicker([story('A','one'),story('A','two'),story('A','three'),story('B','four'),story('C','five')]);
 assert.deepEqual(list.map(s=>s.split(' — ')[1]),['one','four','five','two','three']);assert.match(list[0],/17:00 UTC/);assert.equal(newsTicker([]).length,0);assert.ok(list.every(t=>!t.includes(' · ')));
});
