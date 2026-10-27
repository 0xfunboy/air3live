import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const text = source.replace('GENERATE_PRODUCER_TOKEN', randomBytes(32).toString('hex')).replace('GENERATE_PLAYER_TOKEN', randomBytes(32).toString('hex')).replace('GENERATE_OPERATOR_TOKEN', randomBytes(32).toString('hex'));
try {
  await writeFile(new URL('../.env', import.meta.url), text, { flag: 'wx', mode: 0o600 });
  console.log('Creato .env con chiavi distinte per regia, produttore e player. La regia locale è pronta; lo streaming parte soltanto dal pulsante LIVE.');
} catch (e) {
  if (e.code === 'EEXIST') { console.log('.env already exists; no values were changed.'); }
  else throw e;
}
