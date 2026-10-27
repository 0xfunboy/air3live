import { cp, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serviceRoot } from '../src/config.mjs';

const args = process.argv.slice(2), index = args.indexOf('--from');
if (index < 0 || !args[index + 1]) throw new Error('Use: npm run sync:metadata -- --from "/path/to/Saved/AIR3_Web_Metadata_..."');
const source = await realpath(resolve(args[index + 1]));
const metadataFile = join(source, 'air3-missing-metadata.json');
const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
if (metadata.schema !== 'air3.unreal-extra-metadata.v1') throw new Error('Unexpected metadata schema');
const destination = resolve(serviceRoot, 'public/assets/air3');
await mkdir(join(destination, 'metadata'), { recursive: true }); await mkdir(join(destination, 'textures'), { recursive: true });
const backup = resolve(serviceRoot, 'asset-backups', 'metadata-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(backup, { recursive: true });
try { await cp(join(destination, 'metadata/air3-missing-metadata.json'), join(backup, 'air3-missing-metadata.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
await cp(metadataFile, join(destination, 'metadata/air3-missing-metadata.json'));
let copied = 0;
for (const file of await readdir(join(source, 'missing-textures'))) {
  if (!/^[A-Za-z0-9_.-]+\.png$/i.test(file)) continue;
  const input = await realpath(join(source, 'missing-textures', file));
  if (!input.startsWith(source + '/') && !input.startsWith(source + '\\')) throw new Error('Unexpected texture symlink');
  if (!(await stat(input)).isFile()) continue;
  const names = new Set([file, file.replace(/__[a-f0-9]+(\.png)$/i, '$1')]);
  for (const name of names) {
    try { await cp(join(destination, 'textures', name), join(backup, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await cp(input, join(destination, 'textures', name));
  }
  copied++;
}
console.log(JSON.stringify({ copied, backup, next: 'Rebake materials and rebuild after reviewing the new export; existing render textures were not regenerated.' }));
