# Avatar WebGL Optimization Pipeline

This document details the conversion and optimization pipeline that prepares the high-poly Unreal MetaHuman model for high-performance WebGL 60 FPS execution in Three.js.

## Geometry and Shading Architecture

- **Triangle Budget**: 267,252 triangles for the complete character rig (including clothing, footwear, eyes, and hair cards).
- **12-Bone Skinning Support**: Three.js default skinning limits matrices to 4 influences per vertex. AIR3 Live implements an extended vertex shader supporting up to 12 simultaneous bone influences across 3 interleaved attribute sets, completely eliminating pinching artifacts at shoulders, hips, and knees.
- **Rhubarb Lip-Sync Visemes**: 35 facial morph targets mapped to Rhubarb speech phonemes (`A`, `B`, `C`, `D`, `E`, `F`, `G`, `H`, `X`).
- **Texture Packing**: Albedo textures composite diffuse color, makeup, and skin tone into 2K WebP textures; roughness, metallic, and ambient occlusion are packed into compact ORM channels.
