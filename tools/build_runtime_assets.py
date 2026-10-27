#!/usr/bin/env python3
"""Build the #AIR3 browser derivative. Originals are never modified.

This is a rendering derivative, NOT a lossless replacement for the source.
All anonymous morphs remain in sources-preserved/*.sparse.glb; they are omitted
here to avoid expanding hundreds of unused GPU morph layers. Geometry and all
available skin influences are retained. runtime/air3-avatar.mjs is required
to render the 8/12-influence primitives correctly with Three.js r186.
"""
import argparse
import copy
import hashlib
import json
import mmap
import struct
from pathlib import Path

import numpy as np

TYPES = {5120: 'i1', 5121: 'u1', 5122: '<i2', 5123: '<u2', 5125: '<u4', 5126: '<f4'}
WIDTHS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


class Source:
    def __init__(self, filename):
        self.path = Path(filename)
        self.file = self.path.open('rb')
        self.mm = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)
        magic, version, length = struct.unpack_from('<III', self.mm, 0)
        if (magic, version, length) != (0x46546c67, 2, len(self.mm)):
            raise ValueError('Invalid GLB header: ' + str(filename))
        length, kind = struct.unpack_from('<II', self.mm, 12)
        if kind != 0x4e4f534a:
            raise ValueError('Missing JSON chunk')
        self.json = json.loads(self.mm[20:20 + length])
        self.offset = 28 + length
        if struct.unpack_from('<I', self.mm, 24 + length)[0] != 0x004e4942:
            raise ValueError('Missing BIN chunk')

    def accessor(self, index):
        a = self.json['accessors'][index]
        dtype, width = np.dtype(TYPES[a['componentType']]), WIDTHS[a['type']]
        if 'bufferView' in a:
            v = self.json['bufferViews'][a['bufferView']]
            data = np.ndarray((a['count'], width), dtype=dtype, buffer=self.mm,
                              offset=self.offset + v.get('byteOffset', 0) + a.get('byteOffset', 0),
                              strides=(v.get('byteStride', width * dtype.itemsize), dtype.itemsize))
        else:
            data = np.zeros((a['count'], width), dtype=dtype)
        if 'sparse' in a:
            data = data.copy()
            sp = a['sparse']
            vi, vv = [self.json['bufferViews'][sp[k]['bufferView']] for k in ['indices', 'values']]
            ix = np.frombuffer(self.mm, dtype=TYPES[sp['indices']['componentType']], count=sp['count'],
                               offset=self.offset + vi.get('byteOffset', 0) + sp['indices'].get('byteOffset', 0))
            vals = np.frombuffer(self.mm, dtype=dtype, count=sp['count'] * width,
                                 offset=self.offset + vv.get('byteOffset', 0) + sp['values'].get('byteOffset', 0)).reshape(-1, width)
            data[ix] = vals
        return data

    def close(self):
        self.mm.close()
        self.file.close()


