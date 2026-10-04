import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateEnv } from '../src/validate-env.js';

// Validate before touching the database. Do not migrate or listen publicly when
// an old Render environment still enables the development login bypass.
if (process.env.NODE_ENV !== 'production') {
  console.error('Render startup requires NODE_ENV=production.');
  process.exit(1);
}
validateEnv();
const migration = spawnSync(process.execPath, [fileURLToPath(new URL('./migrate.js', import.meta.url))], {
  stdio: 'inherit',
  env: process.env,
});
if (migration.error || migration.signal || migration.status !== 0) {
  console.error('Database migration did not complete; HTTP service was not started.');
  process.exit(1);
}
await import('../src/server.js');
