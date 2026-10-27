import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

function unpack(bytes) {
  const length=bytes.readUInt32LE(12), doc=JSON.parse(bytes.subarray(20,20+length));
  const binary=bytes.subarray(28+length);
  function attribute(index) {
    const a=doc.accessors[index], view=doc.bufferViews[a.bufferView];
    const width={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];
    const size={5126:4,5125:4,5123:2,5121:1}[a.componentType];
    const offset=(view.byteOffset||0)+(a.byteOffset||0), result=[];
    for(let i=0;i<a.count;i++) {
      const row=[];
      for(let c=0;c<width;c++) {const at=offset+i*(view.byteStride||width*size)+c*size;row.push(a.componentType===5126?binary.readFloatLE(at):a.componentType===5125?binary.readUInt32LE(at):a.componentType===5123?binary.readUInt16LE(at):binary[at]);}
      result.push(row);
    }
    return result;
  }
  return {doc,binary,attribute};
}

test('off-shoulder shortening preserves the top anchor and original body while straightening the front neckline',async()=>{
  const raw=await readFile(new URL('../public/assets/air3/clothing/crop-top.glb',import.meta.url));
  const {doc,attribute}=unpack(raw), attrs=doc.meshes[0].primitives[0].attributes;
  const positions=attribute(attrs.POSITION), y=positions.map(p=>p[1]);
  const minimum=Math.min(...y), maximum=Math.max(...y);
  // Measurements of the frozen 2.3 fitted asset, not source garment units.
  const previousMinimum=1.0655013, previousMaximum=1.3745409;
  assert.ok(Math.abs(maximum-previousMaximum)<.001,'upper attachment stays within 1 mm');
  assert.ok(minimum-previousMinimum>.035 && minimum-previousMinimum<.05,'hem rises 3.5–5 cm');
  const shortening=1-(maximum-minimum)/(previousMaximum-previousMinimum);
  assert.ok(shortening>.10 && shortening<.16,'surface fitting keeps final shortening within requested 10–15% range');
  const upper=[];
  for(const x of [-.12,-.1,-.08,-.05,0,.05,.08,.1,.12]) {
    const rows=positions.filter(p=>Math.abs(p[0]-x)<.009&&p[2]>.035);
    assert.ok(rows.length);upper.push(Math.max(...rows.map(p=>p[1])));
  }
  assert.ok(Math.max(...upper)-Math.min(...upper)<.003,'front rim is level within 3 mm in bind pose');
  const binding=doc.asset.extras.air3Binding;
  assert.equal(binding.refinement.heightReductionPercent,15);
  assert.equal(binding.refinement.upperAnchorShiftMetres,0);
  const body=await readFile(new URL('../public/assets/air3/models/AIR3-runtime.glb',import.meta.url));
  assert.equal(createHash('sha256').update(body).digest('hex'),binding.bodySha256);
  assert.equal(binding.bodyGeometryChanged,false);
});

test('refitted garment retains authored UVs, topology and normalized body binding',async()=>{
  const fit=unpack(await readFile(new URL('../public/assets/air3/clothing/crop-top.glb',import.meta.url)));
  const original=unpack(await readFile(new URL('../../source-assets/clothing/off_shoulder_top.glb',import.meta.url)));
  const fp=fit.doc.meshes[0].primitives[0], op=original.doc.meshes[0].primitives[0];
  assert.deepEqual(fit.attribute(fp.indices),original.attribute(op.indices));
  assert.deepEqual(fit.attribute(fp.attributes.TEXCOORD_0),original.attribute(op.attributes.TEXCOORD_0));
  assert.equal(fit.attribute(fp.attributes.POSITION).length,6403);
  for(const weights of fit.attribute(fp.attributes._AIR3_WEIGHTS)) {
    assert.ok(weights.every(w=>w>=0&&Number.isFinite(w)));
    assert.ok(Math.abs(weights.reduce((a,b)=>a+b,0)-1)<1e-6);
  }
  for(const normal of fit.attribute(fp.attributes.NORMAL)) assert.ok(Math.abs(Math.hypot(...normal)-1)<1e-5);
  // The white finish is applied in the material: authored texture bytes remain intact.
  const imageBytes=asset=>{const view=asset.doc.bufferViews[asset.doc.images[0].bufferView];return asset.binary.subarray(view.byteOffset,view.byteOffset+view.byteLength);};
  assert.deepEqual(imageBytes(fit),imageBytes(original));
});
