# Presenter Studio Motion and Roaming

The `studio-broadcast/public/air3-stage-motion.mjs` controller integrates procedural stage navigation into the MetaHuman rig. The presenter can navigate to the left, center, or right monitor, present the display with an open gesture, and return to the home anchor point. Automatic autonomous roaming can be toggled via API or control UI.

## Walking Gait and Foot Grounding

Locomotion utilizes seven human motion captures from the ACCAD / The Ohio State University Female 1 collection: idle stand, walk start, cycle walk, walk stop, 90° left turn, 90° right turn, and 180° turnaround. Upstream BVHs and CC BY 3.0 attribution are documented in [LOCOMOTION_MOCAP.md](LOCOMOTION_MOCAP.md).

Posing, stride cadence, arm swing, and root displacement are derived directly from motion recordings. Nominal walking speed is 0.94 m/s; the controller modulates playback speed to match distance. Accelerations and decelerations preserve natural human performance curves. Directional turns utilize captured angular deltas rather than synthetic foot sliding.

Foot grounding is stabilized on the heel and ball of the foot using velocity and ground-proximity markers derived from the capture. A two-segment analytical IK solver utilizes exact avatar bone lengths and recorded knee bend vectors, preserving shoe orientation and roll. Subtle pelvis height compensation (clamped to 20 mm) accounts for minor performer anatomical differences without bone stretching. Unreachable contacts are gracefully released within reach bounds. Diagnostics distinguish IK target offset from physical floor slide.

Mocap poses are blended after the core body mixer and prior to active head gaze and wardrobe synchronization. Base poses are normalized before applying deltas, preventing pose accumulation. Speech lip-sync and facial morphs continue uninterrupted while walking.

## Monitor Presentation

Waypoints and stations are defined in [OVAL_STUDIO.md](OVAL_STUDIO.md). The presenter stops at a three-quarter angle to the camera and gestures toward the active monitor with the corresponding arm. The hand indicates the chart with an open palm gesture while maintaining natural elbow flex, without clipping the physical screen plane.

During transit, gaze naturally leads along the walk vector to prevent awkward neck rotation toward cameras behind the presenter. Upon reaching the presentation station, gaze alternates between the display and the live broadcast camera. If a route is interrupted, the presenter steps back along the clear aisle before transitioning to the new waypoint, avoiding collisions with the studio desk.

## Control APIs

The `StudioScene` interface exposes `presentMonitor('left'|'center'|'right')`, `returnHome()`, and `enableRoaming(true|false)`.

Autonomous roaming delays initial transit until the scene and speech pipelines are fully loaded, avoiding movements during active speech delivery. Manual commands take immediate priority and reset autonomous intervals.

`diagnostics()` reports current phase (`home`, `walking`, `turning`, `presenting`), active target, pending target, velocity, IK errors, foot drift, gesture blend weight, and world coordinates.

## Verification

`test/stage-motion.test.mjs` validates full GLB loading, all navigation paths, home return, cancel handling, mid-stride speech transitions, foot clearance, desk obstacle avoidance, transform finiteness, and segment scale preservation. Ankle grounding error during full-weight contact is strictly verified to stay under 5 mm.
