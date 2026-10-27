#!/usr/bin/env python3
"""Fit the supplied unrigged crop top to the unchanged body bind surface."""
from pathlib import Path
import argparse, hashlib, json, struct
import numpy as np
from scipy.spatial import cKDTree
ROOT = Path(__file__).resolve().parents[1]
HEIGHT_SCALE = .85

def smoothstep(lo, hi, value):
    t=np.clip((value-lo)/(hi-lo),0,1)
    return t*t*(3-2*t)

def refine_shape(points):
    """Shorten the cloth below its top anchor, then ease the front collar.

    This edits the supplied garment only. The avatar surface, skeleton and
    bone lengths are never modified. The front rim is a shallow boat neck
    instead of the original three dips; the back collar stays at its anchor.
    """
    fitted=points.copy()
    anchor=float(points[:,1].max())
    fitted[:,1]=anchor+(points[:,1]-anchor)*HEIGHT_SCALE
    x=np.abs(fitted[:,0]);y=fitted[:,1];z=fitted[:,2]
    # The authored neckline has a centre dip. Fit its upper envelope in narrow
    # x bins, then lift only the front edge and smoothly blend to the chest.
    bins=np.linspace(-.16,.16,65)
    upper=[]
    for centre in bins:
        rows=(np.abs(fitted[:,0]-centre)<.009)&(z>.025)&(y>1.27)
        upper.append(float(y[rows].max()) if rows.any() else np.nan)
    upper=np.array(upper);known=np.isfinite(upper)
    upper=np.interp(bins,bins[known],upper[known])
    # Smooth the envelope to avoid transferring triangulation noise to cloth.
    upper=np.convolve(np.pad(upper,3,mode='edge'),np.ones(7)/7,mode='valid')
    edge=np.interp(fitted[:,0],bins,upper)
    target=1.348+.006*(x/.16)**4
    weight=np.exp(-((y-edge)/.042)**2)
    weight*=1-smoothstep(.145,.175,x)
    weight*=smoothstep(.005,.035,z)
    delta=np.clip(target-edge,-.012,.022)*weight
    fitted[:,1]+=delta
    # Raise the low authored bust folds slightly with the shortened torso.
    # No horizontal scaling is applied, so sleeve/arm clearance is retained.
    bust=.009*np.exp(-((y-1.230)/.060)**2)
    bust*=1-smoothstep(.115,.165,x)
    bust*=smoothstep(.035,.075,z)
    fitted[:,1]+=bust
    return fitted, {'verticalScale':HEIGHT_SCALE,'heightReductionPercent':15,
        'upperAnchorMetres':anchor,'upperAnchorShiftMetres':float(fitted[points[:,1].argmax(),1]-anchor),
        'frontNecklineTargetMetres':1.348,'fittedFrontNecklineTargetMetres':1.355,'necklineBlendDepthMetres':.042,
        'additionalBustEaseMetres':.009,'bodyGeometryChanged':False}

def geometric_normals(points, triangles):
    normals=np.zeros_like(points,dtype=np.float64)
    edges1=points[triangles[:,1]]-points[triangles[:,0]]
    edges2=points[triangles[:,2]]-points[triangles[:,0]]
    face=np.cross(edges1,edges2)
    for c in range(3):np.add.at(normals,triangles[:,c],face)
    # UV seams duplicate vertices; merge normals only at coincident positions,
    # never across the separate inner/outer layers of the source top.
    _,inverse=np.unique(np.round(points,5),axis=0,return_inverse=True)
    welded=np.zeros((inverse.max()+1,3));np.add.at(welded,inverse,normals)
    normals=welded[inverse]
    normals/=np.maximum(np.linalg.norm(normals,axis=1),1e-12)[:,None]
    return normals

