# Twitch Live Chat Integration

The Twitch chat integration operates as an autonomous background service within AIR3 Live. It requires no external dApp or Eliza dependencies and can listen to Twitch chat channels while the primary video stream is transmitted via Restream.

## Configuration

1. Register an application in the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Register the OAuth redirect URI shown in your AIR3 Live Control Room (e.g. `http://localhost:5890/api/live/twitch/callback` or your public domain equivalent `https://livedash.airewardrop.xyz/api/live/twitch/callback`).
3. Enter Client ID, Client Secret, and the target Twitch channel name in the Control Room.
4. Click **Connect Twitch** to authorize the bot.

AIR3 Live implements the standard **OAuth 2.0 Authorization Code Grant**, exchanging authorization codes securely on the server backend. The only required scope is `user:read:chat`.

## Security and Credential Protection

Client secrets, access tokens, and refresh tokens are stored securely in the server's private `.env` file and are never sent to the browser client or logged in diagnostics. The Control Room UI receives only sanitized status: connection state, channel name, and message streams.

## Features

- **Read-Only EventSub WebSocket**: Subscribes directly to Twitch EventSub topics for ultra-low-latency message intake.
- **One-Click Lower-Third Promotion**: Directors can click any incoming chat message in the Control Room to promote it to the live on-screen broadcast ticker or lower-third banner.
- **Automated Reconnect and Token Refresh**: Background token refresh handles hourly token expirations transparently.
