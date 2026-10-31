# AIR3 Live — Operational Guide for AI Agents (Autonomous Production Guide)

> **Document for AI Agents & Automation Systems**  
> This guide contains complete technical, architectural, and operational instructions for an AI Agent (Codex, Claude, ElizaOS, or local autonomous agents) to deploy, operate, maintain, and direct the **AIR3 Live** broadcast studio on Linux with NVIDIA RTX hardware acceleration.

---

## 1. Executive Overview and Objective

**AIR3 Live** is an enterprise-grade 24/7 autonomous broadcasting runtime engineered for the perpetual live streaming of the photorealistic 3D MetaHuman presenter **AIR3**.
- **Zero Human Intervention Required**: Once started, a multi-tier supervisor watchdog with exponential backoff automatically handles network reconnects, dropped frames, or RTMP socket restarts.
- **Fully Controllable via API**: External AI agents (**ElizaOS**, **AIRdApp**, or custom agents) steer the presenter by dispatching speech text, camera cuts, emotional states, and stage navigation via authenticated HTTP REST endpoints.
- **Zero In-Repo Coupling**: `air3live` is a clean, standalone broadcast studio built on Node.js 24 ESM, Three.js WebGL, Puppeteer Stream, and FFmpeg NVENC.

---

## 2. Runtime Architecture

```
                    ┌────────────────────────────────────────┐
                    │      ElizaOS / AIRdApp / AI Agent      │
                    └───────────────────┬────────────────────┘
                                        │ HTTP REST (Port 5890)
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ air3live Runtime (Node.js 24 ESM)                                          │
│                                                                            │
│  ┌──────────────────────┐   WebSocket/IPC   ┌───────────────────────────┐  │
│  │   HTTP & API Gateway │ ◄───────────────► │   Supervisor Watchdog     │  │
│  │  (/api/live/*)       │                   │   (24/7 Auto-Recovery)    │  │
│  └──────────┬───────────┘                   └─────────────┬─────────────┘  │
│             │                                             │                │
│             ▼                                             ▼                │
│  ┌──────────────────────┐                   ┌───────────────────────────┐  │
│  │  Three.js 3D Studio  │                   │  Headless Chromium        │  │
│  │  (Avatar + WebGL)    │                   │  (NV12 Frame Capture)     │  │
│  └──────────┬───────────┘                   └─────────────┬─────────────┘  │
│             │                                             │                │
│             ▼                                             ▼                │
│  ┌──────────────────────┐                   ┌───────────────────────────┐  │
│  │  Rhubarb Lip-Sync    │                   │  FFmpeg Hardware Encoder  │  │
│  │  & Audio Pipeline    │ ────────────────► │  (NVIDIA NVENC h264_nvenc)│  │
│  └──────────────────────┘   PCM Audio Pipe  └─────────────┬─────────────┘  │
└───────────────────────────────────────────────────────────┼────────────────┘
                                                            │ RTMP / RTMPS
                                                            ▼
                                              Restream / Twitch / YouTube
```

### Core Architecture Components
1. **WebGL 3D Studio (`studio-broadcast/public/`)**:
   - Photorealistic 3D MetaHuman model with facial blendshapes for continuous speech lip-sync (visemes A-H).
   - Production wardrobe: White off-shoulder crop top, leather boots, wavy chestnut hair.
   - Dynamic gaze tracking toward active broadcast camera (`air3-attention.mjs`, `look-controller.mjs`).
   - Central curved video wall connected live to **AIRdApp Wallboard** (`https://airdapp.airewardrop.xyz/wallboard`).
2. **Gateway & API Server (`studio-broadcast/src/main.mjs`)**:
   - Serves static assets, Control Room (`/control`), and REST endpoints secured by operator/producer tokens.
3. **Headless Broadcaster & Encoder (`studio-broadcast/src/broadcast.mjs` & `encoder.mjs`)**:
   - Launches headless Chromium with GPU hardware acceleration at 1080p30 / 1080p60.
   - Streams audio/video pipes directly to FFmpeg with **`h264_nvenc`**.
4. **24/7 Supervisor Watchdog (`studio-broadcast/src/live-process.mjs`)**:
   - Monitors FFmpeg process health and RTMP stream continuity.
   - Automatically reconnects with exponential backoff (3s, 4.5s, 6.7s... up to 60s).

---

## 3. Production System Requirements (Linux)

