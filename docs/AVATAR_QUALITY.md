# Avatar Rig Quality, Proportions, and Retargeting

This document outlines the retargeting and proportion normalization that resolved skeletal distortion from foreign animation clips.

## Skeletal Proportion Normalization

Foreign mocap clips originally embedded static bone translations recorded from a performer of different height and limb proportions. Direct replay distorted the avatar's anatomy:
- `upperarm_l`: original track was +37.2% too long, pulling the shoulder outward.
- `spine_05`: torso was artificially elongated.
- `foot_l`: leg was lengthened, causing knee hyper-extension.

The retargeting pipeline (`tools/retarget_body_translations.py`) strips static translation deltas, referencing the neutral bind pose of `MH_Idle01_UE`. Limb segment lengths remain locked to the MetaHuman anatomy across all 7 clips.

## Facial Morph Targets and Jaw Articulation

The facial rig provides 35 active morph blendshapes. Jaw articulation is linked to the lower dental arch and tongue while preserving upper teeth anchoring, ensuring natural phonetic speech delivery without jaw dislocation.
