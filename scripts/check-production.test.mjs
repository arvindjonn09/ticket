import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { validateProduction } from './check-production.mjs';

test('production preflight rejects missing, shared and demonstration secrets', () => {
  assert.ok(validateProduction({}).length > 5);
  const env = { APP_DOMAIN: 'desk.example.com', POSTGRES_PASSWORD: randomBytes(24).toString('hex'), APP_DB_PASSWORD: randomBytes(24).toString('hex'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), S3_ACCESS_KEY: 'independent-access', S3_SECRET_KEY: randomBytes(24).toString('hex'), SMTP_HOST: 'smtp.example.com', SMTP_USER: 'service', SMTP_PASSWORD: 'private-mail-password', SMTP_FROM: 'desk@example.com', OPERATOR_ALERT_EMAIL: 'operations@example.com', TLS_DIRECTORY: resolve('.local-backups/certs') };
  assert.deepEqual(validateProduction(env), []);
  assert.ok(validateProduction({ ...env, APP_DOMAIN: 'Desk.Example.com' }).some(value => value.includes('lowercase hostname')));
  assert.ok(validateProduction({ ...env, SMTP_PORT: '465', SMTP_SECURE: 'false' }).some(value => value.includes('Use SMTP_SECURE')));
  assert.ok(validateProduction({ ...env, SMTP_PORT: '587', SMTP_SECURE: 'true' }).some(value => value.includes('Use SMTP_SECURE')));
  assert.deepEqual(validateProduction({ ...env, SMTP_PORT: '465', SMTP_SECURE: 'true' }), []);
  assert.ok(validateProduction({ ...env, APP_DB_PASSWORD: env.POSTGRES_PASSWORD }).some(value => value.includes('must differ')));
  assert.ok(validateProduction({ ...env, MFA_ENCRYPTION_KEY: 'ac'.repeat(32) }).some(value => value.includes('random')));
});


test('production environment parser accepts required S3 variable names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astrama-preflight-')), file = join(directory, 'synthetic.env');
  try {
    await writeFile(file, 'S3_ACCESS_KEY=synthetic-check');
    const result = spawnSync(process.execPath, [resolve('scripts/check-production.mjs'), file], { encoding: 'utf8', env: {}, windowsHide: true });
    assert.equal(result.status, 1); assert.match(result.stderr, /APP_DOMAIN is required/); assert.doesNotMatch(result.stderr, /Use KEY=value/);
  } finally { await unlink(file); await rmdir(directory); }
});
