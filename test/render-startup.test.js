import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const baseEnv = {
  ...process.env,
  NODE_ENV: 'production', AUTH_REQUIRED: 'true', DEV_LOGIN_ENABLED: 'false', CSRF_ENABLED: 'true',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/not_a_real_database?connect_timeout=1',
  PUBLIC_BASE_URL: 'https://voice.example.test', SESSION_SECRET: 'synthetic-test-secret',
  GOOGLE_CLIENT_ID: 'test-id', GOOGLE_CLIENT_SECRET: 'test-secret',
  TWILIO_ACCOUNT_SID: 'AC' + '1'.repeat(32), TWILIO_API_KEY_SID: 'SK' + '2'.repeat(32),
  TWILIO_API_KEY_SECRET: 'synthetic-test-key', TWILIO_VERIFY_SERVICE_SID: 'VA' + '3'.repeat(32),
  TWILIO_AUTH_TOKEN: 'test-token', EMAIL_INBOUND_TOKEN: 'test-email-token',
  AGENT_DIRECTORY: '[{"email":"agent@example.test","identity":"agent","role":"agent"}]',
  VOICE_ROUTING_JSON: '', WITNEXT_URL: '', WITNEXT_INTEGRATION_SECRET: '',
};
function start(env = {}) {
  const result = spawnSync(process.execPath, ['scripts/start-render.js'], {
    env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 10000,
  });
  return { ...result, output: result.stdout + result.stderr };
}

test('Render startup rejects the old auth bypass before any migration or HTTP startup', () => {
  const result = start({ AUTH_REQUIRED: 'false', DEV_LOGIN_ENABLED: 'true' });
  assert.equal(result.status, 1);
  assert.match(result.output, /Refusing to start/);
  assert.doesNotMatch(result.output, /Migration failed|telephony running/);
});

test('Render startup does not serve a partially configured app after a migration failure', () => {
  const result = start();
  assert.equal(result.status, 1);
  assert.match(result.output, /Database migration did not complete/);
  assert.doesNotMatch(result.output, /telephony running/);
});

test('production cannot silently disable the configured MFA service', () => {
  const result = start({ TWILIO_VERIFY_SERVICE_SID: '' });
  assert.equal(result.status, 1);
  assert.match(result.output, /Verify credentials are required/);
  assert.doesNotMatch(result.output, /telephony running/);
});
