#!/usr/bin/env python3
"""Attach a bounded, region-validated subset of supplied MetaHuman correctives.

These are corrective morphs, not complete viseme poses or a port of RigLogic.
The runtime combines them with bounded facial-bone controls. The metadata's 815
names match the source's exact primitive support groups; selected rows are also
checked for side/region support. Input geometry and skin weights are preserved.
"""
from pathlib import Path
import argparse,copy,json,struct,hashlib,re
import numpy as np
from sparsify_glb import BinaryGLTF
from retarget_body_translations import write_glb

HEAD_NAMES=['brow_down_L','brow_down_R','brow_raiseIn_L','brow_raiseIn_R','brow_raiseOuter_left','brow_raiseOuter_right','eye_blink_L','eye_blink_R','eye_widen_L','eye_widen_R','eye_cheekRaise_L','eye_cheekRaise_R','mouth_cornerPull_left','mouth_cornerPull_right','mouth_cornerDepress_L','mouth_cornerDepress_R','mouth_lipsPurse_UL','mouth_lipsPurse_UR','mouth_lipsPurse_DL','mouth_lipsPurse_DR','mouth_funnel_UL','mouth_funnel_UR','mouth_funnel_DL','mouth_funnel_DR','mouth_lipsPress_L','mouth_lipsPress_R','jaw_open']
SELECTED=['head_lod0_mesh__'+n for n in HEAD_NAMES]+['cartilage_lod0_mesh__eye_blink_L','cartilage_lod0_mesh__eye_blink_R']

