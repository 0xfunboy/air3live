import { build, version as esbuildVersion } from 'esbuild';
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, dirname } from 'node:path';
import { serviceRoot } from '../src/config.mjs';

const outputDir = resolve(serviceRoot, 'public/build');
await mkdir(outputDir, { recursive: true });
// This directory contains only generated frontend modules.
for (const file of await readdir(outputDir)) if (/\.(js|map|json)$/.test(file)) await rm(resolve(outputDir, file));
const result = await build({ absWorkingDir: serviceRoot,
  entryPoints: { app: 'public/app.mjs', control: 'public/control/control.mjs', preview: 'public/preview/viewer.mjs', health: 'public/health-worker.mjs' },
  bundle: true, splitting: true, format: 'esm', platform: 'browser', target: ['chrome120'],
  external: ['three', 'three/*'], minify: true, legalComments: 'eof', metafile: true,
  outdir: 'public/build', chunkNames: 'shared-[hash]', logLevel: 'info' });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputs = [];
for (const name of Object.keys(result.metafile.inputs).sort()) {
  const bytes = await readFile(resolve(serviceRoot, name)); inputs.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
}
const outputs = [];
for (const name of Object.keys(result.metafile.outputs).sort()) {
  const bytes = await readFile(resolve(serviceRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
}
// Include runtime asset identity: the look preset and imported geometry/textures
// are part of the tested product even when they are not bundled JavaScript.
const assets = [];
async function inventoryAssets(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    // Editor/transfer temporary files are not public runtime assets. In
    // particular, never turn an interrupted atomic write into a release input.
    if (entry.name.startsWith('.')) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await inventoryAssets(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path); assets.push({ path: relative(serviceRoot, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) });
    }
  }
}
await inventoryAssets(resolve(serviceRoot, 'public/assets/air3'));
// Validate every local GLB image reference in the shipped model directory.
const modelDir = resolve(serviceRoot, 'public/assets/air3/models');
const modelRefs = [];
for (const name of (await readdir(modelDir)).filter((name) => !name.startsWith('.') && name.endsWith('.glb'))) {
  const path = resolve(modelDir, name), buffer = await readFile(path);
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) throw new Error('Invalid GLB: ' + name);
  const gltf = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString('utf8'));
  for (const image of gltf.images || []) if (image.uri && !image.uri.startsWith('data:')) {
    const target = resolve(dirname(path), image.uri), root = resolve(serviceRoot, 'public/assets/air3');
    if (!target.startsWith(root + '/') && !target.startsWith(root + '\\')) throw new Error('External model texture: ' + image.uri);
    const info = await stat(target); if (!info.isFile()) throw new Error('Missing model texture: ' + image.uri);
    modelRefs.push({ model: name, image: relative(root, target).replaceAll('\\', '/') });
  }
}
for (const [file, source, compiled] of [['public/index.html', '/studio/app.mjs', '/studio/build/app.js'],
  ['public/preview/index.html', '/studio/preview/viewer.mjs', '/studio/build/preview.js']]) {
  const path = resolve(serviceRoot, file), html = await readFile(path, 'utf8');
  if (!html.includes('src="' + source + '"') && !html.includes('src="' + compiled + '"')) throw new Error('Unknown HTML entry point: ' + file);
  await writeFile(path, html.replace('src="' + source + '"', 'src="' + compiled + '"'));
}
// The HTML and styles define the delivered controls and logo placement too.
for (const name of ['public/index.html', 'public/styles.css', 'public/look-controls.css', 'public/live-titles.css', 'public/control/index.html', 'public/control/style.css', 'public/preview/index.html', 'public/preview/style.css']) {
  const bytes = await readFile(resolve(serviceRoot, name)); inputs.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
}
const manifest = { schema: 'air3.frontend-build.v1', builtAt: new Date().toISOString(), node: process.version,
  esbuild: esbuildVersion, inputs, outputs, assets, externalDependencies: ['three@0.186.1'], validatedModelImages: modelRefs };
await writeFile(resolve(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ built: true, compiler: 'esbuild ' + esbuildVersion, sourceModules: inputs.length,
  outputs: outputs.length, bytes: outputs.reduce((sum, row) => sum + row.bytes, 0), modelImages: modelRefs.length }));
