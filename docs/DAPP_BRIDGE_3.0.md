# Central Wallboard AIRTrack Bridge

The AIR3 Live broadcast studio is entirely autonomous. To display live trading signals and market telemetry from the official AIRdApp, the bridge service `adapters/dapp-wallpanel.mjs` polls the public AIRdApp REST APIs and publishes structured snapshots to the live studio gateway.

## Usage

1. Start AIR3 Live: `npm run live`. In the Control Room under **Data & Monitors**, ensure **Central Wallpanel** is set to **External Wallpanel · AIRTrack / API**.
2. In `studio-broadcast/.env`, specify `AIR3_DAPP_BASE_URL`:
   ```ini
   AIR3_DAPP_BASE_URL=https://airdapp.airewardrop.xyz
   ```
3. Use the `AIR3_PRODUCER_TOKEN` generated in `studio-broadcast/.env`.
4. Run the bridge:
   ```bash
   npm run bridge:dapp
   ```
   Or directly via Node:
   ```bash
   node --env-file=studio-broadcast/.env adapters/dapp-wallpanel.mjs
   ```

To perform a single validation poll and exit:
```bash
node --env-file=studio-broadcast/.env adapters/dapp-wallpanel.mjs --once
```

## Polling Cadence and Resilience

- **Trade Polling**: Fetches active positions every 12 seconds (`/api/trades?statuses=OPEN,PENDING`).
- **Candlestick Caching**: Caches OHLCV candles for 15 seconds per active symbol.
- **Backoff & Recovery**: Network failures trigger bounded backoff (4s, 8s, 16s, up to 30s) without blocking the broadcast stream.
- **Zero Financial Execution**: The adapter is strictly read-only. It never holds private keys, executes orders, or modifies vault states.
