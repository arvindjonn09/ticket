import { test, expect, type Page } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { cleanupFixture } from './fixture-cleanup';
import jsQR from 'jsqr';

// Reuse the API's installed database/password libraries for isolated fixtures.
const apiRequire = createRequire(resolve('apps/api/package.json'));
const { PrismaClient } = apiRequire('@prisma/client');
const { hash, argon2id } = apiRequire('argon2');
const password = 'Organisation-browser-test-2026!';
const slug = `browser-${randomUUID()}`;
test.use({ actionTimeout: 10000 });
let owner: InstanceType<typeof PrismaClient>;
let tenantId: string;

// Independent RFC 6238 calculation for the browser's authenticator simulator.
function authenticatorCode(secret: string, seconds = Math.floor(Date.now() / 1000)) {
  const bits = [...secret].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Organisation', { exact: true }).fill(slug);
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.beforeAll(async () => {
  test.setTimeout(30000);
  // Provision only identity fixtures. All routing setup is performed through the UI.
  owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL ?? 'postgresql://astrama_owner:astrama-local-owner@localhost:5439/astrama' });
  const tenant = await owner.tenant.create({ data: { slug, name: 'Browser Test Organisation', brandName: 'Astrama' } });
  tenantId = tenant.id;
  const passwordHash = await hash(password, { type: argon2id });
  for (const [email, name, role] of [
    ['admin@browser.test', 'Organisation Administrator', 'admin'],
    ['employee@browser.test', 'Test Employee', 'employee'],
    ['desktop@browser.test', 'Desktop Agent', 'agent'],
    ['messaging@browser.test', 'Messaging Agent', 'agent'],
  ]) await owner.user.create({ data: { tenantId, email, name, role, passwordHash } });
});

test.afterAll(async () => {
  try { if (owner && tenantId) await cleanupFixture(owner, tenantId, slug); }
  finally { await owner?.$disconnect(); }
});

