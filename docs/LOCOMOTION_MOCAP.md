# Locomotion Motion Capture Retargeting

The studio walking animation is derived from human optical motion recordings from the **Open Motion Project by ACCAD / The Ohio State University** (CC BY 3.0).

## Included Clips

Seven motion capture clips are retargeted directly to the AIR3 MetaHuman rig:
1. `Stand`: Idle stationary stand.
2. `StandToWalk`: Acceleration from standing into walking stride.
3. `Walk1`: Steady-state walking cycle (0.94 m/s nominal velocity).
4. `WalkToStand`: Natural deceleration to a stop.
5. `WalkTurnLeft90`: Left turn with captured foot placement.
6. `WalkTurnRight90`: Right turn with captured foot placement.
7. `WalkTurnAround180`: 180° turnaround for stage return.

## Retargeting and Bone Axis Correction

The retargeting pipeline (`tools/retarget_accad_motion.py`) extracts global joint rotations from BVH channels, normalizes forward displacement while preserving pelvic tilt, and applies coordinate transformations between ACCAD bind axes and the AIR3 skeleton:
- Distributes spinal rotation across all 5 lumbar/thoracic vertebrae (`spine_01` through `spine_05`).
- Preserves native limb bone lengths, segment scales, and joint limits.
- Samples 25 primary structural bones without allowing foreign clip scales to corrupt facial or wardrobe transforms.
- Integrates continuous foot grounding: heel and toe contacts are clamped to ground plane Z=0 during stance phases.