def main():
 root=Path(__file__).resolve().parents[1]
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('runtime',nargs='?',default=str(root/'build/AIR3-runtime.retargeted.glb'));p.add_argument('sparse_source',nargs='?',default=str(root/'source-assets/AI_MetaHumanIdentity_FaceMesh.sparse.glb'));p.add_argument('metadata',nargs='?',default=str(root/'studio-broadcast/public/assets/air3/metadata/air3-missing-metadata.json'));p.add_argument('output',nargs='?',default=str(root/'studio-broadcast/public/assets/air3/models/AIR3-runtime.glb'));p.add_argument('--report',default=str(root/'docs/validation/facial-subset-validation.json'));a=p.parse_args()
 r=BinaryGLTF(a.runtime);s=BinaryGLTF(a.sparse_source);doc=copy.deepcopy(r.doc);meta=json.loads(Path(a.metadata).read_text())
 meshmeta=meta['meshes']['/Game/MetaHumans/AIR3/Face/AI_MetaHumanIdentity_FaceMesh'];names=meshmeta['morph_names_source_array_order'];sp=s.doc['meshes'][0]['primitives'];face=next(m for m in doc['meshes'] if m['name']=='face__AI_MetaHumanIdentity_FaceMesh');rp=face['primitives']
 assert len(names)==815 and len(sp)==len(rp)==9
 assert not any('targets' in p for p in rp),'Runtime already has facial controls'
 groups=[('head_lod0_mesh',0,702,0),('teeth_lod0_mesh',702,743,1),('eyeLeft_lod0_mesh',743,745,3),('eyeRight_lod0_mesh',745,747,4),('cartilage_lod0_mesh',747,815,8)]
 for prefix,start,end,prim in groups:
  assert all(n.startswith(prefix+'__') for n in names[start:end])
  for i in range(start,end):
   assert len(sp[prim]['targets'])==len(names)
   for pi,p0 in enumerate(sp):
    d=s.accessor(p0['targets'][i]['POSITION'])
    if pi!=prim:assert not np.any(d),f'Morph group mismatch {i}:{pi}'
 for p0,p1 in zip(sp,rp):
  assert np.array_equal(s.accessor(p0['attributes']['POSITION']),r.accessor(p1['attributes']['POSITION'])),'Face topology changed'
  assert np.array_equal(s.accessor(p0['indices']),r.accessor(p1['indices'])),'Face index order changed'
 blob=bytearray(r.data[r.bin_offset:r.bin_offset+doc['buffers'][0]['byteLength']]);report=[]
 def add_view(v):
  blob.extend(b'\0'*(-len(blob)%4));i=len(doc['bufferViews']);doc['bufferViews'].append({'buffer':0,'byteOffset':len(blob),'byteLength':len(v)});blob.extend(v);return i
 def add_accessor(v):
  v=np.asarray(v,dtype='<f4');desc={'componentType':5126,'count':len(v),'type':'VEC3','min':v.min(0).tolist(),'max':v.max(0).tolist()};ids=np.flatnonzero(np.any(v.view(np.uint8).reshape(len(v),12)!=0,axis=1))
  if len(ids):
   idtype=5123 if len(v)<=65535 else 5125;dtype='<u2' if idtype==5123 else '<u4'
   desc['sparse']={'count':len(ids),'indices':{'bufferView':add_view(ids.astype(dtype).tobytes()),'componentType':idtype},'values':{'bufferView':add_view(v[ids].tobytes())}}
  ai=len(doc['accessors']);doc['accessors'].append(desc);return ai
 selected_indices=[names.index(n) for n in SELECTED]
 for pi,(p0,p1) in enumerate(zip(sp,rp)):
  p1['targets']=[];pos=s.accessor(p0['attributes']['POSITION'])
  for name,idx in zip(SELECTED,selected_indices):
   target={}
   for semantic in ['POSITION','NORMAL']:
    v=s.accessor(p0['targets'][idx][semantic]);target[semantic]=add_accessor(v)
    if semantic=='POSITION':
     w=np.linalg.norm(v,axis=1);sel=w>1e-7
     if np.any(sel):
      center=np.average(pos[sel],axis=0,weights=w[sel]);row={'name':name,'sourceIndex':idx,'primitive':pi,'affectedVertices':int(sel.sum()),'weightedCenter':center.tolist(),'maxDeltaMeters':float(w.max())}
      suffix=name.split('__')[1]
      left=bool(re.search(r'(?:_L|_left|_UL|_DL)$',suffix));right=bool(re.search(r'(?:_R|_right|_UR|_DR)$',suffix))
      if left:assert center[0]>.002,name
      if right:assert center[0]<-.002,name
      if 'brow_' in suffix:assert center[1]>1.55,name
      if 'eye_' in suffix:assert (1.50 if 'cheek' in suffix else 1.54)<center[1]<1.61,name
      if 'mouth_' in suffix:assert 1.47<center[1]<1.56,name
      row['regionCheck']='passed';report.append(row)
   p1['targets'].append(target)
 face['weights']=[0]*len(SELECTED);face.setdefault('extras',{})['targetNames']=SELECTED
 face['extras']['air3FacialControls']='bone drivers plus 29 source corrective morphs; not full RigLogic'
 for node in doc['nodes']:
  if node.get('mesh')==doc['meshes'].index(face):node['weights']=[0]*len(SELECTED)
 doc['asset']['generator']='#AIR3 browser quality builder 0.3'
 for scene in doc.get('scenes',[]):
  profile=scene.get('extras',{}).get('air3')
  if profile:
   profile.update(version=2,facialLipSync='audio-timed skeletal articulation with source correctives',sourceCorrectiveCount=len(SELECTED),rigLogicParity=False,bodyTranslationRetargeted=True,materialReconstruction='avatar-materials.mjs',normalConvention='source texture settings recovered; runtime material profile applies convention')
   profile.pop('missingMaterialMaps',None)
 doc.setdefault('extras',{})['air3FaceControlSubset']={'schema':1,'count':len(SELECTED),'sourceMorphCount':815,'primaryArticulation':'coordinated skeletal controls','mappingValidation':'exact source topology, ordered group support, selected weighted side/region checks','rigLogicParity':False}
 write_glb(a.output,doc,blob)
 out={'schema':1,'count':len(SELECTED),'sourceMorphCount':815,'sourceSparseSha256':hashlib.sha256(Path(a.sparse_source).read_bytes()).hexdigest(),'metadataSha256':hashlib.sha256(Path(a.metadata).read_bytes()).hexdigest(),'outputSha256':hashlib.sha256(Path(a.output).read_bytes()).hexdigest(),'topologyAndSkinPreserved':True,'mappingChecks':'All815 targets match named group support; all29 selected match anatomical side/region; exact position/index correspondence. This is not a RigLogic evaluation.','selected':report}
 Path(a.report).parent.mkdir(parents=True,exist_ok=True);Path(a.report).write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'morphs':len(SELECTED),'outputBytes':Path(a.output).stat().st_size,'report':a.report}))
if __name__=='__main__':main()
