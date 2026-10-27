#!/usr/bin/env python3
"""Reproducible hair packaging from the user-supplied GLB/ZIP originals.
Preserves position, normal, index, weight and inverse-bind buffers exactly;
canonicalizes joint indices only for exactly zero-weight unused influence slots;
extracts external textures and transcodes author maps for the browser.
"""
import argparse, hashlib, io, json, shutil, struct, zipfile
from pathlib import Path
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
COLORS={'copper':1,'auburn':2,'blonde':3,'chestnut':4,'dark-brown':5,'black':6}

def unpack(path):
    raw=path.read_bytes(); n=struct.unpack_from('<I',raw,12)[0]
    data=json.loads(raw[20:20+n]); offset=20+n
    return data, raw[offset+8:offset+8+struct.unpack_from('<I',raw,offset)[0]]

def pack(data, blob, output):
    js=json.dumps(data,separators=(',',':')).encode(); js+=b' '*((-len(js))%4)
    blob+=b'\x00'*((-len(blob))%4)
    output.write_bytes(struct.pack('<III',0x46546c67,2,28+len(js)+len(blob))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(blob),0x004e4942)+blob)

def optimize_geometry(path, output, style):
    data,blob=unpack(path)
    images=[]
    for item in data.get('images',[]):
        view=data['bufferViews'][item['bufferView']]; start=view.get('byteOffset',0)
        images.append(blob[start:start+view['byteLength']])
    image_views={i['bufferView'] for i in data.get('images',[])}
    remap={}; views=[]; body=bytearray()
    for index,view in enumerate(data['bufferViews']):
        if index in image_views:continue
        remap[index]=len(views); start=view.get('byteOffset',0)
        body.extend(b'\x00'*((-len(body))%4)); replacement=dict(view)
        replacement['byteOffset']=len(body); body.extend(blob[start:start+view['byteLength']]); views.append(replacement)
    for a in data['accessors']:
        if 'bufferView'in a:a['bufferView']=remap[a['bufferView']]
        if 'sparse'in a:
            for key in ['indices','values']:a['sparse'][key]['bufferView']=remap[a['sparse'][key]['bufferView']]
    data['bufferViews']=views;data['buffers']=[{'byteLength':len(body)}]
    # glTF validation requires unused JOINTS slots to be zero. Their matching
    # weights are exactly zero: this changes no weighted skin deformation.
    formats={5120:'b',5121:'B',5122:'h',5123:'H',5125:'I',5126:'f'}
    canonicalized=0; seen=set()
    for mesh in data['meshes']:
        for primitive in mesh['primitives']:
            attrs=primitive['attributes']
            for suffix in ('0','1','2'):
                jk,wk='JOINTS_'+suffix,'WEIGHTS_'+suffix
                if jk not in attrs or wk not in attrs:continue
                pair=(attrs[jk],attrs[wk])
                if pair in seen:continue
                seen.add(pair)
                ja,wa=(data['accessors'][i] for i in pair)
                if 'sparse'in ja or 'sparse'in wa:raise ValueError('Sparse skin data needs explicit expansion')
                if ja['count']!=wa['count'] or ja['type']!='VEC4' or wa['type']!='VEC4':raise ValueError('Unexpected skin accessor layout')
                jv,wv=(data['bufferViews'][a['bufferView']] for a in (ja,wa))
                jf,wf='<'+formats[ja['componentType']],'<'+formats[wa['componentType']]
                jsz,wsz=struct.calcsize(jf),struct.calcsize(wf)
                jstart=jv.get('byteOffset',0)+ja.get('byteOffset',0);wstart=wv.get('byteOffset',0)+wa.get('byteOffset',0)
                jstride=jv.get('byteStride',jsz*4);wstride=wv.get('byteStride',wsz*4)
                for row in range(ja['count']):
                    for component in range(4):
                        jp=jstart+row*jstride+component*jsz;wp=wstart+row*wstride+component*wsz
                        if struct.unpack_from(wf,body,wp)[0]==0 and struct.unpack_from(jf,body,jp)[0]!=0:
                            struct.pack_into(jf,body,jp,0);canonicalized+=1
    # Textures are bound by the wardrobe controller. The GLB contains geometry
    # and skeleton only; this avoids loading duplicate colors on every switch.
    for m in data.get('materials',[]):
        name=m.get('name','hair');m.clear();m.update({'name':name,'doubleSided':True,'alphaMode':'MASK','alphaCutoff':.28,'pbrMetallicRoughness':{'metallicFactor':0,'roughnessFactor':.8}})
    data.pop('images',None);data.pop('textures',None);data.pop('samplers',None)
    data.pop('extensionsRequired',None);data.pop('extensionsUsed',None)
    data.setdefault('asset',{})['generator']='AIR3 hair packaging; mesh/weights/bind preserved, unused joint slots zeroed'
    data.setdefault('extras',{})['air3Hair']={'style':style,'sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'geometryChanged':False,'unusedJointSlotsCanonicalized':canonicalized}
    pack(data,bytes(body),output)
    tris=sum(data['accessors'][p['indices']]['count']//3 for m in data['meshes'] for p in m['primitives'])
    return images,{'sourceBytes':path.stat().st_size,'geometryBytes':output.stat().st_size,'triangles':tris,'vertices':sum(data['accessors'][p['attributes']['POSITION']]['count'] for m in data['meshes'] for p in m['primitives']),'joints':len(data['skins'][0]['joints']),'geometryChanged':False,'positionsNormalsUVsIndicesWeightsAndBindMatricesUnchanged':True,'unusedJointSlotsCanonicalized':canonicalized,'sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest()}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--input',required=True,type=Path);args=ap.parse_args()
    source=ROOT/'source-assets/lookdev/hair';source.mkdir(parents=True,exist_ok=True)
    out=ROOT/'studio-broadcast/public/assets/air3/hair';out.mkdir(parents=True,exist_ok=True)
    for name in ['ponytail_1_artemis_-_character_hair_free.glb','wavy_white_ponytail_with_bones.glb','ponytail-1-artemis-character-hair-free.zip','wavy-white-ponytail-with-bones.zip']:
        if (args.input/name).resolve() != (source/name).resolve(): shutil.copy2(args.input/name,source/name)
    report={'schema':'air3.hair-assets.v1','styles':{},'colors':[],'duplicates':['ponytail_1_artemis_-_character_hair_free (1).glb is byte-identical; not duplicated']}
    for style,name in [('artemis','ponytail_1_artemis_-_character_hair_free.glb'),('wavy','wavy_white_ponytail_with_bones.glb')]:
        images,stats=optimize_geometry(source/name,out/(style+'.glb'),style);report['styles'][style]=stats
        if style=='artemis':
            im=Image.open(io.BytesIO(images[1])).convert('RGB');im.thumbnail((1024,1024),Image.Resampling.LANCZOS);im.save(out/'artemis-normal.png',optimize=True)
        else:(out/'wavy-source.png').write_bytes(images[0])
    with zipfile.ZipFile(source/'ponytail-1-artemis-character-hair-free.zip')as z:
        alpha=Image.open(io.BytesIO(z.read('textures/artemishair_diff_alpha.jpeg'))).convert('L');alpha.save(out/'artemis-alpha.png',optimize=True)
        nested=next(n for n in z.namelist() if n.endswith('.zip'))
        with zipfile.ZipFile(io.BytesIO(z.read(nested)))as inner:
            prefix='Hair - Artemis (Free) by continuumreed/'
            (source/'ARTEMIS_README.txt').write_bytes(inner.read(prefix+'_readme_artemishair.txt'))
            for color,number in COLORS.items():
                im=Image.open(io.BytesIO(inner.read(prefix+f'artemishair_diff_color{number}.png'))).convert('RGB')
                # Keep 2K strand detail, store alpha once in its dedicated map.
                path=out/f'artemis-{color}.webp';im.save(path,'WEBP',quality=90,method=6)
                report['colors'].append({'id':color,'authorTexture':number,'size':list(im.size),'bytes':path.stat().st_size,'file':path.name})
    report['runtimeFiles']=[{'file':f.name,'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()}for f in sorted(out.iterdir()) if f.is_file() and f.name!='manifest.json']
    report['runtimeTotalBytes']=sum(r['bytes']for r in report['runtimeFiles'])
    for style in ['wavy','artemis']:
        metadata=source/(style+'-source.json')
        if metadata.is_file():
            d=json.loads(metadata.read_text());report['styles'][style]['attribution']={'title':d['name'],'author':d['user']['displayName'],'username':d['user']['username'],'url':d['viewerUrl'],'license':d['license'],'retrieved':'2026-10-25'}
    report['styles']['wavy']['fitNotes']='Hairstyle-only cranial fit; first tail bone length0.70. See air3-hair-wardrobe.mjs for current fitting transforms.'
    report['styles']['artemis']['fitNotes']='Hairstyle-only cranial fit; source-space fringe offset0.045m, opposed bends0.12/-0.10radians. See air3-hair-wardrobe.mjs.'
    report['mapOrientation']={'artemis-color':'source FBX: flipY=true','artemis-alpha':'source FBX: flipY=true','artemis-normal':'extracted GLB: flipY=false','wavy':'extracted GLB: flipY=false'}
    (out/'manifest.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if __name__=='__main__':main()
