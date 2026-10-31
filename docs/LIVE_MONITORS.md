# Studio Video Monitors and Live Market Data Feeds

The three studio video walls are rendered natively as HTML5 dynamic 2D canvases mapped onto 3D `CanvasTexture` surfaces within Three.js. They do not load slow web iframes or external browser pages.

## Stage Display Layout

| Monitor | Resolution | Display Content |
|---|---|---|
| **Center Wallboard** (and small desk display) | 1920 × 1080 | Live trading signals, active orders, BTC/ETH/SOL prices, 24h performance ratios; directly connected to AIRdApp Wallboard. |
| **Right Monitor** | 1280 × 720 | Multi-tier liquidation heatmap (Binance USD-M), price bars, volatility bands, and liquidation velocity. |
| **Left Monitor** | 1280 × 720 | Live order book, 24h change tickers, and active speech narration subtitles. |

Narration updates selectively refresh only the left speech canvas. Market data polls on a 3-second cadence shared across monitors, avoiding unneeded GPU texture allocations on each phonetic phoneme.

## Liquidation Heatmap Sources

1. **Binance Futures (USD-M)**: Public free liquidation stream via WebSocket (`wss://fstream.binance.com/market/stream` subscribing to `@forceOrder`, `@kline_5m`, and `@ticker`). Calculates notional executed volume ($ap \times z$).
2. **CoinGlass**: Enterprise alternative requiring an API key in `.env`.
3. **Simulated Synthetic Feed**: Fallback mode for local staging environments without external internet access.
