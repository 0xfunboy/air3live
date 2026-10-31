# AIR3 Live 3.0 — Startup and First Broadcast

This guide covers deployment and operation of the standalone AIR3 Live broadcasting suite.

## Operational Overview

`npm run live` starts the studio broadcast gateway and API server. The console is accessible at **`http://localhost:5890/control`** (or `https://livedash.airewardrop.xyz/`). The **LIVE** button in the Control Room initiates the headless Chromium WebGL renderer and launches FFmpeg encoding to your RTMP/RTMPS stream destination.

Chromium headless executes the Three.js 3D stage and Web Audio graph; FFmpeg encodes H.264/AAC to RTMP/RTMPS. The studio runs entirely autonomously on headless Linux servers without requiring an interactive X11 desktop or OBS.

## 1. Prerequisites and Installation

- Node.js **24.0.0 or higher** with npm.
- FFmpeg in system `PATH` with `h264_nvenc` support (or specify `AIR3_FFMPEG` in `.env`).
- Chromium installed via `npm run setup` (or custom path in `AIR3_CHROME_PATH`).
- NVIDIA GPU with proprietary driver (>= 550) for hardware acceleration.

From the repository root:

```bash
node --version
ffmpeg -version
npm run setup
npm run live
```

`npm run setup` automatically installs npm dependencies, generates unique cryptographic secrets in `studio-broadcast/.env`, and downloads the matching Chrome for Testing build.

## 2. Configuration (`studio-broadcast/.env`)

| Key | Description |
|---|---|
| `AIR3_OPERATOR_TOKEN` | Bearer token for Control Room access and stream management. |
| `AIR3_PRODUCER_TOKEN` | Bearer token for agents (ElizaOS / AIRdApp) sending speech narrations and titles. |
| `AIR3_PLAYER_TOKEN` | Internal token for the audio player lease. |
| `AIR3_STREAM_URL` | Target RTMP/RTMPS ingest endpoint (Restream / Twitch / YouTube). |
| `AIR3_ENCODER` | Hardware video encoder (`h264_nvenc`, `h264_qsv`, or `libx264`). |
