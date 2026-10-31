# Motion Refinement: Turns, Shoulders, and Transitions

This document details kinematic corrections applied to ensure smooth, natural movement during presenter locomotion across the studio stage.

## Refinements

1. **Finite Turn Sequences**: Orienting toward a monitor executes a single-step pivot; 180° returns execute a two-step turn. Clips are never looped unnaturally to hit an arbitrary angle.
2. **Pelvic Rotation Axis**: The turn pivot is anchored to the projected pelvic center of mass rather than the visual mesh bounding box, preventing hairstyle or garment offsets from biasing the turn center.
3. **Clavicle Height Preservation**: Clavicle rotations maintain the anatomical reference envelope from `MH_Idle01_UE`, preventing visible collarbone drop during locomotion transitions.
4. **Phase-Aligned Transitions**: Walk starts, cycles, and stops blend at compatible stride phases (heel strike to heel strike). Root translation is modulated continuously to prevent sudden foot popping at clip boundaries.
5. **Curved Navigation Vectors**: Waypoint transitions follow rounded Bezier trajectories with progressive deceleration at turns, ensuring root translation matches physical body rotation.
6. **Symmetric Mirrored Return**: Returning from stage-right utilizes a bilateral mirrored variant of the 180° turnaround with synchronized foot contacts.
