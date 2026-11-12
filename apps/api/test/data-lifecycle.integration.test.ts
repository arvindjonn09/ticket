import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDataPolicy } from '@astrama/contracts';
import type { AuthContext } from '../src/auth.js';
import type { Database } from '../src/database.js';
import type { DataPolicyService } from '../src/data-lifecycle.js';
import type { exportTenant, deleteTenant, retainTenant } from '../src/operator-data.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const configured = process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL && process.env.S3_ENDPOINT && process.env.CLAMAV_HOST;
describe.skipIf(!configured)('tenant policy/export/retention/deletion - real PostgreSQL and private storage', () => {
  let owner: PrismaClient, db: Database, policies: DataPolicyService, app: NestFastifyApplication, storage: S3Client;
  let exportData: typeof exportTenant, deleteData: typeof deleteTenant, retainData: typeof retainTenant;
  let admin: AuthContext, employee: AuthContext, foreign: AuthContext, rawEmployeeToken: string;
  let terminalId: string, openId: string, objectKey: string, orphanKey: string, foreignKey: string, directory: string;
  const tenants: string[] = [], slugs: string[] = [], origin = 'http://localhost:4310';
  const request = (index = 0, execute = false) => ({ tenantId: tenants[index]!, expectedSlug: slugs[index]!, operator: 'integration-test', reason: 'Disposable integration fixture lifecycle', evidence: 'TEST-AUTHORIZATION-ONLY', execute, offline: true });
  beforeAll(async () => {
    process.env.NODE_ENV = 'test'; process.env.APP_ORIGIN = origin; process.env.MFA_ENCRYPTION_KEY = 'ac'.repeat(32);
    const operators = await import('../dist/operator-data.js'); exportData = operators.exportTenant; deleteData = operators.deleteTenant; retainData = operators.retainTenant;
    const { Database } = await import('../dist/database.js'), { DataPolicyService } = await import('../dist/data-lifecycle.js'), { tokenHash } = await import('../dist/auth.js');
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL }); db = new Database(); policies = new DataPolicyService(db); storage = operators.operatorStorage();
    directory = await mkdtemp(join(tmpdir(), 'astrama-data-lifecycle-'));
    for (let index = 0; index < 2; index++) {
      const tenant = await owner.tenant.create({ data: { slug: `data-test-${randomUUID()}`, name: 'Disposable data fixture', brandName: 'Test' } }); tenants.push(tenant.id); slugs.push(tenant.slug);
      for (const role of (index ? ['admin'] : ['admin', 'employee']) as ('admin' | 'employee')[]) {
        const user = await owner.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}@example.invalid`, role, mfaEnrolled: role === 'admin', passwordHash: 'SECRET-PASSWORD-HASH-CANARY', mfaSecret: 'SECRET-MFA-CANARY', invitationHash: randomUUID() } });
        const token = randomBytes(32).toString('base64url');
        const session = await owner.session.create({ data: { tenantId: tenant.id, userId: user.id, tokenHash: tokenHash(token), csrfToken: randomUUID(), mfaVerified: role === 'admin', expiresAt: new Date(Date.now() + 3600000) } });
        const auth: AuthContext = { tenantId: tenant.id, id: user.id, sessionId: session.id, role, departmentIds: [], view: { user: { id: user.id, email: user.email, name: user.name, role, departmentIds: [] }, tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, brandName: tenant.brandName }, csrfToken: session.csrfToken, mfaVerified: role === 'admin' } };
        if (index) foreign = auth; else if (role === 'admin') admin = auth; else { employee = auth; rawEmployeeToken = token; }
      }
    }
    const group = await owner.department.create({ data: { tenantId: admin.tenantId, name: 'Test group' } });
    const category = await owner.category.create({ data: { tenantId: admin.tenantId, name: 'Test category', departmentId: group.id } });
    for (let index = 0; index < 2; index++) {
      const row = await owner.ticket.create({ data: { tenantId: admin.tenantId, sequence: index + 1, number: `INC000${index + 1}`, summary: 'Fixture business content', description: 'Tenant-scoped business export', state: index ? 'Open' : 'Complete', priority: 'P3', severity: 'S3', callerId: employee.id, submittedById: employee.id, categoryId: category.id, departmentId: group.id, updatedAt: new Date('2020-01-01') } });
      if (index) openId = row.id; else terminalId = row.id;
    }
    objectKey = `${admin.tenantId}/${terminalId}/${randomUUID()}`; orphanKey = `${admin.tenantId}/orphan/${randomUUID()}`; foreignKey = `${foreign.tenantId}/protected/${randomUUID()}`;
    for (const Key of [objectKey, orphanKey, foreignKey]) await storage.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key, Body: 'Lifecycle fixture bytes' }));
    await owner.attachment.create({ data: { tenantId: admin.tenantId, ticketId: terminalId, authorId: employee.id, filename: 'fixture.txt', contentType: 'application/octet-stream', size: Buffer.byteLength('Lifecycle fixture bytes'), audience: 'internal', status: 'clean', storageKey: objectKey, createdAt: new Date('2020-01-01') } });
    await owner.invitationMail.create({ data: { tenantId: admin.tenantId, userId: admin.id, invitationHash: randomUUID(), encryptedUrl: 'SECRET-ENCRYPTED-INVITATION-CANARY' } });
    await owner.$executeRaw`INSERT INTO password_recoveries(id,tenant_id,user_id,token_hash,password_hash,email,expires_at,encrypted_url) VALUES(${randomUUID()}::uuid,${admin.tenantId}::uuid,${admin.id}::uuid,${randomUUID()},'SECRET-RECOVERY-HASH-CANARY','admin@example.invalid',now()+interval '1 hour','SECRET-RECOVERY-URL-CANARY')`;
    const { createApp } = await import('../dist/main.js'); app = await createApp(); await app.getHttpAdapter().getInstance().ready();
  }, 60000);
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (owner && storage) {
      for (let index = 0; index < tenants.length; index++) if (await owner.tenant.findUnique({ where: { id: tenants[index] } })) {
        await owner.$executeRaw`DELETE FROM tenant_data_policies WHERE tenant_id=${tenants[index]}::uuid`;
        await deleteData(owner, request(index, true), storage);
      }
      for (const id of tenants) await owner.$executeRaw`DELETE FROM data_operation_audits WHERE tenant_id=${id}::uuid`;
    }
    storage?.destroy(); await owner?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 60000);
  it('MFA administrators configure only their tenant; no policy, secret ledger or owner operation access through runtime', async () => {
    expect(await policies.get(admin)).toEqual(defaultDataPolicy);
    await expect(policies.get(employee)).rejects.toThrow('administrator');
    await expect(policies.get({ ...admin, view: { ...admin.view, mfaVerified: false } })).rejects.toThrow('administrator');
    await expect(policies.get({ ...admin, tenantId: foreign.tenantId })).rejects.toThrow('administrator');
    await expect(policies.set(admin, { ...defaultDataPolicy, tenantId: foreign.tenantId })).rejects.toThrow();
    await expect(db.$queryRaw`SELECT * FROM data_operation_audits`).rejects.toThrow();
    await expect(exportData(db, request(), join(directory, 'runtime'), storage)).rejects.toThrow('migration-owner');
    const changed = await policies.set(admin, { ...defaultDataPolicy, attachments: { maxFileBytes: 32, maxFilesPerTicket: 1, maxTotalBytes: 40, allowedExtensions: ['txt'] } });
    expect(changed.revision).toBe(1); expect(await policies.get(foreign)).toEqual(defaultDataPolicy);
    await expect(policies.set(admin, defaultDataPolicy)).rejects.toThrow('changed');
    expect(await db.withTenant(foreign.tenantId, tx => tx.$queryRaw`SELECT * FROM tenant_data_policies`)).toEqual([]);
  });
  it('enforces configured upload extension/size/count/total while preserving scanning and ticket permissions', async () => {
    const upload = async (filename: string, bytes: string) => {
      const boundary = `fixture-${randomUUID()}`, row = await owner.ticket.findUniqueOrThrow({ where: { id: openId } });
      const payload = [`--${boundary}\r\nContent-Disposition: form-data; name="audience"\r\n\r\ncustomer`, `--${boundary}\r\nContent-Disposition: form-data; name="revision"\r\n\r\n${row.revision}`, `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${bytes}`, `--${boundary}--\r\n`].join('\r\n');
      return app.inject({ method: 'POST', url: `/api/tickets/${openId}/attachments`, headers: { origin, cookie: `astrama_session=${rawEmployeeToken}`, 'x-csrf-token': employee.view.csrfToken, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    };
    expect((await upload('bad.exe', 'Safe content')).statusCode).toBe(400);
    expect((await upload('too-big.txt', 'x'.repeat(33))).statusCode).toBe(400);
    const clean = await upload('good.TXT', 'Safe content'); expect(clean.statusCode, clean.body).toBe(201);
    expect((await upload('second.txt', 'Safe content')).statusCode).toBe(400);
    let policy = await policies.get(admin); policy = await policies.set(admin, { ...policy, attachments: { ...policy.attachments, maxFilesPerTicket: 10, maxTotalBytes: 15 } });
    expect((await upload('combined.txt', 'Safe content')).statusCode).toBe(400);
    const { checkAttachmentPolicy } = await import('../dist/data-lifecycle.js');
    expect(() => checkAttachmentPolicy(policy, 'good.txt', 32)).toThrow('limits');
  }, 60000);
  it('exports a consistent scoped snapshot with attachment hashes, excludes all authentication material and audits request/outcome', async () => {
    const output = join(directory, 'export'); await exportData(owner, request(), output, storage);
    const json = await readFile(join(output, 'records.json'), 'utf8');
    expect(json).toContain('Fixture business content'); expect(json).not.toContain(foreign.tenantId);
    expect(json).not.toMatch(/SECRET-|passwordHash|password_hash|mfaSecret|mfa_secret|tokenHash|token_hash|encryptedUrl|encrypted_url|invitationHash|invitation_hash|csrfToken/);
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    for (const file of manifest.files) expect(createHash('sha256').update(await readFile(join(output, file.path))).digest('hex')).toBe(file.sha256);
    if (process.platform !== 'win32') expect((await stat(output)).mode & 0o077).toBe(0);
    expect(await owner.$queryRaw`SELECT outcome FROM data_operation_audits WHERE tenant_id=${admin.tenantId}::uuid AND operation='export' ORDER BY created_at`).toEqual([{ outcome: 'requested' }, { outcome: 'completed' }]);
    await expect(exportData(owner, { ...request(), expectedSlug: slugs[1]! }, join(directory, 'foreign'), storage)).rejects.toThrow('mismatch');
  }, 60000);
  it('observes legal holds committed while an operator waits for the tenant lock before touching storage', async () => {
    const before = await policies.get(admin), lockName = `configuration:${admin.tenantId}`;
    const enabled = await policies.set(admin, { ...before, retention: { tickets: { days: 1, legalHold: false }, attachments: { days: 1, legalHold: false }, audits: { days: 1, legalHold: false } } });
    let pending: Promise<{ error?: unknown }> | undefined;
    await owner.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockName},0))`;
      pending = retainData(owner, request(0, true), storage).then(() => ({}), error => ({ error }));
      await expect.poll(async () => {
        const [waiting] = await owner.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=((hashtextextended(${lockName},0)>>32)&4294967295)::oid AND objid=(hashtextextended(${lockName},0)&4294967295)::oid) AS waiting`;
        return waiting?.waiting;
      }, { timeout: 10000 }).toBe(true);
      await tx.$executeRaw`UPDATE tenant_data_policies SET policy=${JSON.stringify({ ...enabled, legalHold: true })}::jsonb,revision=revision+1 WHERE tenant_id=${admin.tenantId}::uuid`;
    }, { timeout: 20000 });
    const outcome = await pending!;
    expect(outcome.error).toBeInstanceOf(Error); expect((outcome.error as Error).message).toContain('Legal hold');
    expect(await owner.ticket.count({ where: { tenantId: admin.tenantId } })).toBe(2);
    expect((await storage.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey }))).Body).toBeTruthy();
    const held = await policies.get(admin);
    await policies.set(admin, { ...before, revision: held.revision });
  }, 60000);
  it('retention is disabled until every class is configured, preview changes nothing and legal holds block execution', async () => {
    expect((await retainData(owner, request(), storage)).enabled).toBe(false);
    let policy = await policies.get(admin);
    policy = await policies.set(admin, { ...policy, retention: { tickets: { days: 30, legalHold: false }, attachments: { days: 60, legalHold: false }, audits: { days: 90, legalHold: true } } });
    await expect(retainData(owner, request(0, true), storage)).rejects.toThrow('Legal hold');
    await expect(deleteData(owner, request(0, true), storage)).rejects.toThrow('Legal hold');
    policy = await policies.set(admin, { ...policy, retention: { ...policy.retention, audits: { days: 90, legalHold: false } } });
    const preview = await retainData(owner, request(), storage); expect(preview.ticketIds).toEqual([terminalId]);
    expect(await owner.ticket.count({ where: { tenantId: admin.tenantId } })).toBe(2);
    expect((await storage.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey }))).Body).toBeTruthy();
    await retainData(owner, request(0, true), storage);
    expect(await owner.ticket.findUnique({ where: { id: terminalId } })).toBeNull(); expect(await owner.ticket.findUnique({ where: { id: openId } })).toBeTruthy();
    await expect(storage.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey }))).rejects.toThrow();
    await policies.set(admin, { ...policy, legalHold: true });
    await expect(deleteData(owner, request(), storage)).rejects.toThrow('Legal hold');
    await policies.set(admin, { ...policy, revision: policy.revision + 1, legalHold: false });
  }, 60000);
  it('delete preview is unchanged; partial real storage failure disables tenant, revokes sessions, keeps retry metadata and later completes without foreign deletion', async () => {
    const before = await owner.tenant.findUnique({ where: { id: admin.tenantId } });
    const preview = await deleteData(owner, request(), storage); expect(preview.execute).toBe(false);
    expect(await owner.tenant.findUnique({ where: { id: admin.tenantId } })).toEqual(before);
    expect(await owner.session.count({ where: { tenantId: admin.tenantId } })).toBe(2);
    await expect(deleteData(owner, { ...request(0, true), offline: false }, storage)).rejects.toThrow('offline');
    let once = true;
    storage.middlewareStack.add(next => async args => {
      if (once && args.input && typeof args.input === 'object' && 'Key' in args.input && args.input.Key === orphanKey && args.input.constructor === Object) { once = false; throw new Error('Fixture storage failure'); }
      return next(args);
    }, { step: 'initialize', name: 'fixtureFailure' });
    await expect(deleteData(owner, request(0, true), storage)).rejects.toThrow('Fixture storage failure');
    storage.middlewareStack.remove('fixtureFailure');
    expect((await owner.tenant.findUniqueOrThrow({ where: { id: admin.tenantId } })).active).toBe(false);
    expect(await owner.session.count({ where: { tenantId: admin.tenantId } })).toBe(0);
    expect(await owner.$queryRaw`SELECT tenant_id FROM tenant_deletion_jobs WHERE tenant_id=${admin.tenantId}::uuid`).toHaveLength(1);
    await deleteData(owner, request(0, true), storage);
    expect(await owner.tenant.findUnique({ where: { id: admin.tenantId } })).toBeNull();
    expect(await owner.$queryRaw`SELECT tenant_id FROM tenant_deletion_jobs WHERE tenant_id=${admin.tenantId}::uuid`).toEqual([]);
    expect(await owner.$queryRaw`SELECT outcome FROM data_operation_audits WHERE tenant_id=${admin.tenantId}::uuid AND operation='delete' AND outcome='completed'`).toHaveLength(1);
    expect((await storage.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: foreignKey }))).Body).toBeTruthy();
    await expect(storage.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: orphanKey }))).rejects.toThrow();
  }, 60000);
});




