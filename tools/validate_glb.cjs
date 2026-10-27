#!/usr/bin/env node
'use strict';
// npm install --no-audit --no-fund gltf-validator
// node validate_glb.cjs INPUT.glb REPORT.json
// AIR3_GLTF_VALIDATOR_MODULE may point at an already installed validator module.
// Relative images/buffers are read only within the GLB's parent package folder.
// For models/AIR3-runtime.glb this permits ../textures/, not arbitrary host files.
const fs = require('node:fs');
const path = require('node:path');
const validator = require(process.env.AIR3_GLTF_VALIDATOR_MODULE || 'gltf-validator');
const [input, reportPath] = process.argv.slice(2);
if (!input || !reportPath) {
  console.error('Usage: node validate_glb.cjs INPUT.glb REPORT.json');
  process.exit(2);
}
(async () => {
  const inputPath = fs.realpathSync(path.resolve(input));
  const packageRoot = fs.realpathSync(path.resolve(path.dirname(inputPath), '..'));
  const report = await validator.validateBytes(new Uint8Array(fs.readFileSync(input)), {
    uri: path.basename(input), format: 'glb', maxIssues: 10000,
    writeTimestamp: false,
    externalResourceFunction: async (uri) => {
      if (typeof uri !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.includes('\\')) {
        throw new Error('Only relative local glTF resource paths are allowed');
      }
      const decoded = decodeURIComponent(uri);
      if (path.isAbsolute(decoded) || decoded.includes('\0') || decoded.includes('?') || decoded.includes('#')) {
        throw new Error('Invalid local glTF resource path');
      }
      const candidate = fs.realpathSync(path.resolve(path.dirname(inputPath), decoded));
      const relative = path.relative(packageRoot, candidate);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Resource is outside the asset package');
      }
      return new Uint8Array(fs.readFileSync(candidate));
    },
  });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const counts = {};
  for (const issue of report.issues.messages) counts[issue.code] = (counts[issue.code] || 0) + 1;
  console.log(JSON.stringify({ validatorVersion: report.validatorVersion, ...report.issues,
    messages: undefined, issueCodes: counts,
  }, null, 2));
  process.exitCode = report.issues.numErrors > 0 ? 1 : 0;
})().catch((error) => { console.error(error.message); process.exitCode = 2; });
