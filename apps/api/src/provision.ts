import { PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { encryptSecret } from './mfa.js';

export const provisionSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/),
  name: z.string().trim().min(1).max(120), brandName: z.string().trim().min(1).max(120),
  admin: z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email().max(254).transform(value => value.toLowerCase()) }).strict()
}).strict();

/** New organisations only. This privileged command never searches or resets existing accounts. */
export async function provisionOrganisation(body: unknown) {
  const input = provisionSchema.parse(body);
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
  const origin = process.env.APP_ORIGIN;
  if (!origin || new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be an exact origin');
  const tenantId = randomUUID(), userId = randomUUID(), token = randomBytes(32).toString('base64url');
  const invitationHash = createHash('sha256').update(token).digest('hex'), expiresAt = new Date(Date.now() + 48 * 3600000);
  const url = `${origin}/#activate?token=${encodeURIComponent(token)}&organisation=${encodeURIComponent(input.slug)}`;
  const encryptedUrl = encryptSecret(url, `invitation:${tenantId}:${userId}`);
  const passwordHash = await hash(randomBytes(32), { type: argon2id });
  const db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL, log: [] });
  try {
    await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.tenant.create({ data: { id: tenantId, slug: input.slug, name: input.name, brandName: input.brandName } });
      await tx.user.create({ data: { id: userId, tenantId, name: input.admin.name, email: input.admin.email, role: 'admin', active: false, passwordHash, invitationHash, invitationExpiresAt: expiresAt, invitedAt: new Date(), revision: 1 } });
      await tx.department.create({ data: { tenantId, name: 'Service Desk Triage', isTriage: true } });
      await tx.invitationMail.create({ data: { tenantId, userId, invitationHash, encryptedUrl } });
      await tx.configAudit.create({ data: { tenantId, actorId: userId, entityId: tenantId, action: 'organisation.provisioned', detail: { slug: input.slug, administratorEmail: input.admin.email, invitationExpiresAt: expiresAt.toISOString() } } });
    });
    return { slug: input.slug, adminEmail: input.admin.email, emailQueued: true, invitation: { url, expiresAt: expiresAt.toISOString() } };
  } finally { await db.$disconnect(); }
}

async function main(args: string[]) {
  const show = args.includes('--show-invitation'), files = args.filter(arg => arg !== '--show-invitation');
  if (files.length !== 1 || files[0]!.startsWith('-')) throw new Error('Usage: node dist/provision.js <organisation.json> [--show-invitation]');
  const contents = await readFile(resolve(files[0]!), 'utf8');
  if (Buffer.byteLength(contents) > 30000) throw new Error('Provisioning input is too large');
  const result = await provisionOrganisation(JSON.parse(contents.replace(/^\uFEFF/, '')));
  console.info(JSON.stringify({ slug: result.slug, adminEmail: result.adminEmail, emailQueued: result.emailQueued, ...(show ? { invitation: result.invitation } : {}) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch(() => {
    console.error('Provisioning failed. Validate the JSON, owner connection, origin and encryption key. Existing organisations are never reset.');
    process.exitCode = 1;
  });
}
