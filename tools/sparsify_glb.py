#!/usr/bin/env python3
"""Losslessly repack a GLB using glTF sparse accessors for zero-heavy arrays.

Python 3 + NumPy. No geometric decimation, quantization, skin pruning, morph
selection or naming inference. Referenced accessor indices, metadata and logical
raw component bytes are retained. Trailing unreferenced export debris is removed,
including invalid count-zero accessors emitted by Unreal in the supplied asset.
The output is a source/archive asset: Three.js
can expand sparse morph arrays to large dense allocations when loading it.

Supported input: glTF 2 GLB, one embedded binary buffer, ordinary (optionally
sparse/interleaved) accessors with scalar/vector values or 32-bit matrices.
Mesh compression / external buffers / extensions referencing buffers directly
are deliberately rejected. Unknown bufferView extensions are rejected.

Usage:
  python3 sparsify_glb.py INPUT.glb OUTPUT.glb --report REPORT.json
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import mmap
from pathlib import Path
import struct
import time

import numpy as np

DTYPES = {5120:'<i1',5121:'<u1',5122:'<i2',5123:'<u2',5125:'<u4',5126:'<f4'}
COMPONENTS = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT2':4,'MAT3':9,'MAT4':16}
UNSUPPORTED_EXTENSIONS = {'KHR_draco_mesh_compression','EXT_meshopt_compression',
                          'EXT_mesh_gpu_instancing'}


class BinaryGLTF:
    def __init__(self,path):
        self.path=Path(path)
        self.file=self.path.open('rb')
        self.data=mmap.mmap(self.file.fileno(),0,access=mmap.ACCESS_READ)
        magic,version,length=struct.unpack_from('<III',self.data)
        if magic!=0x46546c67 or version!=2 or length!=len(self.data):
            raise ValueError('Invalid GLB 2.0 header')
        offset=12
        self.bin_offset=None
        self.doc=None
        while offset<length:
            size,kind=struct.unpack_from('<II',self.data,offset)
            offset+=8
            if offset+size>length:raise ValueError('Invalid GLB chunk length')
            if kind==0x4e4f534a:
                if self.doc is not None:raise ValueError('Multiple JSON chunks')
                self.doc=json.loads(self.data[offset:offset+size])
            elif kind==0x004e4942:
                if self.bin_offset is not None:raise ValueError('Multiple BIN chunks')
                self.bin_offset=offset
                self.bin_length=size
            else:
                raise ValueError('Unknown GLB chunk; would not be preserved')
            offset+=size
        if self.doc is None or self.bin_offset is None:raise ValueError('Missing JSON/BIN')
        buffers=self.doc.get('buffers',[])
        if len(buffers)!=1 or 'uri' in buffers[0]:raise ValueError('Expected one embedded buffer')
        if buffers[0].get('extensions'):raise ValueError('Buffer extensions are not supported')
        if self.bin_length<buffers[0]['byteLength']:raise ValueError('Truncated binary buffer')
        if set(self.doc.get('extensionsUsed',[]))&UNSUPPORTED_EXTENSIONS:
            raise ValueError('Mesh compression/instancing input requires a separate decoder')
        for view in self.doc.get('bufferViews',[]):
            if view.get('buffer')!=0 or view.get('extensions'):
                raise ValueError('External buffers or bufferView extensions are unsupported')

    def view(self,index,offset,count,components,dtype,stride=None):
        v=self.doc['bufferViews'][index]
        dtype=np.dtype(dtype)
        stride=stride or v.get('byteStride',dtype.itemsize*components)
        nbytes=0 if not count else stride*(count-1)+components*dtype.itemsize
        if offset+nbytes>v['byteLength']:raise ValueError('Accessor outside bufferView')
        return np.ndarray((count,components),dtype=dtype,buffer=self.data,
            offset=self.bin_offset+v.get('byteOffset',0)+offset,
            strides=(stride,dtype.itemsize))

    def accessor(self,index):
        a=self.doc['accessors'][index]
        dtype=np.dtype(DTYPES[a['componentType']])
        components=COMPONENTS[a['type']]
        if a['type'].startswith('MAT') and dtype.itemsize<4:
            raise ValueError('Matrix accessors with padded sub-32-bit columns are unsupported')
        if 'bufferView' in a:
            result=self.view(a['bufferView'],a.get('byteOffset',0),a['count'],components,dtype)
        else:
            result=np.zeros((a['count'],components),dtype=dtype)
        if 'sparse' in a:
            s=a['sparse'];indices=s['indices'];values=s['values']
            ix=self.view(indices['bufferView'],indices.get('byteOffset',0),s['count'],1,
                         DTYPES[indices['componentType']]).reshape(-1)
            if len(ix) and (ix[-1]>=a['count'] or np.any(ix[1:]<=ix[:-1])):
                raise ValueError('Invalid sparse index ordering/range')
            vals=self.view(values['bufferView'],values.get('byteOffset',0),s['count'],components,dtype)
            result=result.copy()
            result[ix]=vals
        return result

    def close(self):
        self.data.close()
        self.file.close()


def hash_file(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def logical_metadata(doc):
    d=copy.deepcopy(doc)
    d.pop('bufferViews',None)
    d.pop('buffers',None)
    for a in d.get('accessors',[]):
        for k in ['bufferView','byteOffset','sparse']:a.pop(k,None)
    return d


def repack(source,destination):
    if source.resolve()==destination.resolve():raise ValueError('Output must differ from source')
    original=BinaryGLTF(source)
    document=copy.deepcopy(original.doc)
    referenced=set()
    for mesh in document.get('meshes',[]):
        for primitive in mesh.get('primitives',[]):
            referenced.update(primitive.get('attributes',{}).values())
            if 'indices' in primitive:referenced.add(primitive['indices'])
            for target in primitive.get('targets',[]):referenced.update(target.values())
    for skin in document.get('skins',[]):
        if 'inverseBindMatrices' in skin:referenced.add(skin['inverseBindMatrices'])
    for animation in document.get('animations',[]):
        for sampler in animation.get('samplers',[]):
            referenced.add(sampler['input']);referenced.add(sampler['output'])
    if not referenced:raise ValueError('No ordinary accessor references')
    last=max(referenced)
    if last>=len(document.get('accessors',[])):raise ValueError('Invalid accessor index')
    omitted=[]
    for i,a in enumerate(document['accessors'][last+1:],start=last+1):
        raw=np.ascontiguousarray(original.accessor(i))
        omitted.append({'index':i,'count':a['count'],'type':a['type'],
                        'componentType':a['componentType'],'bytes':raw.nbytes,
                        'sha256':hashlib.sha256(raw).hexdigest()})
        del raw
    document['accessors']=document['accessors'][:last+1]
    if any(a['count']==0 for a in document['accessors']):
        raise ValueError('Empty accessor before last referenced index; manual cleanup required')
    blob=bytearray()
    views=[]
    kinds={'dense':0,'sparse':0,'implicit_zero':0}
    def append_view(payload,template=None):
        if len(payload)==0:raise ValueError('Zero-length bufferView is invalid')
        blob.extend(b'\0'*((-len(blob))%4))
        v=copy.deepcopy(template or {})
        for key in ['byteStride','byteOffset','byteLength','buffer']:v.pop(key,None)
        v.update(buffer=0,byteOffset=len(blob),byteLength=len(payload))
        index=len(views)
        views.append(v)
        blob.extend(payload)
        return index
    dense_bytes=0
    sparse_value_bytes=0
    for index,a in enumerate(document.get('accessors',[])):
        values=np.ascontiguousarray(original.accessor(index))
        dense_bytes+=values.nbytes
        # Detect nonzero bytes rather than !=0: preserve float negative zero and NaN payloads.
        row_bytes=values.view(np.uint8).reshape(len(values),values.shape[1]*values.dtype.itemsize)
        selected=np.flatnonzero(np.any(row_bytes!=0,axis=1))
        for key in ['bufferView','byteOffset','sparse']:a.pop(key,None)
        if len(selected)==0:
            kinds['implicit_zero']+=1
        else:
            maximum=int(selected[-1])
            index_type=5121 if maximum<=255 else 5123 if maximum<=65535 else 5125
            index_dtype=DTYPES[index_type]
            # Include a small fixed allowance for additional JSON in the size decision.
            sparse_size=len(selected)*(values.shape[1]*values.dtype.itemsize+np.dtype(index_dtype).itemsize)
            if sparse_size+160<values.nbytes:
                indices=selected.astype(index_dtype,copy=False)
                sparse_values=np.ascontiguousarray(values[selected])
                iv=append_view(indices.tobytes())
                vv=append_view(sparse_values.tobytes())
                a['sparse']={'count':len(selected),
                    'indices':{'bufferView':iv,'componentType':index_type},
                    'values':{'bufferView':vv}}
                sparse_value_bytes+=len(indices.tobytes())+sparse_values.nbytes
                kinds['sparse']+=1
            else:
                old=original.doc['accessors'][index]
                template=original.doc['bufferViews'][old['bufferView']] if 'bufferView' in old else None
                a['bufferView']=append_view(values.tobytes(),template)
                kinds['dense']+=1
        del values,row_bytes,selected
    # Preserve non-accessor bufferView references, e.g. embedded texture images.
    external_mapping={}
    def remap_views(node):
        if isinstance(node,dict):
            for key,value in node.items():
                if key=='bufferView' and isinstance(value,int):
                    if value not in external_mapping:
                        old=original.doc['bufferViews'][value]
                        start=original.bin_offset+old.get('byteOffset',0)
                        external_mapping[value]=append_view(original.data[start:start+old['byteLength']],old)
                    node[key]=external_mapping[value]
                else:remap_views(value)
        elif isinstance(node,list):
            for value in node:remap_views(value)
    for key,value in document.items():
        if key not in ['accessors','bufferViews','buffers']:remap_views(value)
    document['bufferViews']=views
    document['buffers']=[{**document['buffers'][0],'byteLength':len(blob)}]
    encoded=json.dumps(document,ensure_ascii=False,separators=(',',':')).encode()
    encoded+=b' '*((-len(encoded))%4)
    blob.extend(b'\0'*((-len(blob))%4))
    total=12+8+len(encoded)+8+len(blob)
    destination.parent.mkdir(parents=True,exist_ok=True)
    with destination.open('wb') as f:
        f.write(struct.pack('<III',0x46546c67,2,total))
        f.write(struct.pack('<II',len(encoded),0x4e4f534a));f.write(encoded)
        f.write(struct.pack('<II',len(blob),0x004e4942));f.write(blob)
    # Every logical accessor must round-trip with byte equality, including signed zero.
    packed=BinaryGLTF(destination)
    compared_bytes=0
    for i in range(len(document.get('accessors',[]))):
        left=np.ascontiguousarray(original.accessor(i))
        right=np.ascontiguousarray(packed.accessor(i))
        if left.dtype!=right.dtype or left.shape!=right.shape or not np.array_equal(left.view(np.uint8),right.view(np.uint8)):
            raise AssertionError(f'Accessor {i} is not bit-identical')
        compared_bytes+=left.nbytes
        del left,right
    # This asset has no images. BufferView references on images would need to be
    # normalized separately for this stricter metadata comparison.
    expected=copy.deepcopy(original.doc)
    expected['accessors']=expected['accessors'][:last+1]
    if not external_mapping and logical_metadata(expected)!=logical_metadata(packed.doc):
        raise AssertionError('Non-storage document metadata changed')
    report={'source':str(source.resolve()),'output':str(destination.resolve()),
        'source_bytes':source.stat().st_size,'output_bytes':destination.stat().st_size,
        'size_reduction_percent':100*(1-destination.stat().st_size/source.stat().st_size),
        'source_sha256':hash_file(source),'output_sha256':hash_file(destination),
        'source_accessor_count':len(original.doc.get('accessors',[])),
        'accessors_checked':len(document.get('accessors',[])),
        'accessor_raw_bytes_checked':compared_bytes,'all_accessor_bytes_identical':True,
        'referenced_accessor_indices_preserved':True,
        'omitted_unreferenced_trailing_accessor_count':len(omitted),
        'omitted_unreferenced_zero_count_accessors':sum(a['count']==0 for a in omitted),
        'omitted_unreferenced_accessor_details':omitted,
        'metadata_preserved':not bool(external_mapping),'accessor_storage':kinds,
        'new_binary_bytes':len(blob),'new_json_bytes':len(encoded),
        'geometry_decimated':False,'morphs_removed':False,'skin_weights_changed':False,
        'usage':'Preserved source/archive. Sparse morphs expand in ordinary Three.js; do not use as the production runtime avatar.'}
    original.close();packed.close()
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    parser.add_argument('destination',type=Path)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    start=time.monotonic()
    result=repack(args.source,args.destination)
    result['elapsed_seconds']=round(time.monotonic()-start,3)
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