class Builder:
    def __init__(self, texture_root):
        self.json = {'asset': {'version': '2.0', 'generator': '#AIR3 browser asset builder 0.2'},
                     'scene': 0, 'scenes': [{'name': 'AIR3', 'nodes': []}], 'nodes': [], 'meshes': [],
                     'skins': [], 'materials': [], 'accessors': [], 'bufferViews': [], 'buffers': [],
                     'images': [], 'textures': [], 'samplers': [{'magFilter': 9729, 'minFilter': 9987,
                                                               'wrapS': 10497, 'wrapT': 10497}]}
        self.data = bytearray()
        self.texture_root = texture_root
        self.texture_indices = {}
        self.report = {'components': [], 'material_notes': [], 'geometry_decimated': False,
                       'morphs_in_runtime': False, 'skin_influences_truncated': False,
                       'repaired_zero_normals': []}
        self.bone_nodes = {}

    def add_bytes(self, raw, target=None):
        self.data.extend(b'\0' * ((-len(self.data)) % 4))
        view = {'buffer': 0, 'byteOffset': len(self.data), 'byteLength': len(raw)}
        if target:
            view['target'] = target
        index = len(self.json['bufferViews'])
        self.json['bufferViews'].append(view)
        self.data.extend(raw)
        return index

    def add_array(self, data, kind, component=5126, target=None, normalized=False, bounds=False):
        data = np.ascontiguousarray(data, dtype=TYPES[component])
        a = {'bufferView': self.add_bytes(data.tobytes(), target), 'componentType': component,
             'count': len(data), 'type': kind}
        if normalized:
            a['normalized'] = True
        if bounds:
            a['min'] = data.min(axis=0).reshape(-1).tolist()
            a['max'] = data.max(axis=0).reshape(-1).tolist()
        index = len(self.json['accessors'])
        self.json['accessors'].append(a)
        return index

    def copy_accessor(self, source, index, target=None):
        a = source.json['accessors'][index]
        return self.add_array(source.accessor(index), a['type'], a['componentType'], target,
                              a.get('normalized', False), 'min' in a)

    def texture(self, relative):
        if not (self.texture_root / relative).is_file():
            raise FileNotFoundError(self.texture_root / relative)
        if relative in self.texture_indices:
            return {'index': self.texture_indices[relative]}
        image_id = len(self.json['images'])
        self.json['images'].append({'uri': '../textures/' + relative})
        item = {'sampler': 0}
        if relative.endswith('.webp'):
            item['extensions'] = {'EXT_texture_webp': {'source': image_id}}
            self.json['extensionsUsed'] = ['EXT_texture_webp']
            self.json['extensionsRequired'] = ['EXT_texture_webp']
        else:
            item['source'] = image_id
        index = len(self.json['textures'])
        self.json['textures'].append(item)
        self.texture_indices[relative] = index
        return {'index': index}

    def material(self, original, component, index):
        name = original.get('name', 'material_' + str(index))
        m = {'name': component + '__' + name, 'pbrMetallicRoughness': {
            'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': .7}}
        pbr = m['pbrMetallicRoughness']
        if original.get('doubleSided'):
            m['doubleSided'] = True
        if component == 'body':
            pbr['baseColorTexture'] = self.texture('color/BodyBaseColor.webp')
        elif component == 'face':
            if index == 0:
                pbr['baseColorTexture'] = self.texture('color/FaceColor_MAIN.webp')
                pbr['metallicRoughnessTexture'] = self.texture('data/FaceRoughness_ORM.png')
                pbr['roughnessFactor'] = 1
                m['normalTexture'] = {**self.texture('data/FaceNormal_MAIN.png'), 'scale': .55}
                m['extras'] = {'air3NormalConvention': 'source-unverified', 'normalScaleY': -1,
                               'normalScaleNote': 'Preview assumes Unreal DirectX normal Y. Verify texture flip_green_channel in source project.'}
            else:
                pbr['baseColorFactor'] = [.6, .58, .54, 1]
                if index == 1:
                    pbr['baseColorFactor'] = [.72, .68, .58, 1]
                    pbr['roughnessFactor'] = .4
                elif index in (3, 4):
                    # Solid neutral preview only. No original iris/cornea texture was supplied.
                    pbr['baseColorFactor'] = [.24, .25, .23, 1]
                    pbr['roughnessFactor'] = .3
                else:
                    # Unexported opacity masks must not become opaque patches over the face.
                    pbr['baseColorFactor'] = [0, 0, 0, 0]
                    m['alphaMode'] = 'MASK'
                    m['alphaCutoff'] = .5
                m['extras'] = {'air3MissingMaterialMaps': True, 'previewOnly': True}
        elif component == 'outfit':
            if index == 0:
                pbr['baseColorTexture'] = self.texture('color/Unnamed_albedo.webp')
            elif index == 1:
                pbr['baseColorTexture'] = self.texture('color/1.webp')
                m['alphaMode'] = 'MASK'
                m['alphaCutoff'] = .4
                m['doubleSided'] = True
            else:
                pbr['baseColorFactor'] = [.8, .8, .78, 1]
                m['extras'] = {'air3MissingMaterialMaps': True, 'previewOnly': True}
        elif component in ('hair', 'brows'):
            # Original card geometry is retained. Color/coverage atlas is still missing.
            pbr['baseColorFactor'] = [.025, .015, .008, .32 if component == 'hair' else .2]
            m['alphaMode'] = 'BLEND'
            m['doubleSided'] = True
            m['extras'] = {'air3MissingMaterialMaps': True, 'previewOnly': True}
        else:
            mappings = {'table': (1, 'color/T_EntranceMiddleTable.webp'),
                        'keyboard': (0, 'color/T_EntranceKeyboard.webp'),
                        'laptop': (0, 'color/T_EntranceLaptop.webp')}
            if component in mappings and index == mappings[component][0]:
                pbr['baseColorTexture'] = self.texture(mappings[component][1])
            elif name == 'MI_Lights':
                pbr['baseColorFactor'] = [.02, .03, .04, 1]
                m['emissiveFactor'] = [.0, .25, .3]
            else:
                pbr['baseColorFactor'] = [.13, .16, .19, 1]
            if component == 'monitor':
                m['extras'] = {'air3ScreenMaterialMustBeCanvasTexture': True}
        out_index = len(self.json['materials'])
        self.json['materials'].append(m)
        return out_index

    def component(self, path, label):
        source = Source(path)
        d = source.json
        node_offset, mesh_offset, skin_offset = (len(self.json[k]) for k in ['nodes', 'meshes', 'skins'])
        mats = [self.material(m, label, i) for i, m in enumerate(d.get('materials', []))]
        triangles = vertices = extended = 0
        for mesh in d.get('meshes', []):
            out = {'name': label + '__' + mesh.get('name', 'mesh'), 'primitives': [],
                   'extras': {'air3Component': label}}
            for primitive_number, pr in enumerate(mesh['primitives']):
                p = {'attributes': {}, 'mode': pr.get('mode', 4)}
                if 'material' in pr:
                    p['material'] = mats[pr['material']]
                if 'indices' in pr:
                    p['indices'] = self.copy_accessor(source, pr['indices'], 34963)
                    triangles += d['accessors'][pr['indices']]['count'] // 3
                vertices += d['accessors'][pr['attributes']['POSITION']]['count']
                for semantic, ai in pr['attributes'].items():
                    if semantic == 'COLOR_0' or semantic.startswith(('JOINTS_', 'WEIGHTS_')):
                        continue
                    if semantic == 'NORMAL':
                        normals = source.accessor(ai).astype(np.float64)
                        lengths = np.linalg.norm(normals, axis=1)
                        invalid = lengths < 1e-10
                        if invalid.any():
                            positions = source.accessor(pr['attributes']['POSITION']).astype(np.float64)
                            indices = source.accessor(pr['indices']).reshape(-1, 3)
                            a, b, c = [positions[indices[:, i]] for i in range(3)]
                            face_normals = np.cross(b - a, c - a)
                            accumulated = np.zeros_like(normals)
                            for i in range(3):
                                np.add.at(accumulated, indices[:, i], face_normals)
                            for vertex in np.flatnonzero(invalid):
                                v = accumulated[vertex]
                                if np.linalg.norm(v) < 1e-10:
                                    valid = np.flatnonzero(~invalid)
                                    nearest = valid[np.argmin(np.sum((positions[valid] - positions[vertex]) ** 2, axis=1))]
                                    v = normals[nearest]
                                normals[vertex] = v
                            lengths = np.linalg.norm(normals, axis=1)
                            self.report['repaired_zero_normals'].append({'component': label,
                                'primitive': primitive_number, 'vertices': np.flatnonzero(invalid).tolist(),
                                'method': 'area-weighted incident face normals; nearest valid normal for degenerate triangles'})
                        normals /= lengths[:, None]
                        p['attributes'][semantic] = self.add_array(normals, 'VEC3', target=34962)
                        continue
                    p['attributes'][semantic] = self.copy_accessor(source, ai, 34962)
                weights, joints = [], []
                for n in range(3):
                    if 'WEIGHTS_' + str(n) not in pr['attributes']:
                        break
                    ai = pr['attributes']['WEIGHTS_' + str(n)]
                    a = d['accessors'][ai]
                    w = source.accessor(ai).astype(np.float64)
                    if a.get('normalized'):
                        w /= np.iinfo(TYPES[a['componentType']]).max
                    weights.append(w)
                    joints.append(source.accessor(pr['attributes']['JOINTS_' + str(n)]).copy())
                if weights:
                    # UE can emit the same joint several times for one vertex.
                    # Sum those contributions before normalization. This is the
                    # same linear skin transform, not a top-N approximation.
                    raw_weights = np.concatenate(weights, axis=1)
                    raw_joints = np.concatenate(joints, axis=1)
                    merged_weights = np.zeros_like(raw_weights)
                    merged_joints = np.zeros_like(raw_joints)
                    max_unique = 0
                    for row in range(len(raw_weights)):
                        influences = {}
                        for ji, wi in zip(raw_joints[row], raw_weights[row]):
                            if wi > 0:
                                influences[int(ji)] = influences.get(int(ji), 0.0) + float(wi)
                        values = sorted(influences.items(), key=lambda item: (-item[1], item[0]))
                        max_unique = max(max_unique, len(values))
                        for column, (ji, wi) in enumerate(values):
                            merged_joints[row, column] = ji
                            merged_weights[row, column] = wi
                    weights = [merged_weights[:, n:n + 4] for n in range(0, merged_weights.shape[1], 4)]
                    joints = [merged_joints[:, n:n + 4] for n in range(0, merged_joints.shape[1], 4)]
                    total = merged_weights.sum(axis=1, keepdims=True)
                    if np.any(total <= 0) or not np.isfinite(total).all():
                        raise ValueError('Invalid skin weights: ' + label)
                    count = len(weights)
                    while count > 1 and not np.any(weights[count - 1]):
                        count -= 1
                    for n in range(count):
                        w = (weights[n] / total).astype('<f4')
                        p['attributes']['WEIGHTS_' + str(n)] = self.add_array(w, 'VEC4', target=34962)
                        p['attributes']['JOINTS_' + str(n)] = self.add_array(joints[n], 'VEC4', 5123, 34962)
                    if count > 1:
                        # GLTFLoader renormalizes only set0. Restore its original share after loading.
                        share = (weights[0].sum(axis=1, keepdims=True) / total).astype('<f4')
                        p['attributes']['_AIR3_WEIGHT_SUM_0'] = self.add_array(share, 'SCALAR', target=34962)
                        p['extras'] = {'air3SkinInfluences': count * 4, 'requiresAir3SkinningAdapter': True}
                        extended += 1
                    p.setdefault('extras', {})['air3MaxUniqueInfluences'] = max_unique
                    p['extras']['duplicateJointsMerged'] = True
                out['primitives'].append(p)
            self.json['meshes'].append(out)
        for node in d.get('nodes', []):
            out = copy.deepcopy(node)
            old_name = out.get('name', 'root_mesh')
            out['name'] = label + '__' + old_name
            self.bone_nodes[(label, old_name)] = len(self.json['nodes'])
            if 'children' in out:
                out['children'] = [i + node_offset for i in out['children']]
            if 'mesh' in out:
                out['mesh'] += mesh_offset
            if 'skin' in out:
                out['skin'] += skin_offset
            out.pop('weights', None)
            self.json['nodes'].append(out)
        for skin in d.get('skins', []):
            out = copy.deepcopy(skin)
            out['joints'] = [i + node_offset for i in out['joints']]
            if 'skeleton' in out:
                out['skeleton'] += node_offset
            if 'inverseBindMatrices' in out:
                out['inverseBindMatrices'] = self.copy_accessor(source, skin['inverseBindMatrices'])
            self.json['skins'].append(out)
        self.json['scenes'][0]['nodes'] += [i + node_offset for i in d['scenes'][d.get('scene', 0)]['nodes']]
        self.report['components'].append({'component': label, 'source': Path(path).name,
            'triangles': triangles, 'vertices': vertices, 'skin12or8_primitives': extended,
            'source_morph_count': len(d.get('meshes', [{}])[0].get('primitives', [{}])[0].get('targets', []))})
        source.close()

    def animations(self, path):
        if not path.is_file():
            return
        source = Source(path)
        d = source.json
        self.json['animations'] = []
        cache = {}
        for anim in d.get('animations', []):
            out = {'name': anim['name'], 'samplers': [], 'channels': []}
            for sampler in anim['samplers']:
                s = copy.deepcopy(sampler)
                for key in ('input', 'output'):
                    if s[key] not in cache:
                        cache[s[key]] = self.copy_accessor(source, s[key])
                    s[key] = cache[s[key]]
                out['samplers'].append(s)
            for channel in anim['channels']:
                c = copy.deepcopy(channel)
                name = d['nodes'][c['target']['node']].get('name')
                node = self.bone_nodes.get(('body', name))
                if node is not None:
                    c['target']['node'] = node
                    out['channels'].append(c)
            if out['channels']:
                self.json['animations'].append(out)
        source.close()

    def write(self, path):
        self.json['buffers'] = [{'byteLength': len(self.data)}]
        is_avatar = any(c['component'] == 'body' for c in self.report['components'])
        self.json['scenes'][0]['extras'] = {'air3': {
            'profile': 'browser-geometry-with-skeletal-animation' if is_avatar else 'studio-prop',
            'version': 1, 'requiresSkinningAdapter': is_avatar,
            'anonymousMorphsArchivedSeparately': is_avatar,
            'facialLipSync': 'pending-verified-mapping' if is_avatar else 'not-applicable',
            'missingMaterialMaps': ['hair coverage/color', 'eyebrow coverage/color',
                                    'eyelash opacity', 'iris/cornea', 'teeth/gums'] if is_avatar else [],
            'normalConvention': 'source-export-pending-settings-verification' if is_avatar else 'not-applicable'}}
        for key in ('skins', 'images', 'textures', 'animations'):
            if not self.json.get(key):
                self.json.pop(key, None)
        raw = json.dumps(self.json, separators=(',', ':'), ensure_ascii=True).encode()
        raw += b' ' * ((-len(raw)) % 4)
        self.data.extend(b'\0' * ((-len(self.data)) % 4))
        total = 12 + 8 + len(raw) + 8 + len(self.data)
        with path.open('wb') as f:
            f.write(struct.pack('<III', 0x46546c67, 2, total))
            f.write(struct.pack('<II', len(raw), 0x4e4f534a))
            f.write(raw)
            f.write(struct.pack('<II', len(self.data), 0x004e4942))
            f.write(self.data)
        self.report['output'] = {'file': path.name, 'bytes': path.stat().st_size,
                                'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                'animations': [x['name'] for x in self.json.get('animations', [])]}
        return self.report


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source', type=Path, required=True, help='extracted exported_air3_assets folder')
    p.add_argument('--package', type=Path, default=Path(__file__).resolve().parents[1])
    args = p.parse_args()
    (args.package / 'models').mkdir(exist_ok=True, parents=True)
    (args.package / 'reports').mkdir(exist_ok=True, parents=True)
    builder = Builder(args.package / 'textures')
    components = [('f_tal_unw_body', 'body'), ('ScothSkirtWhitheShirtNewBalance', 'outfit'),
                  ('AI_MetaHumanIdentity_FaceMesh', 'face'), ('Hair_S_UpdoBuns_CardsMesh', 'hair'),
                  ('Eyebrows_M_Shaded_CardsMesh', 'brows')]
    for filename, name in components:
        builder.component(args.source / 'meshes' / (filename + '.glb'), name)
    builder.animations(args.package / 'animations' / 'body-clips.glb')
    report = builder.write(args.package / 'models' / 'AIR3-runtime.glb')
    props = []
    for filename, name in [('SM_Entrance_MiddleTable', 'table'), ('SM_Entrance_Chair', 'chair'),
                           ('SM_Laptop', 'laptop'), ('SM_Keyboard', 'keyboard'), ('Mod_16x9_moniotr', 'monitor')]:
        b = Builder(args.package / 'textures')
        b.component(args.source / 'meshes' / (filename + '.glb'), name)
        props.append(b.write(args.package / 'models' / (filename + '.glb')))
    report['props'] = props
    (args.package / 'reports' / 'runtime-assets.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['output'], indent=2))


if __name__ == '__main__':
    main()
