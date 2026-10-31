# AIR3 Live 3.0 — Control Room and Agent REST API Reference

Implementation: `studio-broadcast/src/live-service.mjs`, `live-auth.mjs`, `live-settings.mjs`, `live-editorial.mjs`, and `gateway.mjs`.

Default local origin: `http://127.0.0.1:5890`. The web Control Room runs at **`http://localhost:5890/control`** (or via the dedicated domain `https://livedash.airewardrop.xyz/`). JSON requests require `Content-Type: application/json`. Error responses return HTTP status with `{"error":"CODE"}`. Field names are case-sensitive.

## Authentication and Roles

| Role | Credential | Permitted Operations |
|---|---|---|
| **Operator** | Control Room session cookie or `Authorization: Bearer <OPERATOR_TOKEN>` | Studio settings, stream start/stop, scene directing, local recordings, and Twitch OAuth configuration. |
| **Producer** | `Authorization: Bearer <PRODUCER_TOKEN>` | Speech narrations, on-screen lower-thirds, wallpanel snapshots, and external chat feeds from ElizaOS/AIRdApp agents. |
| **Player** | `AIR3_PLAYER_TOKEN` (used internally by broadcast renderer) | Audio queue polling, lease claims, and speech playback confirmation. |

Tokens are configured in `studio-broadcast/.env`. Server-to-server requests with a bearer token do not require `Origin`. Browser mutation requests using cookies require a matching `Origin`.

### Session Endpoints
- `GET /api/live/session`: Returns `{"authenticated": true|false}`.
- `POST /api/live/session` with `{"token": "<OPERATOR_TOKEN>"}`: Operator login.
- `DELETE /api/live/session`: Logout and session revocation.

## Unauthenticated Read Endpoints

| Method & Route | Response Description |
|---|---|
| `GET /api/live/program` | Shipped version, active scene state, look preset, titles, and session status. |
| `GET /api/live/market` | Validated snapshot of monitor telemetry, data sources, and freshness. |
| `GET /api/live/session` | Authentication status of caller. |

## Producer Endpoints (ElizaOS / AIRdApp / Bots)

### 1. Enqueue Speech Narration
```http
POST /api/live/narrations
Content-Type: application/json
Authorization: Bearer <PRODUCER_TOKEN>

{
  "id": "trade-callout-101",
  "text": "Bitcoin has swept liquidity below 68,000 dollars. Monitoring order book for reversal signals.",
  "language": "en",
  "emotion": { "name": "focused", "intensity": 0.4 },
  "presentation": { "action": "monitor", "monitor": "center" }
}
```
*Response (`202 Accepted`)*:
```json
{
  "id": "trade-callout-101",
  "status": "pending"
}
```

### 2. Update On-Screen Titles and Ticker
```http
POST /api/live/titles
Content-Type: application/json
Authorization: Bearer <PRODUCER_TOKEN>

{
  "enabled": true,
  "label": "#AIR3 LIVE",
  "title": "BTCUSDT Liquidity Sweep",
  "subtitle": "Order Book Analysis & On-Chain Volumes",
  "ticker": [
    "AIR3: 24h trading volume +34%",
    "Wallboard updated with 2 pending buy orders",
    "Live trade metrics at airdapp.airewardrop.xyz"
  ],
  "speed": 65,
  "ttlSeconds": 0
}
```

### 3. Send External Wallpanel Snapshot
```http
POST /api/live/wallpanel
Content-Type: application/json
Authorization: Bearer <PRODUCER_TOKEN>

{
  "title": "AIRdApp Intelligence",
  "source": "AIRTrack Feed",
  "cards": [
    { "label": "Active Trades", "value": "4", "tone": "positive" },
    { "label": "Win Rate (30D)", "value": "78.4%", "tone": "positive" }
  ],
  "rows": [
    { "label": "BTC Long", "value": "+4.2%", "tone": "positive", "detail": "Target 1 Reached" }
  ],
  "ttlSeconds": 60
}
```

## Operator Endpoints (Control Room / Automation)

- `GET /api/live/status`: Comprehensive status of renderer, encoder FPS, bitrate, and watchdog.
- `POST /api/live/stream/start`: Starts the headless Chromium renderer and FFmpeg streaming pipeline.
- `POST /api/live/stream/stop`: Stops the broadcast pipeline gracefully.
- `POST /api/live/recording/start`: Starts recording the live stream to local MKV file.
- `POST /api/live/recording/stop`: Finalizes the active recording file.
- `GET /api/live/recordings`: Lists downloadable local recording files.
- `GET /api/live/recordings/:filename`: Downloads a recorded stream file.
