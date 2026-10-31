# AIR3 Live 3.0: Off-Shoulder Crop Top

The white off-shoulder crop top is the production-locked default wardrobe for AIR3 Live broadcasts.

## Tailoring and Geometric Refinement

The tailoring conversion pipeline applies a 15% nominal vertical compression while preserving the upper neckline shoulder anchor. Subsequent anatomical fitting to the presenter's torso geometry maintains accurate textile offset without skin penetration, resulting in an effective 13.45% vertical reduction compared to revision 2.3.

| Measurement (Reference Pose) | Production Metric |
|---|---:|
| Lower Hem Elevation | +41.56 mm |
| Overall Upper Anchor Delta | -0.016 mm |
| Center Front Hem Vertical Wave (Before) | 14.35 mm |
| Center Front Hem Vertical Wave (After) | 0.99 mm |
| Vertex Count | 6,403 |
| Triangle Count | 12,052 |

The front neckline is straightened into a smooth boat-neck collar contoured to the collarbones. Bust folds are lifted in alignment with the garment, maintaining natural drape without texture distortion.

## Material and Texture Shading

The garment material uses a warm white base with roughness 0.92. Baked shadows in the original texture are attenuated at shader level while preserving woven fabric details. Subtle cream highlights and faint lilac undertones provide realistic depth across camera angles. A fine procedural micro-weave texture prevents aliasing or moiré under 1080p video compression.

The material responds accurately to physical studio lights: shadowed rear folds appear naturally darker than illuminated key-light surfaces.

## Skinning Integrity and Asset Hashes

Normals were recomputed and the four primary bone skinning weights per vertex were transferred and normalized. Topology and UV layouts match the source asset. The torso mask is elevated with the hemline, leaving the exposed midriff intact.

- Shipped garment asset: `studio-broadcast/public/assets/air3/clothing/crop-top.glb`
- Upstream source: Sketchfab `off_shoulder_top.glb` by DaaGHrii (CC BY 4.0)

## Verification

`test/crop-top-fit.test.mjs` verifies shoulder anchoring, hem elevation, neckline linearity, UV integrity, vertex/triangle counts, normal preservation, and bone weight normalization. Wardrobe tests verify seamless toggling between wardrobe styles and proper masking interaction with footwear.