def ease_fitted_front_edge(points):
    """Remove the small W that body-surface projection would reintroduce."""
    p=points.copy();x=np.abs(p[:,0]);y=p[:,1];z=p[:,2]
    bins=np.linspace(-.15,.15,61);edge=[]
    for centre in bins:
        rows=(np.abs(p[:,0]-centre)<.009)&(z>.028)&(y>1.29)
        edge.append(float(y[rows].max()) if rows.any() else np.nan)
    edge=np.array(edge);known=np.isfinite(edge)
    edge=np.interp(bins,bins[known],edge[known])
    edge=np.convolve(np.pad(edge,2,mode='edge'),np.ones(5)/5,mode='valid')
    at_vertex=np.interp(p[:,0],bins,edge)
    weight=np.exp(-((y-at_vertex)/.038)**2)*smoothstep(.012,.035,z)
    weight*=1-smoothstep(.14,.17,x)
    p[:,1]+=np.clip(1.355-at_vertex,-.012,.018)*weight
    # Keep a small front clearance after the edge movement, without moving the
    # anchored sleeve/back rim or modifying any avatar triangles.
    p[:,2]+=.001*weight
    return p
def read_glb(path):
    raw=path.read_bytes(); n=struct.unpack_from('<I',raw,12)[0]
    return json.loads(raw[20:20+n]), bytearray(raw[28+n:])
