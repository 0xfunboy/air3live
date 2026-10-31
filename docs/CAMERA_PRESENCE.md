# Presenter Gaze Attention, Eye Contact, and Camera Presence

AIR3 Live features continuous 3D gaze tracking that anchors the presenter's eyes, head, and neck toward the active broadcast camera lens in real time.

## Kinematic Hierarchy and Rotation Limits

`public/air3-attention.mjs` samples joint axes from the MetaHuman bind pose. In `FACIAL_C_FacialRoot`, +Y is forward, +X is anatomical left, and -Z is up. The attention controller transforms gaze vectors into head-local space and distributes angular adjustments across parent joints:

1. Restore neutral additive offsets from prior frame.
2. Evaluate skeletal animation mixer.
3. Apply procedural locomotion / gesture layers.
4. Distribute gaze rotation across neck and head joints.
5. Synchronize body, hair, and clothing skeletons.
6. Evaluate binocular eye vergence, micro-saccades, and blinks.
7. Solve foot floor contact and accessories.

### Additive Joint Constraints

- **Neck & Head Compound**: Clamped to ±48° azimuth (yaw) and -18°/+20° elevation (pitch). Distributed: 14% to `neck_01`, 19% to `neck_02`, and 67% to `head`.
- **Binocular Eyes**: Independent horizontal limit of ±24° and vertical limit of ±17°.

Target positions are damped with a 110 ms time constant; neck/head follows at 300 ms, while ocular vergence responds at 25 ms. Rapid eye response ensures natural saccadic compensation during head movement.

## Natural Micro-Saccades and Blinks

During continuous speech, subtle eye micro-deviations occur periodically (every 14s for ~550 ms), drifting up to 2.8° before snapping back to camera lock. During idle pauses, blinks trigger naturally every 3-6 seconds.