- **Host**: Linux x86_64 with NVIDIA GeForce RTX GPU (e.g. RTX 3090 / 4090 / 5090)
- **NVIDIA Driver**: >= 550 with NVENC support (`nvidia-smi` operational)
- **Node.js**: >= 24.0.0 (pure ESM, native `process.loadEnvFile`)
- **FFmpeg**: Compiled with `h264_nvenc` hardware acceleration
- **Chromium Dependencies**: Standard headless shared libraries (`libnss3`, `libgbm1`, `libasound2`, `libpango-1.0-0`, etc.)

---

## 4. Setup and Installation

### 4.1. Install Dependencies and Browser
From the repository root:
```bash
npm run setup
```
This automatically runs:
1. `npm ci --prefix studio-broadcast` (installs Three.js, Puppeteer, esbuild, etc.)
2. `npm run init --prefix studio-broadcast` (generates `.env` with unique cryptographic secrets if absent)
3. `npm run browser:install --prefix studio-broadcast` (installs Chrome for Testing in `.cache/browser`)
4. Builds production frontend bundles.

### 4.2. Configuration (`studio-broadcast/.env`)
```ini
PORT=5890
AIR3_PUBLIC_ORIGIN=http://127.0.0.1:5890

# Authentication tokens
AIR3_OPERATOR_TOKEN=your_secret_operator_token_64_hex
AIR3_PRODUCER_TOKEN=your_secret_producer_token_64_hex
AIR3_PLAYER_TOKEN=your_secret_player_token_64_hex

# Streaming Ingest (Restream / Twitch / Custom)
AIR3_STREAM_URL=rtmp://live.restream.io/live/re_xxxxxxxxx

# Video Encoder
AIR3_ENCODER=h264_nvenc
AIR3_FFMPEG=/home/funboy/.local/bin/ffmpeg

# Market Feeds
AIR3_DAPP_BASE_URL=https://airdapp.airewardrop.xyz
```

---

## 5. Execution Modes

### 5.1. Studio & Control Room Mode
To start the broadcast server with HTTP APIs and operator console:
```bash
npm run live
# or explicitly with NVIDIA profile:
node scripts/start-live.mjs nvidia
```

Available URLs:
- **Operator Control Room**: `http://localhost:5890/control` (or `https://livedash.airewardrop.xyz/`)
- **Public 3D Viewer**: `http://localhost:5890/` (or `https://live.airewardrop.xyz/`)
- **Studio Canvas**: `http://localhost:5890/studio`
- **Health Check**: `GET http://localhost:5890/healthz`

### 5.2. Direct Headless Broadcast Daemon
To launch the headless pipeline straight to RTMP:
```bash
npm run broadcast
```

---

## 6. AI Agent REST API Reference (ElizaOS & Bots)

All agent requests require:  
`Authorization: Bearer <AIR3_PRODUCER_TOKEN>`

### 6.1. Dispatch Speech Narration & Lip-Sync
Enqueue text for the presenter to synthesize and articulate with phonetic lip-sync:

```http
POST /api/live/narrations
Content-Type: application/json
Authorization: Bearer <AIR3_PRODUCER_TOKEN>

{
  "text": "Welcome to AIR3 Live! Analyzing latest on-chain market order flows from the AIRdApp.",
  "emotion": { "name": "warm", "intensity": 0.8 },
  "language": "en"
}
```

*Supported emotions*: `neutral`, `warm`, `happy`, `focused`, `surprised`, `concerned`, `sad`.

### 6.2. Directing Commands & Monitor Movement
Direct the presenter to present a monitor or return to the desk:

```http
POST /api/live/command
Content-Type: application/json
Authorization: Bearer <AIR3_PRODUCER_TOKEN>

{
  "type": "monitor",
  "monitor": "center"
}
```
*(Values: `"center"` for Wallboard, `"left"` for Market Desk, `"right"` for Heatmap, `"home"` for return to desk.)*

### 6.3. Lower-Third Titles & Ticker Banner
```http
POST /api/live/titles
Content-Type: application/json
Authorization: Bearer <AIR3_PRODUCER_TOKEN>

{
  "enabled": true,
  "label": "#AIR3 LIVE",
  "title": "Bitcoin Breakout Above $68,400",
  "subtitle": "Order Book Analysis & On-Chain Volumes",
  "ticker": [
    "AIR3: 24h trading volume +34%",
    "Wallboard updated with 2 new pending orders",
    "Track live execution at airdapp.airewardrop.xyz"
  ],
  "speed": 65,
  "ttlSeconds": 0
}
```

---

## 7. Integrity Testing and Quality Assurance

```bash
# Run all 216 unit and integration tests
npm test

# Verify code style and syntax
npm run check
```