def accessor(doc,blob,index):
    a=doc['accessors'][index];v=doc['bufferViews'][a['bufferView']]
    dtype={5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}[a['componentType']]
    width={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[a['type']]
    return np.frombuffer(blob,dtype=dtype,count=a['count']*width,offset=v.get('byteOffset',0)+a.get('byteOffset',0)).reshape((-1,width)).copy()
def append(doc,blob,data,kind,component):
    blob.extend(b'\0'*((-len(blob))%4));offset=len(blob);blob.extend(data.tobytes())
    bv=len(doc['bufferViews']);doc['bufferViews'].append({'buffer':0,'byteOffset':offset,'byteLength':data.nbytes,'target':34962})
    index=len(doc['accessors']);doc['accessors'].append({'bufferView':bv,'componentType':component,'count':len(data),'type':kind})
    return index

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=ROOT/'source-assets/clothing/off_shoulder_top.glb')
    parser.add_argument('--output',type=Path,default=ROOT/'studio-broadcast/public/assets/air3/clothing/crop-top.glb')
    args=parser.parse_args()
    avatar=ROOT/'studio-broadcast/public/assets/air3/models/AIR3-runtime.glb'
    d,b=read_glb(args.source);ad,ab=read_glb(avatar)
    primitive=d['meshes'][0]['primitives'][0];attrs=primitive['attributes']
    p=accessor(d,b,attrs['POSITION']);n=accessor(d,b,attrs['NORMAL'])
    fitted=np.stack([-p[:,0]*.77, (p[:,2]+.166219)*.80+1.067, p[:,1]*.75+.005],axis=1)
    fitted,refinement=refine_shape(fitted)
    normal=np.stack([-n[:,0]/.77,n[:,2]/.80,n[:,1]/.75],axis=1);normal/=np.linalg.norm(normal,axis=1)[:,None]
    triangles=accessor(d,b,primitive['indices']).reshape(-1,3)
    normal=geometric_normals(fitted,triangles)
    body_node=next(n for n in ad['nodes'] if n.get('name')=='body__root_mesh')
    body_primitive=ad['meshes'][body_node['mesh']]['primitives'][0];ba=body_primitive['attributes']
    bp=accessor(ad,ab,ba['POSITION']);bn=accessor(ad,ab,ba['NORMAL'])
    tree=cKDTree(bp); initial=fitted.copy(); smooth_tree=cKDTree(fitted)
    smooth_dist,smooth_near=smooth_tree.query(fitted,k=24)
    smooth_weight=np.exp(-(smooth_dist/.018)**2);smooth_weight/=smooth_weight.sum(axis=1)[:,None]
    # A smooth displacement field moves neighbouring inner/outer layers together;
    # independent projection would collapse the supplied cloth thickness.
    for iteration in range(5):
        dist,near=tree.query(fitted,k=8)
        blend=1/np.maximum(dist,.004)**3;blend/=blend.sum(axis=1)[:,None]
        bn_near=(bn[near]*blend[:,:,None]).sum(axis=1);bn_near/=np.maximum(np.linalg.norm(bn_near,axis=1),1e-9)[:,None]
        surface=(bp[near]*blend[:,:,None]).sum(axis=1)
        clearance=np.sum((fitted-surface)*bn_near,axis=1)
        # Project the outward shell only. The source has a buried inner collar
        # cap; pushing that cap onto the body surface makes two bright slivers.
        outward=(np.sum(normal*bn_near,axis=1) > .45) | (bn_near[:,2] > -.5)
        amount=np.clip(.007-clearance,0,.025)*(dist[:,0]<.06)*outward
        displacement=bn_near*amount[:,None]
        fitted+=(displacement[smooth_near]*smooth_weight[:,:,None]).sum(axis=1)*.9
    # Keep the supplied outer shell and inner lining separated during skinning.
    # Their source separation is below 2 mm around the upper back.
    fitted += normal * .0015
    fitted=ease_fitted_front_edge(fitted)
    normal=geometric_normals(fitted,triangles)
    shift=np.linalg.norm(fitted-initial,axis=1)
    dist,near=tree.query(fitted,k=8);blend=1/np.maximum(dist,.004)**3;blend/=blend.sum(axis=1)[:,None]
    skin=ad['skins'][body_node['skin']];names=[ad['nodes'][idx]['name'] for idx in skin['joints']]
    joints=np.concatenate([accessor(ad,ab,ba[f'JOINTS_{s}']) for s in range(3) if f'JOINTS_{s}' in ba],axis=1)
    weights=np.concatenate([accessor(ad,ab,ba[f'WEIGHTS_{s}']) for s in range(3) if f'WEIGHTS_{s}' in ba],axis=1)
    full_weights=np.zeros((len(fitted),len(names)),dtype=np.float64)
    for i in range(len(fitted)):
        full_weights[i]=np.bincount(joints[near[i]].ravel(),weights=(weights[near[i]]*blend[i,:,None]).ravel(),minlength=len(names))
    full_weights=(full_weights[smooth_near]*smooth_weight[:,:,None]).sum(axis=1)
    out_j=np.zeros((len(fitted),4),dtype='<u2');out_w=np.zeros((len(fitted),4),dtype='<f4')
    for i in range(len(fitted)):
        best=np.argsort(full_weights[i])[-4:][::-1];chosen=full_weights[i,best];out_j[i]=best;out_w[i]=chosen/chosen.sum()
    attrs['POSITION']=append(d,b,fitted.astype('<f4'),'VEC3',5126);attrs['NORMAL']=append(d,b,normal.astype('<f4'),'VEC3',5126)
    pos=d['accessors'][attrs['POSITION']];pos['min']=fitted.min(axis=0).tolist();pos['max']=fitted.max(axis=0).tolist()
    attrs['_AIR3_JOINTS']=append(d,b,out_j,'VEC4',5123);attrs['_AIR3_WEIGHTS']=append(d,b,out_w,'VEC4',5126)
    for node in d['nodes']:
        for field in ['matrix','translation','rotation','scale']:node.pop(field,None)
    d['meshes'][0]['name']='AIR3 supplied crop top'
    d['asset']['extras']['air3Binding']={'bodySha256':hashlib.sha256(avatar.read_bytes()).hexdigest(),'joints':names,'method':'8 nearest body bind-surface vertices; smooth garment-space weight field and normalized top four influences','clearanceMetres':.007,'liningSeparationPerSideMetres':.0015,'maximumSurfaceFitMetres':float(shift.max()),'bodyGeometryChanged':False,'refinement':refinement}
    d['buffers'][0]['byteLength']=len(b);jb=json.dumps(d,separators=(',',':')).encode();jb+=b' '*((-len(jb))%4);b.extend(b'\0'*((-len(b))%4))
    result=struct.pack('<III',0x46546c67,2,28+len(jb)+len(b))+struct.pack('<II',len(jb),0x4e4f534a)+jb+struct.pack('<II',len(b),0x004e4942)+b
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(result)
    report={'source':args.source.name,'sourceSha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),'output':args.output.name,'bytes':len(result),'sha256':hashlib.sha256(result).hexdigest(),'triangles':12052,'vertices':len(fitted),'fitBounds':{'min':fitted.min(0).tolist(),'max':fitted.max(0).tolist()},'binding':d['asset']['extras']['air3Binding']}
    args.output.with_suffix('.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='binding'}))
if __name__=='__main__':main()
