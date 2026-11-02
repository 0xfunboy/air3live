import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';
import{decodeEditorialChart,storeEditorialChart}from'../src/editorial-chart.mjs';
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y4hoAAAAASUVORK5CYII=','base64');
const input={mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),dataBase64:bytes.toString('base64')};
test('chart storage is private, hashed, immutable and contains no external URL',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'air3-chart-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const decoded=decodeEditorialChart(input),value=storeEditorialChart(join(dir,'charts'),decoded,Date.now()+60000);
 assert.equal(value.width,1);assert.match(value.path,/^\/api\/editorial-charts\/[a-f0-9]{64}\.png$/);assert.equal(value.dataBase64,undefined);
 assert.deepEqual(await readFile(join(dir,'charts',input.sha256+'.png')),bytes);assert.deepEqual(storeEditorialChart(join(dir,'charts'),decoded,value.expiresAt),value);
 for(const change of [{mimeType:'image/svg+xml'},{sha256:'a'.repeat(64)},{dataBase64:'AAAA'},{url:'https://example.org'}])assert.throws(()=>decodeEditorialChart({...input,...change}),/INVALID_EDITORIAL_CHART/);
});
