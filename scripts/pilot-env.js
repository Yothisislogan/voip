import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const template = await readFile(new URL('../.env.pilot.example', import.meta.url), 'utf8');
const content = template.replace('__GENERATE_DB_PASSWORD__', randomBytes(32).toString('hex'))
  .replace('__GENERATE_SESSION_SECRET__', randomBytes(48).toString('hex'))
  .replace('__GENERATE_MEDIA_SECRET__', randomBytes(48).toString('hex'));
try {
  await writeFile(new URL('../.env.pilot', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created .env.pilot with private permissions. Fill the blank settings directly on the server; secrets were not printed.');
} catch (error) {
  console.error(error.code === 'EEXIST' ? '.env.pilot already exists; preserved it without changes.' : 'Could not write .env.pilot.');
  process.exitCode = 1;
}
