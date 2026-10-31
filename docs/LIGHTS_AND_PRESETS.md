# Studio Lighting and Look Presets

AIR3 Live utilizes a physically modeled **5-point conical spotlight rig** calibrated for virtual broadcasting: diffuse ambient 0.0, IBL environment 0.17, tone mapping exposure 0.95.

## Studio Spotlight Rig Architecture

The 5 spotlights are true physical `THREE.SpotLight` instances with quadratic distance falloff:

1. **Key Light (Front Right, Elevated)**: Primary directional light defining facial features and eye catchlights.
2. **Right Rim Light**: Accentuates silhouette and hair separation.
3. **Left Fill Light (Subtle)**: Softens shadows across the left cheek and neck.
4. **Backlight Left (Cyan Accent)**: Edge illumination separating the presenter from dark set areas.
5. **Backlight Right (Warm Amber Accent)**: Warm shoulder rim light emphasizing stage depth.

| Parameter | Unit / Range | Description |
|---|---|---|
| Diffuse Ambient | 0.0 - 1.0 | Hemispheric ambient light level |
| Environment & IBL | 0.0 - 2.0 | HDR/IBL reflection map intensity |
| Tone Mapping Exposure | 0.5 - 2.0 | Scene-wide ACES tone mapping exposure |
| Spotlight Power | Candela (cd) | Physical luminous intensity with quadratic falloff |
| Ring Azimuth | Degrees | Angular position around presenter (-180° to +180°) |
| Distance | Meters | Radius from stage anchor center |
| Fixture Height | Meters | Elevation above floor plane |
| Target Height | Meters | Elevation of spotlight focal aim point |
| Beam Half-Angle | Degrees | Angle between fixture axis and cone perimeter |
| Penumbra | 0.0 - 1.0 | Edge softness of the spotlight cone |
| Color | sRGB Hex | Color temperature and chromatic tint |
| Cast Shadows | Boolean | Enables depth shadow map rendering |
| Track Presenter | Boolean | Directs fixture aim to follow presenter during roaming |

## Quality Profiles and Shadows

- **High**: Full shadow maps computed on all active spotlights, GTAO enabled, 1024×1024 planar floor reflections.
- **Balanced**: Key light shadow map enabled, planar floor reflections at 512×512, GTAO bypassed.
- **Software**: Key shadow map only, reflections disabled, optimized for CPU testing.
