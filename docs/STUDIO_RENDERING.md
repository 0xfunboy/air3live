# 3D Studio Rendering and Post-Processing Pipeline

The studio stage rendering engine delivers high-end television broadcast quality using Three.js WebGL2.

## Lighting and Environment

- **PMREM Environment**: Physically modeled softbox studio environment converted into a prefiltered cube-UV map via `THREE.PMREMGenerator`.
- **Physical Spotlights**: 5 conical spotlights with quadratic distance attenuation.
- **Tone Mapping**: ACES Filmic tone mapping operating in linear sRGB half-float color space.

## Post-Processing Passes

1. **Ground Truth Ambient Occlusion (GTAO)**: High-performance ambient occlusion computed at 60% resolution with bilateral depth filtering, enhancing contact shadows around the presenter's neck, desk, and footwear.
2. **Planar Floor Reflections**: Real-time planar mirror camera generating a 1024×1024 reflection texture of the stage and presenter, modulated by floor roughness and Fresnel equations.
3. **HDR Bloom**: Subtle broadcast bloom pass with luminance threshold 1.50 and intensity 0.12.
4. **Anti-Aliasing**: Multi-sample anti-aliasing (MSAA 4x) on hardware profiles; FXAA pass on balanced profiles.

## Profiles

- `high`: GTAO + 1024 Planar Reflections + 5 Spotlight Shadows + Bloom + MSAA 4x.
- `balanced`: 512 Planar Reflections + Key Light Shadow + Bloom + FXAA.
- `software`: Bypasses GTAO and reflections for ultra-lightweight CPU execution.
