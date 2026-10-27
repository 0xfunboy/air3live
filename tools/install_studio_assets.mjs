#!/usr/bin/env node
// Install the isolated asset/player addition into the previously delivered
// AIR3_Studio_Flow/studio-broadcast. No backend, dApp, Eliza or .env edits.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, cp, rename, stat } from 'node:fs/promises';

const args = process.argv.slice(2), at = args.indexOf('--studio');
if (at < 0 || !args[at + 1]) throw new Error('Use: node tools/install_studio_assets.mjs --studio "/path/to/AIR3_Studio_Flow/studio-broadcast"');
const pkg = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const studio = await realpath(path.resolve(args[at + 1]));
const project = JSON.parse(await readFile(path.join(studio, 'package.json'), 'utf8'));
if (project.name !== 'air3-studio-broadcast') throw new Error('Destination is not the AIR3 Studio broadcast service');
const versions = JSON.parse(await readFile(path.join(pkg, 'integration/versions.json'), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = (file) => stat(file).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; });
const publicDir = await realpath(path.join(studio, 'public'));
if (!publicDir.startsWith(studio + path.sep)) throw new Error('Public directory is outside the selected studio');
for (const [file, version] of Object.entries(versions)) {
  const currentPath = await realpath(path.join(publicDir, file));
  if (!currentPath.startsWith(publicDir + path.sep)) throw new Error('Unexpected symlink for ' + file);
  const current = sha(await readFile(currentPath));
  if (![version.baseSha256, version.updatedSha256].includes(current)) {
    throw new Error(file + ' has local changes. Nothing was installed. Merge integration/' + file + '.patch into your version instead.');
  }
  if (sha(await readFile(path.join(pkg, 'integration', file))) !== version.updatedSha256) throw new Error('Package checksum mismatch for ' + file);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const backup = path.join(studio, 'asset-backups', stamp);
const staging = path.join(studio, 'asset-staging-' + stamp);
await mkdir(backup, { recursive: true });
await mkdir(staging);
for (const folder of ['models', 'textures']) await cp(path.join(pkg, folder), path.join(staging, folder), { recursive: true });
await writeFile(path.join(staging, 'AIR3-ASSET-VERSION.json'), JSON.stringify({ version: 1, installedAt: new Date().toISOString(),
  requires: 'air3-avatar.mjs', avatarUrl: '/assets/air3/models/AIR3-runtime.glb', facialControls: 'pending calibration' }, null, 2));
const assetsParent = path.join(publicDir, 'assets');
await mkdir(assetsParent, { recursive: true });
if (await realpath(assetsParent) !== assetsParent) throw new Error('Refusing symlinked asset directory; staging and backup preserved');
const target = path.join(assetsParent, 'air3');
if (await exists(target)) await rename(target, path.join(backup, 'air3-assets'));
await rename(staging, target);
for (const file of ['studio-scene.mjs', 'app.mjs', 'air3-avatar.mjs']) {
  const destination = path.join(publicDir, file);
  if (await exists(destination)) await cp(destination, path.join(backup, file));
  const source = file === 'air3-avatar.mjs' ? path.join(pkg, 'runtime', file) : path.join(pkg, 'integration', file);
  const temporary = destination + '.' + stamp + '.tmp';
  await cp(source, temporary); await rename(temporary, destination);
}
console.log(JSON.stringify({ installed: true, studio, backup,
  configuration: 'AIR3_AVATAR_URL=/assets/air3/models/AIR3-runtime.glb',
  next: 'Set that line in studio-broadcast/.env and restart the gateway/broadcaster when ready. The installer did not edit .env.' }, null, 2));
