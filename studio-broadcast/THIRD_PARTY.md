# Third-party components

Updated for the look development and motion capture release dated 2026-10-25. Versions and license identifiers
below are recorded from the included lockfile, installed package metadata and
vendored license files. This inventory does not replace the full upstream notices.

## JavaScript dependencies

| Component | Pinned version | License | Purpose |
| --- | --- | --- | --- |
| Three.js | 0.186.1 | MIT | 3D renderer, loaders and post-processing |
| Chart.js | 4.4.3 | MIT | Market-monitor charts |
| Puppeteer Core | 24.43.1 | Apache-2.0 | Browser automation and capture |
| @puppeteer/browsers | 2.13.2 | Apache-2.0 | Browser installation |
| puppeteer-stream | 3.0.23 | MIT | Browser video/audio capture |
| esbuild | 0.28.2 | MIT | Development dependency used to build the browser bundles |

The exact dependency graph is pinned in [package-lock.json](package-lock.json).
`npm ci` installs the packages with their upstream license files. Original source
modules remain in `public/`; compiled output is in `public/build/`. The build uses
esbuild's `legalComments: 'eof'` option to retain recognized legal comments in its
output. Three.js remains an external module served from the installed dependency.
Preserve upstream notices when redistributing dependencies or compiled output.

## Capture patch

`scripts/patch-capture.mjs` modifies only the installed puppeteer-stream 3.0.23
runtime. The library is MIT licensed, copyright retained by its upstream authors:
https://github.com/samuelscheit/puppeteer-stream/blob/main/LICENSE.

The version-specific patch changes the internal WebSocket bind address to
127.0.0.1, propagates unexpected listener errors, releases the two capture mutex
sections in finally blocks and removes the capture listener after a failed start.
It does not remove or replace the upstream license. The script checks exact
preconditions and is idempotent; updating the dependency requires review.

## Rhubarb Lip Sync

Rhubarb Lip Sync **1.14.0** is distributed in this package for Linux x64 and
Windows x64 under `vendor/rhubarb/1.14.0/`. Rhubarb itself is **MIT licensed**.
Its libraries and acoustic/language resources retain their own licenses; the
combined distribution must not be described as consisting only of MIT material.

The complete upstream notices are retained in both platform directories:

- [Linux LICENSE.md](vendor/rhubarb/1.14.0/linux-x64/LICENSE.md).
- [Windows LICENSE.md](vendor/rhubarb/1.14.0/win32-x64/LICENSE.md).

These files include notices for Boost, the CMU Sphinx acoustic model, PocketSphinx,
Flite, libogg/libvorbis and the other dependencies listed by the distribution.
The accompanying `README.adoc`, `CHANGELOG.md` and `res/sphinx/` resource trees are
also retained. Keep each executable together with its resources and full notices;
copying the executable alone is insufficient for this packaged integration.

[MANIFEST.json](vendor/rhubarb/1.14.0/MANIFEST.json) records the official release
source, archive checksums and packaged-file inventory. Upstream release:
[Rhubarb Lip Sync v1.14.0](https://github.com/DanielSWolf/rhubarb-lip-sync/releases/tag/v1.14.0).

## Separately installed services and executables

FFmpeg and Chrome are installed separately and retain their own licenses. Chrome
is downloaded using the revision associated with the pinned Puppeteer
package. Dependency pinning makes the tested setup reproducible; it is not a
substitute for periodically reviewing security updates and repeating the smoke
test when upgrading.

Kokoro and Kokoro-FastAPI are external optional services; their model weights and
container images are not distributed in this source package. Connecting another
TTS endpoint does not include or relicense that service or its model weights.

## Project assets and supplied repositories

The avatar meshes, MetaHuman/Unreal exports, source textures and associated project
assets were supplied for this project. This package includes those files and
documented derivatives; ownership remains with their respective rights holders.
The software licenses listed above grant no additional rights to those assets.
Use and redistribution remain subject to the source assets' applicable licenses
and the project owner's rights. This document does not grant an Epic/MetaHuman,
marketplace-asset or character license and does not certify those rights.

Original license files in `../airewardrop-dapp-main/` and
`../airewardrop-eliza-main/` are preserved. Their terms apply to the corresponding
repositories; this inventory does not assign a new license to the AIR3 project.


## Footwear Assets

Boot by Aquateknica: CC BY 4.0. Shoes test by Bente Aimee: CC BY-NC 4.0, non-commercial reference variant. Fitting details and runtime limits: [FOOTWEAR.md](../docs/FOOTWEAR.md). Original licenses are embedded in GLB metadata.

## Crop Top — Off Shoulder Top

[Off Shoulder Top](https://sketchfab.com/3d-models/off-shoulder-top-5dac7be571c7464e802cc5aaa08a15c0) by [DaaGHrii](https://sketchfab.com/DaaGHrii), provided under declared [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The AIR3 version fits the garment geometry to the existing presenter anatomy and adds skinning weights, strictly preserving topology, UVs, and textures. Fitting and limits are described in [TOP_AND_BOOTS.md](../docs/TOP_AND_BOOTS.md).

## Hairstyle Assets

Wavy White Ponytail (With Bones) by zHairezt: CC BY 4.0 declared by source. Ponytail1 Artemis by CT Reed / continuumreed (remix from antoinepavia): CC BY-NC 4.0 declared by source, available as non-commercial reference. Six original Artemis atlases optimized to WebP; Wavy preserves its dedicated independent atlas. Details and styling: [IMPORTED_HAIR.md](../docs/IMPORTED_HAIR.md).

## ACCAD / Ohio State Motion Captures

Open Motion Project by ACCAD / The Ohio State University, **CC BY 3.0**. Original Female1 captures were trimmed and retargeted to the existing rig without altering skeletal limb lengths. [Official source](https://accad.osu.edu/research/motion-lab/mocap-system-and-data), [License](https://creativecommons.org/licenses/by/3.0/). Technical retargeting details: [LOCOMOTION_MOCAP.md](../docs/LOCOMOTION_MOCAP.md).
