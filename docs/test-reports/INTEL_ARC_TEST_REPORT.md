# AIR3 Studio — Secondary GPU Test Report: Intel Arc Xe-LPG Graphics

**Test Date**: October 24, 2026  
**Environment**: Windows 11 Pro 64-bit / Linux x86_64  
**Headless Browser**: Google Chrome with ANGLE Direct3D11 / Vulkan backend  
**Tested Target**: `@air3/studio`  

---

## 1. Test Objective
Verify functionality, stability, and visual performance of the 3D #AIR3 virtual studio and Three.js MetaHuman avatar engine on secondary system GPUs (integrated/discrete **Intel Arc / Intel Graphics**), offloading WebGL hardware acceleration and QuickSync video encoding (`h264_qsv`) without burdening the primary GPU.

---

## 2. WebGL Diagnostics on Intel Arc
- **`UNMASKED_VENDOR_WEBGL`**: `Google Inc. (Intel)`
- **`UNMASKED_RENDERER_WEBGL`**: `ANGLE (Intel, Intel(R) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)`
- **Context Lost**: `false` (Zero context drops or driver resets observed throughout test suite)

---

## 3. Avatar Rig and Facial Morph Verification (267,252 Triangles)
- **Model Triangles**: 267,252 polygons.
- **Rendered Triangles per Frame**: 530,580 (including depth and shadow passes).
- **Draw Calls**: 36 draw calls per frame in avatar close-up view.
- **VRAM Footprint**: 31 active PBR textures (2K composite albedo with makeup, ORM maps, tangent normals, and hair/lash alpha maps).
- **12-Bone Skinning**: Handled via custom vertex shader with attribute accumulation across 3 bone sets without deformation artifacts.
- **Phonetic Lip-Sync**: 35 active morph blendshapes with Rhubarb speech synchronization.

---

## 4. Hardware Video Encoding: Intel QuickSync (`h264_qsv`)
- **Encoder**: `h264_qsv` (Intel Quick Sync Video Acceleration).
- **Test Stream**: 1920×1080 at 30 FPS, 4500 kbps target bitrate.
- **Probe Status**: **PASSED (Exit code 0)**.
- **Result**: Intel Arc QuickSync operates reliably, offloading CPU encoding without competing for discrete NVIDIA GPU resources.
