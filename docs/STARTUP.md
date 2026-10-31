# AIR3 Studio Startup and Configuration

> Note for Live 3.0: The broadcast module is standalone. Current instructions are in [STARTUP_LIVE_3.0.md](STARTUP_LIVE_3.0.md) and [LIVE_API_3.0.md](LIVE_API_3.0.md). This document records legacy integration details.

## Local Preview and Testing

To preview the 3D MetaHuman rig and studio environment locally:

```bash
npm ci --prefix studio-broadcast
npm run preview
```

Open `http://127.0.0.1:5892/` to access the interactive character inspector with camera orbit controls, animation clip selector, facial emotions, blink toggles, and phonetic lip-sync playback.

To inspect the television studio set with monitors and lighting:
```text
http://127.0.0.1:5892/studio?camera=presenter&quality=high
```

## Studio Controls and Roaming

- **Monitor Waypoints**: Presenter navigates between Left Monitor, Center Wallboard, and Right Heatmap.
- **Phonetic Lip-Sync**: Click "TEST VOICE & LIP-SYNC" to evaluate Rhubarb phonetic viseme alignment in real time.
- **Lighting & Look Inspector**: Adjust the 5-point spotlight rig, exposure, tone mapping, and wardrobe options.