test('administrator configures groups and subcategory routing; only the destination group can claim', async ({ page, browser }) => {
  test.setTimeout(90000);
  // RFC 6238 SHA1 test vector at t=59, reduced to the application's six digits.
  expect(authenticatorCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59)).toBe('287082');
  await signIn(page, 'admin@browser.test');
  await expect(page.getByRole('heading', { name: 'Set up your authenticator', exact: true })).toBeVisible();
  expect((await page.request.get('/api/admin/config')).status()).toBe(403);
  const externalRequests: string[] = [];
  const appOrigin = new URL(page.url()).origin;
  page.on('request', request => {
    if (new URL(request.url()).origin !== appOrigin) externalRequests.push(request.url());
  });
  await page.getByRole('button', { name: 'Begin setup', exact: true }).click();
  const qr = page.getByRole('img', { name: 'Authenticator setup QR code', exact: true });
  await expect(qr).toBeVisible();
  const decodeQr = async () => {
    const pixels = await qr.evaluate((element: HTMLCanvasElement) => ({
      width: element.width, height: element.height,
      data: Array.from(element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data),
    }));
    return jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data;
  };
  const uri = await decodeQr();
  expect(uri).toMatch(/^otpauth:\/\/totp\//);
  const secret = new URL(uri!).searchParams.get('secret')!;
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await decodeQr()).toBe(uri);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/authenticator-qr-mobile.png', fullPage: true });
  await page.getByText('Can’t scan? Enter the setup key manually', { exact: true }).click();
  await expect(page.getByLabel('Setup secret', { exact: true })).toHaveValue(secret);
  await expect(page.getByLabel('Authenticator URI', { exact: false })).toHaveValue(uri!);
  expect(externalRequests).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Authenticator code', { exact: true }).fill(authenticatorCode(secret));
  await page.getByRole('button', { name: 'Verify authenticator', exact: true }).click();
  await page.getByRole('link', { name: 'Organisation setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Organisation setup', exact: true })).toBeVisible();

  const sectionMenu = page.getByLabel('Manage section', { exact: false });
  const groupDraft = page.getByRole('group', { name: 'Create group', exact: true });
  await expect(sectionMenu).toHaveValue('groups');
  await expect(page.getByRole('region', { name: 'Categories', exact: true })).toBeHidden();
  await groupDraft.getByLabel('Group name', { exact: true }).fill('Unfinished group');
  await groupDraft.getByRole('checkbox', { name: /Desktop Agent/ }).check();
  await sectionMenu.selectOption('categories');
  await expect(groupDraft).toBeHidden();
  await expect(page.getByRole('group', { name: 'Create category', exact: true })).toBeVisible();
  await sectionMenu.selectOption('groups');
  await expect(groupDraft.getByLabel('Group name', { exact: true })).toHaveValue('Unfinished group');
  await expect(groupDraft.getByRole('checkbox', { name: /Desktop Agent/ })).toBeChecked();

  for (const [name, member] of [['Desktop Support', 'Desktop Agent'], ['Messaging Support', 'Messaging Agent']]) {
    const form = page.getByRole('group', { name: 'Create group', exact: true });
    await form.getByLabel('Group name', { exact: true }).fill(name!);
    await form.getByRole('checkbox', { name: new RegExp(member!) }).check();
    await form.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('summary').filter({ hasText: name! })).toBeVisible();
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/organisation-groups.png', fullPage: true });
  await sectionMenu.selectOption('categories');
  const categoryForm = page.getByRole('group', { name: 'Create category', exact: true });
  await categoryForm.getByLabel('Category name', { exact: true }).fill('Technology');
  await categoryForm.getByLabel('Support group', { exact: false }).selectOption({ label: 'Desktop Support' });
  await categoryForm.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('summary').filter({ hasText: 'Technology' })).toBeVisible();

  await sectionMenu.selectOption('subcategories');
  for (const [name, destination] of [['Laptop', 'Inherit category group'], ['Email', 'Messaging Support']]) {
    const form = page.getByRole('group', { name: 'Create subcategory', exact: true });
    await form.getByLabel('Parent category', { exact: false }).selectOption({ label: 'Technology' });
    await form.getByLabel('Subcategory name', { exact: true }).fill(name!);
    await form.getByLabel('Routing group', { exact: false }).selectOption({ label: destination! });
    await form.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('summary').filter({ hasText: name! })).toBeVisible();
  }

  await sectionMenu.selectOption('preview');
  await page.getByLabel('Preview category', { exact: false }).selectOption({ label: 'Technology' });
  await page.getByLabel('Preview subcategory', { exact: false }).selectOption({ label: 'Laptop' });
  await expect(page.getByText('Your issue will go to Desktop Support.', { exact: true })).toBeVisible();
  await page.getByLabel('Preview subcategory', { exact: false }).selectOption({ label: 'Email' });
  await expect(page.getByText('Your issue will go to Messaging Support.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/organisation-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/organisation-dark.png', fullPage: true });

  const employeeContext = await browser.newContext();
  const employee = await employeeContext.newPage();
  await signIn(employee, 'employee@browser.test');
  await expect(employee.getByRole('heading', { name: /^(My tickets|Tickets)$/, exact: true })).toBeVisible();
  expect((await employee.request.get('/api/admin/config')).status()).toBe(403);
  await expect(employee.getByRole('link', { name: 'Organisation setup', exact: true })).toHaveCount(0);

  async function submit(subcategory: string, destination: string) {
    await employee.getByRole('link', { name: 'Report an issue', exact: true }).first().click();
    await employee.getByLabel('What do you need help with?', { exact: false }).selectOption({ label: 'Technology' });
    await employee.getByLabel('Subcategory', { exact: false }).selectOption({ label: subcategory });
    await expect(employee.getByText(new RegExp(`Your issue will go to ${destination}`))).toBeVisible();
    const title = `Browser routing for ${subcategory}`;
    await employee.getByLabel('Give your issue a short title', { exact: false }).fill(title);
    await employee.getByLabel('Describe the issue', { exact: false }).fill('Please investigate this problem with our organisation equipment.');
    await employee.getByRole('button', { name: 'Submit incident', exact: true }).click();
    await expect(employee.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(employee.getByText(destination, { exact: true })).toBeVisible();
    return employee.url();
  }
  const inheritedUrl = await submit('Laptop', 'Desktop Support');
  const overrideUrl = await submit('Email', 'Messaging Support');

  const desktopContext = await browser.newContext();
  const desktop = await desktopContext.newPage();
  await signIn(desktop, 'desktop@browser.test');
  await expect(desktop.getByRole('heading', { name: /^(My tickets|Tickets)$/, exact: true })).toBeVisible();
  await desktop.goto(overrideUrl);
  await expect(desktop.getByRole('heading', { name: 'Browser routing for Email', exact: true })).toBeVisible();
  await expect(desktop.getByRole('button', { name: 'Assign to me', exact: true })).toHaveCount(0);
  await desktop.goto(inheritedUrl);
  await desktop.getByRole('button', { name: 'Assign to me', exact: true }).click();
  await expect(desktop.getByRole('button', { name: 'Assign to me', exact: true })).toHaveCount(0);

  const messagingContext = await browser.newContext();
  const messaging = await messagingContext.newPage();
  await signIn(messaging, 'messaging@browser.test');
  await expect(messaging.getByRole('heading', { name: /^(My tickets|Tickets)$/, exact: true })).toBeVisible();
  await messaging.goto(overrideUrl);
  await messaging.getByRole('button', { name: 'Assign to me', exact: true }).click();
  await expect(messaging.getByRole('button', { name: 'Assign to me', exact: true })).toHaveCount(0);

  await sectionMenu.selectOption('categories');
  await page.locator('summary').filter({ hasText: 'Technology' }).click();
  const categoryEdit = page.getByRole('group', { name: 'Edit category: Technology', exact: true });
  await categoryEdit.getByLabel('Support group', { exact: false }).selectOption({ label: 'Messaging Support' });
  const remapResponse = page.waitForResponse(r => r.request().method() === 'POST' && /\/admin\/categories\/[\w-]+$/.test(r.url()));
  await categoryEdit.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await remapResponse).ok()).toBe(true);
  await employee.goto(inheritedUrl);
  await expect(employee.getByText('Desktop Support', { exact: true })).toBeVisible();
  await submit('Laptop', 'Messaging Support');

  await sectionMenu.selectOption('subcategories');
  await page.locator('summary').filter({ hasText: 'Email' }).click();
  const subcategoryEdit = page.getByRole('group', { name: 'Edit subcategory: Email', exact: true });
  await subcategoryEdit.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.locator('summary').filter({ hasText: 'Email' })).toContainText('Archived');
  await employee.reload();
  await employee.getByRole('link', { name: 'Report an issue', exact: true }).first().click();
  await employee.getByLabel('What do you need help with?', { exact: false }).selectOption({ label: 'Technology' });
  await expect(employee.getByLabel('Subcategory', { exact: false }).getByRole('option', { name: 'Email', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const section of ['categories', 'subcategories', 'preview', 'groups']) {
    await sectionMenu.selectOption(section);
    await expect(page.locator('#organisation-panels section:visible')).toHaveCount(1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/organisation-mobile.png', fullPage: true });
  await employeeContext.close(); await desktopContext.close(); await messagingContext.close();
});



