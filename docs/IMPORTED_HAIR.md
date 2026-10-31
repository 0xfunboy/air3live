# Imported Hairstyles and Color Palette

Wardrobe Module: `studio-broadcast/public/air3-hair-wardrobe.mjs`.

## Hairstyle Selections and Anatomical Fitting

The **Wavy Ponytail** is the production-locked default hairstyle for AIR3 Live: it features a clean center part, preserves unobstructed camera visibility of the eyes, and incorporates natural shoulder-length side waves alongside a dynamic ponytail. The ponytail geometry is shortened to 70% along the primary bone vector without modifying body anatomy. The cap volume is contoured to the AIR3 MetaHuman skull.

**Artemis** is available as a non-commercial comparison style, featuring longer bangs and fine strand cards. The front bang cluster is offset 4.5 cm laterally in source space with dual opposing curves (+0.12 and -0.10 rad) to ensure clear gaze tracking. The third option preserves the legacy short ponytail.

| Variant | Imported Triangles | Exported Vertices | Bones | Optimized GLB |
|---|---:|---:|---:|---:|
| Wavy Ponytail | 4,922 | 4,323 | 17 | 318 KB |
| Artemis Hair | 5,455 | 4,042 | 33 | 533 KB |
| Legacy Short Ponytail | 59,282 | — | Head bone | Procedural runtime generation |

Positions, normals, UVs, triangle winding indices, skinning weights, and inverse bind matrices are preserved. Zero-weight influence slots are normalized for glTF specification compliance.

Attachment binds to the immutable bind matrix of `body__head`. Secondary physics utilize analytical damped spring physics, reacting to head rotation velocity without clipping artifacts.

## Color Atlases and Espresso Palette

The look development palette provides **seven color choices**:

| ID | Label | Original Atlas Source |
|---|---|---|
| `blonde` | Blonde | color3 |
| `copper` | Copper | color1 |
| `auburn` | Auburn | color2 |
| `chestnut` | Chestnut | color4 |
| `dark-brown` | Dark Brown | color5 |
| `black` | Black | color6 |
| `espresso` | Espresso (Nearly Black) | Linear RGB midpoint (#3b2b21) |

Color atlases are stored in WebP 2048×2048 (quality 90). The runtime maintains only the active texture in VRAM, instantly releasing superseded textures upon selection. Eyebrows synchronize automatically with hair color changes.
