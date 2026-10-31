# Visual Identity: #AIR3 and AiRewardrop

## Placement in Revision 2.3

The AiRewardrop corporate brand appears **once inside the set**, on the backdrop, and **once outside the set**, in the upper broadcast overlay graphics. The command header uses #AIR3. The standalone character preview, which excludes the studio set, uses a single AiRewardrop header.

The presenter desk displays the "A" emblem enclosed by the red/blue arc alongside the AIR3 wordmark. No logo is painted on the three monitor canvases, nor on the small desk monitor that shares the market chart canvas. The monitors remain dedicated to charts, telemetry, and speech narration text.

The face and figure depicted in legacy reference images **are not included in any of the runtime logos**.

## Shipped Assets

Location: `studio-broadcast/public/assets/air3/branding/`.

| File | PNG Dimensions | Purpose |
|---|---:|---|
| `air3-emblem.png`, `air3-emblem.svg` | 1024 × 1024 | Isolated emblem, favicon, and loading screens |
| `air3-lockup.png`, `air3-lockup.svg` | 2160 × 640 | Emblem with AIR3 wordmark, desk, and control room |
| `airewardrop-lockup.png`, `airewardrop-lockup.svg` | 2400 × 344 | Corporate brand, backdrop, and external broadcast graphics |

The PNG assets utilize an authentic alpha channel; any black appearance in raw image viewers reflects the viewer background, not an opaque canvas. The SVGs contain clean vector paths and gradients without embedded character imagery, remote web fonts, or executable scripts. Textures are mapped while strictly preserving brand aspect ratios.

## Sourcing and Methodology

The canonical source is the user-provided reference banner. Clean vector contours and high-resolution rasterizations were produced to ensure smooth anti-aliased presentation without raster edge noise. The brand lettering was reconstructed using typographic vectors; the emblem and AIR3 letters are clean SVG paths.

`branding-manifest.json` tracks source history, positioning, and SHA-256 checksums for each runtime asset. Heavy intermediate generation files are excluded from runtime loading: the production studio loads only the final lightweight PNG assets.

## Verification

The compiled browser test matrix ensures that exactly one corporate brand exists within the 3D scene and exactly one brand element is rendered in the external overlay graphics. Framebuffer captures verify the brand on the backdrop and #AIR3 on the desk. The build inventory includes verified logos, hashes, HTML, and CSS. Current metrics and validation records are located in `docs/validation/history/lookdev-2.3.0/compiled-visual-qa.json`.
