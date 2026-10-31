# Presenter Hairstyle, Eyes, and Facial Rig

Runtime Profile: `air3-short-ponytail-2026-10-24-v7`.

## Hairstyle Architecture

The hairstyle combines fine scalp cards with procedurally sculpted curves for the ponytail and face-framing strands:
- **Scalp**: Hair cards sampled from the cranial vertices, contoured along head normals with a 3 mm soft threshold.
- **Rear Ponytail**: 58 overlapping curved sections with realistic hair tapering, anchored below the cranial apex.
- **Face-Framing Strands**: Four clusters of 28 geometric fibers rooted at the temples, providing asymmetric styling without obstructing the forehead or eye tracking cameras.
- **Temporal Wisps**: Delicate tapered edge cards above the ears.

## Blue Eyes and Iris Shader

The iris shader utilizes a custom procedural material reproducing vivid blue-hazel eye coloration:
- Dynamic limbal ring with subtle radial darkening.
- Specular cornea layer with index of refraction (IOR) 1.336.
- Clearcoat reflection with micro-depth parallax, enhancing depth in camera close-ups.

Attachment is linked to `body__head` via the full inverse bind matrix, seamlessly tracking head movements, micro-expressions, and eye-contact transitions.
