# Natural Shoulder Articulation and Speech Posture

This document details the shoulder stabilization system introduced to ensure anatomically natural clavicle and neck posture during speech delivery.

## Problem Context

In raw retargeting of foreign animation clips onto the AIR3 MetaHuman rig, clavicle bones in speech clips (`MH_Talk01` through `MH_Talk04`) exhibited excessive downward displacement (30–55 mm lower than idle reference posture), artificially elongating the neck and introducing visible collarbone distortion.

## Implemented Correction

The runtime coarticulation controller in `studio-broadcast/public/air3-speech-coarticulation.mjs` applies bounded posture correction to the upper torso during active speech:

1. **Idle Baseline Reference**: The neutral clavicle rotation from `MH_Idle01_UE` serves as the anatomical baseline.
2. **Dynamic Clamping**: Clavicle depression is restricted to an envelope within 4.2° of neutral posture.
3. **Arm Kinematic Continuity**: Humeral rotations are compensated dynamically in body-local space, ensuring arm gestures and hand movements preserve their recorded expressive directions without shoulder popping.
4. **Smooth Cross-fading**: Transitions between idle and speaking states utilize smooth cubic easing over 180 ms, eliminating abrupt transitions between sentences or during rapid conversational pauses.

## Verification

`test/talk-shoulders.test.mjs` samples 3,731 frames across all talk clips at 60 Hz. The test verifies that collarbone height remains strictly within 8 mm of neutral baseline across all frames, arm vectors maintain finite bounds, and zero discontinuities occur upon speech stop or seek events.
