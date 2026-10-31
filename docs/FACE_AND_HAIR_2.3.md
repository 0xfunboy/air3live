# Face and Hair: Refinement

This revision preserves the user-selected Wavy hairstyle and its anatomical head fit. It introduces an intermediate color tone, smoother secondary spring physics, and targeted refinements to eye makeup and eyebrows. Original textures and UV layouts remain preserved.

## Espresso Hair Color

The color identifier is `espresso`, displayed in the UI as **Nearly Black Brown**. The sRGB hex `#3b2b21` is the 8-bit encoding of the linear RGB midpoint between `dark-brown` (`#4b321e`) and `black` (`#252323`). Apparent color also reflects the studio lighting preset.

Wavy and legacy short ponytail assets apply this tone dynamically to their detailed hair textures. Artemis reuses its `artemis-dark-brown.webp` texture atlas with shader-level color correction, avoiding redundant image downloads or unneeded memory overhead. Switching between Espresso and Dark Brown instantly reuses the resident GPU texture.

The look development menu provides **seven color choices**, derived from six original painted atlases plus the intermediate tone. Upstream model licenses remain as documented in [IMPORTED_HAIR.md](IMPORTED_HAIR.md).

## Rig Softness and Secondary Motion

The geometry, UVs, fitting, and ponytail length of the Wavy hairstyle are preserved. The Wavy hair material operates at roughness 0.82, specular intensity 0.09, and balanced sheen: specular highlights are softened while maintaining accurate lighting responses.

The ponytail reacts dynamically to head angular velocity via a critically damped analytical spring system. Analytical integration prevents the numerical explosion common in standard Euler springs under variable frame deltas. System frequency is tuned to 5.5 rad/s with angular control lag clamped to 0.055 radians before individual bone gains. Subtle responsiveness is also applied to intermediate joints and tips of the two front hair strands, while roots remain securely anchored.

This motion provides real-time secondary physics on the existing bone rig. It does not perform single-strand grooming or heavy polygon mesh collision. The shader remains opaque with alpha cutout and depth-write enabled, preventing transparency sorting artifacts.

## Eye Makeup Refinement

The facial material loads the original `FaceEyeLipstickMask.png` texture mask as linear data using the skin UV coordinates. The red channel (R) governs eye shadow, the green channel (G) controls eyeliner, and the blue channel (B) protects the lip region. The prepared skin base tone is preserved, receiving localized makeup accents around the eyes.

Eye shadow utilizes a neutral brown tone mapped up to a maximum mask contribution of 0.43. Eyeliner deepens luminance by up to 36% in targeted mask zones. No artificial UV seams or altered lip/eye/body textures are introduced. The enhancement operates natively within the extended 12-bone skinning shader.

`applyAvatarMaterials()` exposes `setEyeMakeupStrength(0...1)` for deterministic visual audits, defaulting to 1 in runtime. Automated QA validates side-by-side frames with strength 0 and 1 to confirm makeup effects independently of scene lighting or facial morphs.

## Eyebrows Linked to Hair Tint

The eyebrow material preserves its original coverage alpha map. Eyebrow tint is dynamically derived from the selected hair color with a deepened density curve, preserving fine hair fiber highlights in the texture. The alpha cutoff threshold is set to 0.13 (down from 0.20) to enhance readability of delicate brow hairs while maintaining depth writes and shadow casting.

Synchronization is automatic: the wardrobe controller invokes `root.userData.air3Materials.setHairColor(hex)` at launch and upon every successful hair color selection. If a color change is cancelled or fails, previous values remain untouched.

Material diagnostics expose `brows.linkedHairColor` and `brows.tintSrgb`; hair diagnostics expose `colorSrgb`, `browColorLinked`, and `softness` parameters. Synchronization works seamlessly across blonde, red, brown, and dark palettes.

## Reference Expression

In the project emotion catalog, **Subtly Happy** maps to canonical ID `happy`. `warm` represents Warm/Welcoming. Look development reference renders utilize `happy` at intensity 1.0 combined with the warm 5-point studio lighting preset.

## Verification

Automated tests verify asset integrity across hairstyle switches, validity of the intermediate Espresso shade, texture atlas reuse, eyebrow-to-hair synchronization, and rejection of invalid values. Angular spring lag is verified to remain bounded and stable under both 30 FPS and 60 FPS update intervals.
