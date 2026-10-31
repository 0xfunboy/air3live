# Interchangeable Footwear Options

AIR3 Live provides three footwear options in the wardrobe controller. The **Aquateknica Leather Boots** serve as the recommended production footwear: they preserve photographic leather texturing, maintain crisp silhouette readability across wide-angle broadcast shots, and carry an attribution license suitable for commercial broadcasting. The original sneakers remain available. Open-toe high heels are included as a non-commercial reference variant.

| Option | Origin | Declared License | Rendered Geometry |
|---|---|---|---:|
| Original Sneakers | Shipped base asset | Project terms | Original base mesh |
| Natural Leather Boots | Boot by Aquateknica | CC BY 4.0 | 40,746 triangles |
| Open-Toe High Heels | Shoes test by Bente Aimee | CC BY-NC 4.0 (Non-commercial) | 30,644 triangles |

## Model Optimization and Fitting

- **Aquateknica Boots**: Original 3D scan comprised 370,422 triangles across 4 chunks (13.9 MB). Optimized via `meshoptimizer` to 20,373 triangles (3.2 MB) including the 2048×2048 PBR texture. Mirrored for bilateral symmetry with correct winding order. Specular/glossiness maps were converted to PBR roughness/metallic channels.
- **Bente Aimee High Heels**: Downsampled and optimized to 24,700 triangles (1.1 MB). Internal mannequin geometry is clipped by the footwear controller to prevent skin clipping, leaving only the toes visible in the front toe opening.

## Rig Attachment

The footwear controller utilizes inverse bind matrices from the MetaHuman skeleton, binding dynamically to `foot`, `calf`, and `ball` bones on both left and right sides without introducing secondary skeletons or altering base bone lengths.

When boots are worn, underlying foot mesh triangles below 9 cm in model space are excluded via reversible draw indices. Switching back to sneakers instantly restores the exact original geometry.

## JavaScript API

```js
const footwear = await createFootwearController({ avatarRoot: gltf.scene, rig });
await footwear.setStyle("boot", { fit: "relaxed" }); // "original" | "boot" | "shoes-test"
await footwear.setFit("low-cut");                    // "relaxed" | "low-cut"
footwear.update();                                   // update after rig evaluation
footwear.getState();
footwear.diagnostics();
footwear.dispose();                                  // restores original base meshes
```
