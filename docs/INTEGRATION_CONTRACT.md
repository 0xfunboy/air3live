# AIR3 Broadcast Studio Integration Contract

This contract defines the architecture and communication protocols of the AIR3 Live studio broadcast service.

## Core Services

The gateway is separate from the dApp trading backend. Its default origin is `http://127.0.0.1:5890`; the studio WebGL entry point is `/studio`, and the operator console is `/control` (or `https://livedash.airewardrop.xyz/`).

The web frontend is bundled from `studio-broadcast/public/` into `public/build/` via esbuild. Three.js (0.186.1) and required addons are served locally under `/vendor/three/`; zero runtime dependencies require external CDNs. `public/build/manifest.json` tracks source and bundle checksums.

## Authentication and Security Boundaries

1. **Bearer Authentication**: Narration and administrative APIs require `Authorization: Bearer <token>`. Producer and player credentials remain separate. Tokens are never exposed in query parameters, log strings, or error traces.
2. **Public Endpoints**: `/api/health`, `/api/public-config`, `/api/emotions`, `/api/expressions`, and static WebGL assets are public.
3. **Audio Lease Exclusivity**: Speech audio is strictly bound to single-lease playback. A watchdog lease timeout prevents zombie audio workers or replayed speech.

## Watchdog and Self-Healing Supervision

- **Crash Detection**: FFmpeg exit codes or socket terminations trigger an exponential backoff reconnect cycle (3s, 4.5s, 6.7s, up to 60s).
- **Graceful Termination**: SIGINT and SIGTERM trigger clean teardown of child Chromium and FFmpeg processes before releasing file locks.
