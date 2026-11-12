import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { cleanupFixture } from './fixture-cleanup';

const require = createRequire(resolve('apps/api/package.json'));
const { PrismaClient } = require('@prisma/client'), { hash } = require('argon2');
const slug = `recover-browser-${randomUUID()}`, email = `recover-${randomUUID()}@test.invalid`;
let owner: InstanceType<typeof PrismaClient>, tenantId: string;
test.beforeAll(async () => {
  owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL ?? 'postgresql://astrama_owner:astrama-local-owner@localhost:5439/astrama' });
  const tenant = await owner.tenant.create({ data: { slug, name: 'Recovery browser fixture', brandName: 'Astrama' } }); tenantId = tenant.id;
  await owner.user.create({ data: { tenantId, name: 'Recovery employee', email, role: 'employee', passwordHash: await hash('Previous-test-password-2026!') } });
});
test.afterAll(async () => {
  try { if (owner && tenantId) await cleanupFixture(owner, tenantId, slug); }
  finally { await owner?.$disconnect(); }
});

test('employee recovers a password through real queued email and cannot replay the link', async ({ page, request }) => {
  test.setTimeout(90000);
  await page.goto('/'); await page.getByRole('link', { name: 'Forgot your password?', exact: true }).click();
  await page.getByLabel('Organisation', { exact: true }).fill(slug);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send recovery link', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('If an active account matches');
  let messageId = '';
  await expect.poll(async () => {
    const response = await request.get(`http://localhost:4312/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const mailbox = await response.json(); messageId = mailbox.messages[0]?.ID ?? ''; return !!messageId;
  }, { timeout: 45000 }).toBe(true);
  const message = await (await request.get(`http://localhost:4312/api/v1/message/${messageId}`)).json();
  const url = String(message.Text).match(/https?:\/\/\S+#reset-password\?\S+/)?.[0]; expect(url).toBeTruthy();
  await page.goto(url!);
  await expect(page.getByRole('heading', { name: 'Reset your password', exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByLabel('New password', { exact: true }).fill('Changed-test-password-2026!');
  await page.getByLabel('Confirm password', { exact: true }).fill('Changed-test-password-2026!');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Your password has been changed');
  await page.getByRole('link', { name: 'Back to sign in', exact: true }).click();
  await page.getByLabel('Organisation', { exact: true }).fill(slug); await page.getByLabel('Email address', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill('Changed-test-password-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'My tickets', exact: true })).toBeVisible();
  const credentials = new URLSearchParams(new URL(url!).hash.slice('#reset-password?'.length));
  const replay = await request.post('/api/auth/reset-password', { headers: { origin: 'http://localhost:4310' }, data: { organisation: slug, token: credentials.get('token'), password: 'Another-test-password-2026!' } });
  expect(replay.status()).toBe(400);
});

