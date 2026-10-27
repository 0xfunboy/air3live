#!/usr/bin/env python3
"""Reproducible material-data bake for the supplied #AIR3 export.

No geometry, rig or source texture is altered. Read the supplied UE parameter
metadata; pack color/roughness/coverage maps for the Three.js material adapter.
The shader graphs and UE color-picker palettes were not exported. Their
replacement formulas are declared below and in the resulting report.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def linear(rgb):
    rgb = np.asarray(rgb, dtype=np.float32)
    return np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)


def srgb(rgb):
    rgb = np.clip(rgb, 0, 1)
    return np.where(rgb <= .0031308, rgb * 12.92, 1.055 * rgb ** (1 / 2.4) - .055)


def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--assets', type=Path, default=Path(__file__).resolve().parents[1] / 'studio-broadcast/public/assets/air3')
    args = ap.parse_args()
    root = args.assets.resolve()
    metadata = json.loads((root / 'metadata/air3-missing-metadata.json').read_text(encoding='utf-8'))
    textures = root / 'textures'
    out = textures / 'render'
    out.mkdir(exist_ok=True)
    source_records = {}
    outputs = []

    def load(name, size=None, mode='RGB'):
        matches = sorted(p for p in textures.rglob(name) if 'render' not in p.parts)
        if len(matches) != 1:
            raise RuntimeError(f'Expected one source for {name}; found {matches}')
        p = matches[0]
        source_records[str(p.relative_to(root))] = {
            'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
        im = Image.open(p).convert(mode)
        if size and im.size != (size, size):
            im = im.resize((size, size), Image.Resampling.LANCZOS)
        return im

    def save(name, data, color=False, lossless=False):
        a = np.clip(np.rint(np.asarray(data) * 255), 0, 255).astype(np.uint8)
        im = Image.fromarray(a)
        p = out / name
        temporary = out / (name + '.tmp')
        if name.endswith('.webp'):
            im.save(temporary, format='WEBP', quality=95, method=6, lossless=lossless, exact=True)
        else:
            im.save(temporary, format='PNG', optimize=True)
        temporary.replace(p)
        with Image.open(p) as checked:
            checked.load()
            assert checked.size == im.size
        outputs.append({'path': str(p.relative_to(root)), 'dimensions': list(im.size),
                        'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
                        'color_space': 'sRGB' if color else 'linear data'})

    head = next(v for k, v in metadata['materials'].items()
                if '/AIR3/Face/Materials/Baked/MI_HeadSynthesized_Baked.' in k)
    params, vectors = head['resolved_scalars'], head['resolved_vectors']
    # Masks are data: R foundation/G concealer/B blusher;
    # R eye shadow/G eye liner/B lipstick. Confirmed from channel imagery.
    n = 2048
    base_image = load('FaceColor_MAIN.webp', n)
    base = linear(np.asarray(base_image, dtype=np.float32) / 255)
    foundation = np.asarray(load('FaceFoundationBlusherMask.png', n), dtype=np.float32) / 255
    eye_lip = np.asarray(load('FaceEyeLipstickMask.png', n), dtype=np.float32) / 255
    color = base.copy()
    foundation_color = np.array(vectors['FoundationMakeupColor'][:3], dtype=np.float32)
    # Preserve scanned illumination-free skin detail. A low opacity prevents
    # replacement of the scan by a flat swatch and reduces neck/body seams.
    soft = linear(np.asarray(base_image.filter(ImageFilter.GaussianBlur(12)), dtype=np.float32) / 255)
    luminance = np.sum(base * [.2126, .7152, .0722], axis=-1)
    smooth_luminance = np.sum(soft * [.2126, .7152, .0722], axis=-1)
    detail = np.clip(luminance / np.maximum(smooth_luminance, .015), .75, 1.3)
    # The scan contains strong localized nose redness. Match the foundation
    # chroma more strongly there while keeping the measured luminance detail.
    redness = np.clip((.45 - base[..., 1] / np.maximum(base[..., 0], .025)) / .30, 0, 1)
    f = foundation[..., 0] * params.get('FoundationMakeupIntensity', 0) * (.18 + .32 * redness)
    color = color * (1 - f[..., None]) + foundation_color * detail[..., None] * f[..., None]
    blush = foundation[..., 2] * params.get('BlusherMakeupIntensity', 0) * .20
    blush_color = np.array(vectors['BlusherMakeupColor'][:3], dtype=np.float32)
    color = color * (1 - blush[..., None]) + blush_color * detail[..., None] * blush[..., None]
    shadow = eye_lip[..., 0] * (1 - params.get('EyeMakeupTransparency', 0)) * .48
    liner = eye_lip[..., 1] * .78
    shadow_color = np.array(vectors['EyeMakeupPrimaryColor'][:3], dtype=np.float32)
    color = color * (1 - shadow[..., None]) + shadow_color * shadow[..., None]
    color *= 1 - liner[..., None]
    lip = eye_lip[..., 2] * (1 - params.get('LipstickTransparency', 1)) * .92
    lip_color = np.array(vectors['LipstickColor'][:3], dtype=np.float32)
    color = color * (1 - lip[..., None]) + lip_color * detail[..., None] * lip[..., None]
    save('FaceBeautyColor.webp', srgb(color), color=True)
    raw_rough = np.asarray(load('FaceRoughness_MAIN.png', 1024), dtype=np.float32)[..., 0] / 255
    raw_cavity = np.asarray(load('FaceCavity_MAIN.png', 1024), dtype=np.float32)[..., 0] / 255
    lip_small = np.asarray(load('FaceEyeLipstickMask.png', 1024), dtype=np.float32)[..., 2] / 255
    rough = np.clip(.28 + raw_rough * .44, .29, .75)
    rough = rough * (1 - lip_small) + params.get('LipstickRoughness', .33) * lip_small
    # glTF packed ORM: R occlusion, G roughness, B metallic. Mild cavity
    # prevents baked cavity data being counted as full screen-space shadows.
    orm = np.stack([1 - .25 * (1 - raw_cavity), rough, np.zeros_like(rough)], -1)
    save('FaceBeautyORM.png', orm)

    hair_reports = []
    for label, stem, size, gamma, opacity, cutoff in [('Hair', 'Hair_S_UpdoBuns', 2048, .5, 2.0, .33),
                                                     ('Brows', 'Eyebrows_M_Shaded', 2048, .5, .8, .20)]:
        attr = np.asarray(load(stem + '_CardsAtlas_Attribute.png', size, 'RGBA'), dtype=np.float32) / 255
        tangent = np.asarray(load(stem + '_CardsAtlas_Tangent.png', size, 'RGBA'), dtype=np.float32) / 255
        # The exported MI_Hair_Cards uses OpacityNear/Far=2 and Pow=.5.
        # MI_Facial_Hair uses OpacityNear=.8/Pow=.5. Applying only raw coverage
        # made the browser representation too sparse at broadcast distances.
        coverage = np.clip(np.clip(attr[..., 0], 0, 1) ** gamma * opacity, 0, 1)
        # R coverage is verified in the supplied Compact/Layout2 atlases.
        # Tangent alpha is the longitudinal root-to-tip ramp. Attribute G/B
        # are data and are never interpreted as hair RGB.
        root_tip = tangent[..., 3]
        strand = np.clip(.72 + .28 * attr[..., 2], .72, 1)
        melanin = params.get('HairMelanin' if label == 'Hair' else 'EyebrowsMelanin', .89)
        base_rgb = linear(np.array([.155, .105, .076] if label == 'Hair' else [.12, .079, .057]))
        shade = (.74 + .31 * root_tip) * strand * (1.1 - .10 * melanin)
        rgb = np.broadcast_to(srgb(base_rgb[None, None, :] * shade[..., None]), (size, size, 3))
        save(label + 'ColorCoverage.webp', np.dstack([rgb, coverage]), color=True, lossless=True)
        # The source tangent is a vector, not a normal map. Encode XY direction
        # for Three's anisotropic BRDF, after normalising the planar projection.
        tangent_small = np.asarray(load(stem + '_CardsAtlas_Tangent.png', 512, 'RGBA'), dtype=np.float32) / 255
        direction = tangent_small[..., :2] * 2 - 1
        length = np.linalg.norm(direction, axis=-1, keepdims=True)
        direction = np.divide(direction, np.maximum(length, 1e-5))
        strength = np.ones((512, 512, 1), dtype=np.float32)
        save(label + 'Anisotropy.png', np.concatenate([direction * .5 + .5, strength], -1))
        hair_reports.append({'name': label, 'coverage_channel': 'Attribute.R', 'source_alpha': 'constant 1; not coverage',
                             'tangent_alpha': 'root-to-tip gradient', 'coverage_power': gamma,
                             'opacity_multiplier_from_ue': opacity, 'alpha_test': cutoff,
                             'coverage_fraction_at_test': float((coverage > cutoff).mean())})
    lash = np.asarray(load('Eyelashes_L_Curl_Coverage.png', 1024, 'L'), dtype=np.float32) / 255
    save('LashesCoverage.png', np.repeat((lash ** .75)[..., None], 3, axis=-1))

    # Eye shader palettes are referenced by UV indices in UE but were not
    # exported. Use an explicit, editable natural hazel palette. Source masks
    # provide fibril detail, not literal RGB color.
    n = 1024
    sclera = linear(np.asarray(load('T_Sclera_D.png', n), dtype=np.float32) / 255)
    eye = np.clip(sclera * 1.04, 0, 1)
    masks = np.asarray(load('T_Iris_A_M.png', 1024, 'RGBA'), dtype=np.float32) / 255
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    u, v = (xx + .5) / n, (yy + .5) / n
    rad = np.hypot(u - .5, v - .5)
    source_x = np.clip(np.rint(((u - .5) * 2.83 + .5) * (n - 1)), 0, n - 1).astype(int)
    source_y = np.clip(np.rint(((v - .5) * 2.83 + .5) * (n - 1)), 0, n - 1).astype(int)
    sampled = masks[source_y, source_x]
    light = linear(np.array([.39, .31, .18], dtype=np.float32))
    dark = linear(np.array([.14, .17, .105], dtype=np.float32))
    detail = np.clip((sampled[..., 0] - .16) * 1.9, 0, 1)
    iris = dark + (light - dark) * detail[..., None]
    iris *= (.75 + sampled[..., 1][..., None] * .40)
    limbus = smoothstep(.145, .163, rad)
    iris *= (1 - .73 * limbus[..., None])
    pupil = 1 - smoothstep(.039, .047, rad)
    iris = iris * (1 - pupil[..., None]) + .0012 * pupil[..., None]
    iris_mask = 1 - smoothstep(.162, .170, rad)
    eye = eye * (1 - iris_mask[..., None]) + iris * iris_mask[..., None]
    save('EyeColor.webp', srgb(eye), color=True)
    # Vector-correct resampling of the real sclera normal.
    normal = np.asarray(load('T_Sclera_N.png', 1024), dtype=np.float32) / 255 * 2 - 1
    normal /= np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-6)
    save('EyeNormal.png', normal * .5 + .5)

    # Teeth and gum UV rows were measured on the exported mesh. The material
    # palette texture is absent, so this is a declared procedural substitute.
    n = 512
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    u, v = (xx + .5) / n, (yy + .5) / n
    gum = linear(np.array([.45, .19, .18], dtype=np.float32))
    ivory = linear(np.array([.75, .73, .67], dtype=np.float32))
    upper = smoothstep(.035, .052, v) * (1 - smoothstep(.164, .187, v))
    lower = smoothstep(.210, .230, v) * (1 - smoothstep(.305, .325, v))
    tooth = np.maximum(upper, lower)
    oral = np.broadcast_to(gum, (n, n, 3)).copy()
    oral = oral * (1 - tooth[..., None]) + ivory * tooth[..., None]
    # Tongue UV island is distinct from teeth (u>.48,v~.44-.68).
    tongue = (u > .47) & (v > .43) & (v < .68)
    oral[tongue] = linear(np.array([.43, .19, .20]))
    save('MouthColor.webp', srgb(oral), color=True)
    mouth_rough = .62 * (1 - tooth) + .46 * tooth
    mouth_rough[tongue] = .68
    save('MouthORM.png', np.stack([np.ones_like(mouth_rough), mouth_rough, np.zeros_like(mouth_rough)], -1))

    # Small repeatable woven-fabric bump for supplied garments; no displacement
    # and no alteration of the garment silhouette or skin weights.
    n = 128
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    weave = .5 + .16 * np.sin(xx * np.pi / 4) * np.sin(yy * np.pi / 4)
    weave += .05 * np.sin(xx * np.pi / 2)
    save('ClothWeave.png', np.repeat(weave[..., None], 3, axis=-1))
    report = {
        'schema': 'air3.material-bake.v1', 'source_metadata_engine': metadata['engine_version'],
        'source_files_modified': False, 'source_images': source_records, 'outputs': outputs,
        'output_bytes': sum(e['bytes'] for e in outputs),
        'verified_channels': {'FaceEyeLipstickMask': {'R': 'eye shadow', 'G': 'eye liner', 'B': 'lipstick'},
                              'FaceFoundationBlusherMask': {'R': 'foundation', 'G': 'concealer', 'B': 'blusher'},
                              'T_Iris_A_M': 'packed data masks, not an albedo'},
        'face_source_parameters': {k: v for k, v in params.items() if any(s in k for s in ['Makeup', 'Lipstick'])},
        'face_source_vectors': {k: v for k, v in vectors.items() if any(s in k for s in ['Makeup', 'Lipstick'])},
        'hair': hair_reports,
        'eye_uv': {'center': [.5, .5], 'iris_radius': .166, 'pupil_radius': .043,
                   'approximate_physical_iris_diameter_mm': 11.3,
                   'palette': 'natural hazel, explicit art direction; missing original color-picker lookup texture'},
        'approximations': [
            'UE material graphs were not supplied; compositing formulas are a documented visual reconstruction.',
            'Foundation/eye-shadow opacity is restrained while preserving scanned luminance detail and body/neck matching; foundation chroma blends more strongly in the scan\'s highly red regions.',
            'Packed tangent XY is projected into the card UV anisotropic BRDF; this is not UE Marschner hair shading.',
            'Corneal appearance uses physical clearcoat and a bounded view-dependent iris offset, not full ocular ray refraction.',
            'Original eye-color and teeth/gum palette lookup textures are missing; editable natural palettes are used.',
            'No full skin subsurface-scattering or animated wrinkle-map shader is claimed.'
        ]}
    report_path = root / 'metadata/material-bake-report.json'
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'outputs': len(outputs), 'bytes': report['output_bytes'], 'report': str(report_path)}, indent=2))


if __name__ == '__main__':
    main()
