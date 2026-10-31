# Oval Virtual Broadcast Studio and Stage Layout

The 3D studio environment is defined in `studio-broadcast/public/studio-scene.mjs`, with rendering and reflection pipelines handled in `studio-rendering.mjs`.

## Architectural Layout

The studio features a continuous elliptical curved acoustic backdrop spanning approximately 12.3 meters wide and 4.65 meters deep across the rear quadrant. Walls, instanced wooden acoustic slats, warm ambient light ribbons, and the upper structural crown follow this curved geometry. Three recessed floor oval inlays provide spatial depth cues without introducing navigation obstacles for the presenter.

The three primary video walls are free-standing units detached from the rear wall:
- **Center Wallboard**: Massive curved display positioned behind the main presentation area.
- **Left Market Monitor**: Angled 28.6° toward stage center, dedicated to real-time order books, trades, and speech telemetry.
- **Right Heatmap Monitor**: Angled 28.6° toward stage center, rendering live liquidation heatmaps and volatility metrics.

The presenter desk spans 2.70 meters with clearcoat lacquered finish, curved frosted glass fascia, and brushed physical metal framing, offset toward stage-right to maintain clear walking corridors between all three monitor waypoints.

## Coordinate System and Navigation Waypoints

Coordinates are in meters within studio space: +Y is up, +Z faces the broadcast camera. `STAGE_LAYOUT` is exported by the scene module:

| Element | X | Y | Z |
|---|---:|---:|---:|
| Home Anchor Point | -0.75 | 0.005 | 0.65 |
| Center Monitor Center | 0.00 | 2.150 | -3.55 |
| Left Monitor Center | -3.55 | 1.950 | -2.30 |
| Right Monitor Center | 3.55 | 1.950 | -2.30 |
| Left Presentation Station | -2.50 | 0.005 | -0.85 |
| Center Presentation Station | -0.80 | 0.005 | -1.85 |
| Right Presentation Station | 2.45 | 0.005 | -0.85 |
| Desk Center Anchor | 1.65 | 0.000 | 1.20 |

Waypoints (`routes.left`, `routes.center`, `routes.right`) provide obstacle-free navigation vectors around the desk perimeter.

## Scene Interface

- `getMonitorTarget(id)`: Returns 3D world coordinates for the specified monitor screen.
- `presentMonitor(id)`: Commands the presenter to walk to the monitor station and execute the open-palm presentation gesture.
- `returnHome()`: Dispatches the return transit to the desk anchor.
- `enableRoaming(enabled)`: Toggles autonomous stage roaming.
