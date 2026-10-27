import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureTalkShoulders } from '../test/fixtures/talk-shoulder-fixture.mjs';

const measured = await measureTalkShoulders();
const sources = {};
for (const file of ['public/assets/air3/models/AIR3-runtime.glb', 'public/air3-avatar.mjs', 'public/air3-talk-shoulders.mjs',
  'public/air3-stage-motion.mjs', 'public/air3-locomotion.mjs', 'test/fixtures/talk-shoulder-fixture.mjs', 'test/talk-shoulders.test.mjs']) {
  const bytes = await readFile(new URL('../' + file, import.meta.url));
  sources[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const m = measured.metrics;
const passed = measured.clips.length === 4 && measured.sampledFrames > 3700 && m.maximumCorrectedShoulderDropMetres <= .008001 &&
  m.maximumCorrectedShoulderRiseMetres <= .008001 && m.maximumArmOrientationErrorRadians < 1e-6 &&
  m.maximumBonePositionDifferenceMetres === 0 && m.maximumBoneScaleDifference === 0 && m.maximumLowerBodyPositionDifferenceMetres < 1e-8;
const result = { schema: 'air3.talk-shoulders-qa.v1', date: new Date().toISOString(), passed, sources,
  environment: { node: process.version, platform: process.platform, arch: process.arch, renderer: 'none; actual delivered GLB skeleton and animation data' },
  ...measured, limitations: ['Deterministic 60 Hz sampling is not a GPU performance benchmark.',
    'The 8 mm envelope applies at full talk weight, before optional stage locomotion/pointing layers.',
    'Shoulder drop is the upper-arm attachment height relative to the neck in avatar-local metres.',
    'This is skeletal pose QA; source browser views and compiled preview QA verify rendered appearance separately.'] };
const output = resolve(process.env.AIR3_QA_DIR || fileURLToPath(new URL('../../docs/validation/current/', import.meta.url)));
await mkdir(output, { recursive: true }); await writeFile(resolve(output, 'talk-shoulders-report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed, output, sampledFrames: measured.sampledFrames, metrics: measured.metrics }));
if (!passed) process.exitCode = 1;
