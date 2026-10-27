import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeTitles, createEditorialStore } from '../src/live-editorial.mjs';

test('editorial input supports separate title/subtitle and newline ticker while bounding every field',()=>{
  const now=1_790_000_000_000;
  const value=normalizeTitles({enabled:true,label:' #AIR3 LIVE ',title:'Titolo',subtitle:'Sottotitolo',ticker:'Prima notizia\n\n Seconda notizia ',speed:80,ttlSeconds:60},undefined,now);
  assert.equal(value.label,'#AIR3 LIVE');assert.deepEqual(value.ticker,['Prima notizia','Seconda notizia']);assert.equal(value.expiresAt,now+60_000);assert.equal(value.updatedAt,now);
  for(const patch of [{label:'x'.repeat(33)},{title:'x'.repeat(121)},{subtitle:'x'.repeat(221)},{ticker:['x'.repeat(241)]},
    {ticker:Array(13).fill('x')},{title:'line\nbreak'},{ticker:[42]},{enabled:'true'},{speed:19},{speed:161},{ttlSeconds:1.5},{ttlSeconds:86401},{html:'<script>bad</script>'}])assert.throws(()=>normalizeTitles(patch));
  assert.equal(normalizeTitles({title:'<script>literal text</script>'}).title,'<script>literal text</script>');
});

test('title expiry disables output and survives restart without resetting the deadline',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'air3-editorial-ttl-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let clock=1_790_000_000_000;
  const store=await createEditorialStore(root,{now:()=>clock});
  await store.update({enabled:true,title:'Titolo temporaneo',ticker:['Notizia temporanea'],ttlSeconds:2});
  clock+=1500;assert.equal(store.get().enabled,true);
  const resumed=await createEditorialStore(root,{now:()=>clock});assert.equal(resumed.get().enabled,true);assert.equal(resumed.get().expiresAt,1_790_000_002_000);
  clock+=501;assert.equal(resumed.get().enabled,false);assert.equal(resumed.get().title,'Titolo temporaneo');
  const expired=await createEditorialStore(root,{now:()=>clock});assert.equal(expired.get().enabled,false);assert.equal(expired.get().expiresAt,1_790_000_002_000);
  await expired.update({enabled:true,ttlSeconds:0});clock+=100_000_000;assert.equal(expired.get().enabled,true);assert.equal(expired.get().expiresAt,null);
});

test('simultaneous title edits merge serially, invalid updates leave state intact and later writes recover',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'air3-editorial-atomic-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=await createEditorialStore(root);
  await store.update({enabled:true,title:'Prima versione'});
  const jobs=[store.update({title:'Versione finale'}),store.update({subtitle:'Sottotitolo finale'}),store.update({ticker:['Notizia finale']})];
  await Promise.all(jobs);const expected=store.get();assert.equal(expected.title,'Versione finale');assert.equal(expected.subtitle,'Sottotitolo finale');assert.deepEqual(expected.ticker,['Notizia finale']);
  await assert.rejects(store.update({title:'x'.repeat(121)}));assert.deepEqual(store.get(),expected);
  await store.update({label:'#AIR3'});const disk=JSON.parse(await readFile(path.join(root,'live-titles.json'),'utf8'));assert.equal(disk.label,'#AIR3');assert.equal(disk.title,'Versione finale');assert.equal(disk.subtitle,'Sottotitolo finale');
  const detached=store.get();detached.ticker.push('Mutazione esterna');assert.deepEqual(store.get().ticker,['Notizia finale']);
});

test('explicit title clear persists a disabled empty banner',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'air3-editorial-clear-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=await createEditorialStore(root);await store.update({enabled:true,title:'Titolo',subtitle:'Sotto',ticker:['Scorrevole']});
  await store.update({enabled:false,title:'',subtitle:'',ticker:[]});
  const restored=await createEditorialStore(root);assert.equal(restored.get().enabled,false);assert.equal(restored.get().title,'');assert.equal(restored.get().subtitle,'');assert.deepEqual(restored.get().ticker,[]);
});
