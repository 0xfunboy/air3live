# Avatar PBR Materials and Shaders

The avatar rendering engine reconstructs high-fidelity PBR materials from 2K textures extracted from the Unreal Engine 5 MetaHuman project.

## Shader Integration

`studio-broadcast/public/avatar-materials.mjs` exports `applyAvatarMaterials(gltf, { renderer, assetBase, quality })`.
This function must resolve **prior** to initializing `Air3AvatarRig`, allowing the controller to inject 12-bone skinning vertex shader chunks and shadow passes into active materials.

Runtime textures reside in `public/assets/air3/textures/render/`.

## Reconstructed Material Layers

| Component | Upstream Source | WebGL PBR Implementation |
|---|---|---|
| **Facial Skin** | Albedo, Normal, Roughness, Cavity | Linear PBR physical material, tangent-space normals, micro-roughness, subsurface approximation via custom BRDF |
| **Makeup Layer** | UE mask overrides (`FaceEyeLipstickMask.png`) | 2K linear composite baking eye shadow, eyeliner, and lip tint into base albedo |
| **Eyes & Iris** | Iris mask, sclera albedo/normal, IOR 1.336 | Blue iris shader, radial fiber depth, pupil dilation, clearcoat cornea layer |
| **Hair Cards** | Hair card atlases with alpha test & anisotropy | Dual-pass shading: opaque core with alpha-cutoff tips, anisotropic specular highlight, dynamic soft spring physics |
