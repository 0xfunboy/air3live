#!/usr/bin/env node
// Optional QA dependency, deliberately separate from the broadcaster runtime.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.AIR3_QA_DIR || path.join(root, 'docs/validation/current'));
fs.mkdirSync(path.join(output, 'imported-assets'), { recursive: true });
const entries = [
  ['avatar', 'models/AIR3-runtime.glb', 'avatar-gltf-validator.json'],
  ['hair-wavy', 'hair/wavy.glb'], ['hair-artemis', 'hair/artemis.glb'],
  ['footwear-boot', 'footwear/boot.glb'], ['footwear-shoes-test', 'footwear/shoes-test.glb'],
  ['clothing-crop', 'clothing/crop-top.glb'],
];
const result = { schema: 'air3.imported-assets-validator.v1', date: new Date().toISOString(), assets: [] };
for (const [id, relative, reportFile = 'imported-assets/' + id + '.json'] of entries) {
  const file = path.join(root, 'studio-broadcast/public/assets/air3', relative), reportPath = path.join(output, reportFile);
  const child = spawnSync(process.execPath, [path.join(__dirname, 'validate_glb.cjs'), file, reportPath], { encoding: 'utf8' });
  if (child.error) throw child.error;
  const validation = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const issueCodes = {};
  for (const message of validation.issues.messages) issueCodes[message.code] = (issueCodes[message.code] || 0) + 1;
  const bytes = fs.readFileSync(file);
  result.assets.push({ id, path: path.relative(root, file).replaceAll('\\', '/'),
    report: path.relative(root, reportPath).replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, validatorVersion: validation.validatorVersion, exitCode: child.status,
    errors: validation.issues.numErrors, warnings: validation.issues.numWarnings,
    infos: validation.issues.numInfos, hints: validation.issues.numHints, stderr: child.stderr, issueCodes });
}
result.totalErrors = result.assets.reduce((sum, row) => sum + row.errors, 0);
result.totalWarnings = result.assets.reduce((sum, row) => sum + row.warnings, 0);
result.passed = result.assets.every(row => row.exitCode === 0 && row.errors === 0);
fs.writeFileSync(path.join(output, 'imported-assets-validator.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: result.passed, assets: result.assets.length, errors: result.totalErrors, warnings: result.totalWarnings }));
process.exitCode = result.passed ? 0 : 1;
