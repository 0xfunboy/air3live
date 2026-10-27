#!/usr/bin/env python3
"""Retarget exported animation translations to the actual avatar bind lengths.

The supplied FBX animations contain a second body's static translation offsets.
This preserves geometry, inverse bind matrices, rotation and scale tracks. It
replaces the static translation baseline with the destination bind offsets and
retains only animated translation deltas. The first idle has constant local
translations on every body bone except the pelvis; its pelvis median supplies
that baseline. No per-part resizing, bone-weight edits, or sculpting is done.
"""
from pathlib import Path
import argparse,copy,json,struct,hashlib
import numpy as np
from sparsify_glb import BinaryGLTF

def write_glb(path,doc,blob):
    Path(path).parent.mkdir(parents=True,exist_ok=True)
    doc['buffers'][0]['byteLength']=len(blob)
    j=json.dumps(doc,ensure_ascii=False,separators=(',',':')).encode();j+=b' '*(-len(j)%4)
    blob+=b'\0'*(-len(blob)%4)
    Path(path).write_bytes(struct.pack('<III',0x46546c67,2,28+len(j)+len(blob))+struct.pack('<II',len(j),0x4e4f534a)+j+struct.pack('<II',len(blob),0x004e4942)+blob)

def main():
    root=Path(__file__).resolve().parents[1]
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('input',nargs='?',default=str(root/'source-assets/AIR3-runtime.before-quality.glb'));p.add_argument('output',nargs='?',default=str(root/'build/AIR3-runtime.retargeted.glb'));p.add_argument('--report',default=str(root/'docs/validation/body-translation-retarget.json'));args=p.parse_args()
    source=BinaryGLTF(args.input);doc=copy.deepcopy(source.doc)
    if any(a.get('extras',{}).get('air3TranslationRetargeted') for a in doc.get('animations',[])):raise ValueError('Input is already retargeted')
    ref=next(a for a in doc['animations'] if a['name']=='MH_Idle01_UE')
    baseline={}
    for c in ref['channels']:
        if c['target']['path']!='translation':continue
        ni=c['target']['node'];name=doc['nodes'][ni]['name'];values=source.accessor(ref['samplers'][c['sampler']]['output'])
        if not name.startswith('body__'):continue
        if name!='body__pelvis' and np.max(np.ptp(values,axis=0))>1e-5:raise ValueError('Reference translations are animated: '+name)
        baseline[ni]=np.median(values.astype(np.float64),axis=0)
    blob=bytearray(source.data[source.bin_offset:source.bin_offset+doc['buffers'][0]['byteLength']]);changes=[]
    for a in doc['animations']:
        rec={'clip':a['name'],'tracks':[]}
        for c in a['channels']:
            ni=c['target']['node'];name=doc['nodes'][ni]['name']
            if c['target']['path']!='translation' or ni not in baseline or name=='body__root':continue
            sampler=a['samplers'][c['sampler']];v=source.accessor(sampler['output']);dst=np.array(doc['nodes'][ni].get('translation',[0,0,0]),np.float64)
            delta=dst-baseline[ni]
            if np.max(np.abs(delta))<1e-6:continue
            out=(v.astype(np.float64)+delta).astype('<f4')
            blob+=b'\0'*(-len(blob)%4);vi=len(doc['bufferViews']);doc['bufferViews'].append({'buffer':0,'byteOffset':len(blob),'byteLength':out.nbytes});blob+=out.tobytes()
            ai=len(doc['accessors']);doc['accessors'].append({'bufferView':vi,'componentType':5126,'count':len(out),'type':'VEC3','min':out.min(0).tolist(),'max':out.max(0).tolist()});sampler['output']=ai
            rec['tracks'].append({'bone':name,'sourceBaseline':baseline[ni].tolist(),'destinationBind':dst.tolist(),'baselineDeltaMeters':delta.tolist(),'sourceLength':float(np.linalg.norm(baseline[ni])),'destinationLength':float(np.linalg.norm(dst))})
        a.setdefault('extras',{})['air3TranslationRetargeted']=True;changes.append(rec)
    doc.setdefault('extras',{})['air3TranslationRetarget']={'schema':1,'reference':'MH_Idle01_UE','policy':'destination bind translations plus source animated deltas; pelvis median baseline','geometryChanged':False,'weightsChanged':False}
    write_glb(args.output,doc,blob)
    out={'sourceSha256':hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),'outputSha256':hashlib.sha256(Path(args.output).read_bytes()).hexdigest(),'sourceGeometryAndWeightsUnchanged':True,'basis':'Only pelvis translates over time in reference idle; all other baseline translation tracks are constant within 10 micrometers.','changes':changes}
    Path(args.report).parent.mkdir(parents=True,exist_ok=True);Path(args.report).write_text(json.dumps(out,indent=2)+'\n')
    print(json.dumps({'clips':len(changes),'retargetedTranslationTracks':sum(len(r['tracks']) for r in changes),'outputBytes':Path(args.output).stat().st_size,'report':args.report}))
if __name__=='__main__':main()
