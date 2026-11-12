import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
const testIp = 'fd00:' + randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0, 7).join(':');
import { hash } from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AdminCategory, AdminConfig, AdminSubcategory, Group, SessionView, TicketDetail } from '@astrama/contracts';
import { totp } from '../src/mfa.js';

type Identity = { cookie: string; view: SessionView };
describe.skipIf(!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)('organisation setup — real PostgreSQL and runtime RLS', () => {
  const password = 'Organisation-test-password-2026!';
  const origin = 'http://localhost:4310';
  let app: NestFastifyApplication, owner: PrismaClient, runtime: PrismaClient;
  let admin: Identity, restricted: Identity, foreign: Identity, employee: Identity, agent: Identity;
  let group: Group, category: AdminCategory, child: AdminSubcategory, inherited: AdminSubcategory, ticket: TicketDetail;
  let baseId: string, otherCategoryId: string, foreignAgentId: string, secret: string;
  const tenants: string[] = [];
  const call = (method: 'GET' | 'POST', url: string, identity?: Identity, payload?: unknown, extra: Record<string, string> = {}) => app.inject({ remoteAddress: testIp, method, url: `/api${url}`, headers: { origin, ...(identity ? { cookie: identity.cookie, 'x-csrf-token': identity.view.csrfToken } : {}), ...extra }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  async function login(slug: string, email: string): Promise<Identity> {
    const response = await call('POST', '/auth/login', undefined, { organisation: slug, email, password });
    expect(response.statusCode, response.body).toBe(201);
    const cookies = response.headers['set-cookie'];
    return { view: response.json(), cookie: (Array.isArray(cookies) ? cookies[0] : cookies)!.split(';')[0]! };
  }
  async function enroll(identity: Identity) {
    const setup = await call('POST', '/auth/mfa/setup', identity);
    expect(setup.statusCode, setup.body).toBe(201);
    const secret = setup.json().secret as string;
    const response = await call('POST', '/auth/mfa/verify', identity, { code: totp(secret, Math.floor(Date.now() / 30000)) });
    expect(response.statusCode, response.body).toBe(201);
    identity.view = response.json();
    return secret;
  }
  beforeAll(async () => {
    process.env.NODE_ENV = 'test'; process.env.APP_ORIGIN = origin;
    process.env.MFA_ENCRYPTION_KEY ??= 'ac'.repeat(32);
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    runtime = new PrismaClient();
    const passwordHash = await hash(password);
    const slugs: string[] = [];
    for (let index = 0; index < 2; index++) {
      const tenant = await owner.tenant.create({ data: { slug: `org-test-${randomUUID()}`, name: 'Test organisation', brandName: 'Astrama' } });
      tenants.push(tenant.id); slugs.push(tenant.slug);
      const dept = await owner.department.create({ data: { tenantId: tenant.id, name: 'Triage', isTriage: true } });
      const cat = await owner.category.create({ data: { tenantId: tenant.id, departmentId: dept.id, name: 'Existing category' } });
      if (!index) baseId = dept.id; else otherCategoryId = cat.id;
      for (const role of ['admin', 'employee', 'agent']) {
        const user = await owner.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}@test.invalid`, role, passwordHash } });
        if (role === 'agent') {
          await owner.membership.create({ data: { tenantId: tenant.id, userId: user.id, departmentId: dept.id } });
          if (index) foreignAgentId = user.id;
        }
      }
    }
    const { createApp } = await import('../dist/main.js');
    app = await createApp(); await app.getHttpAdapter().getInstance().ready();
    restricted = await login(slugs[0]!, 'admin@test.invalid');
    admin = await login(slugs[0]!, 'admin@test.invalid');
    employee = await login(slugs[0]!, 'employee@test.invalid');
    agent = await login(slugs[0]!, 'agent@test.invalid');
    foreign = await login(slugs[1]!, 'admin@test.invalid');
    await enroll(foreign);
  }, 60000);
  afterAll(async () => {
    await app?.close(); await runtime?.$disconnect();
    if (!owner) return;
    for (const id of tenants) for (const table of ['idempotency', 'outbox', 'audits', 'config_audits', 'activities', 'tickets', 'sessions', 'memberships', 'subcategories', 'categories', 'counters', 'departments', 'users', 'tenants']) await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${table === 'tenants' ? 'id' : 'tenant_id'}"=$1::uuid`, id);
    await owner.$disconnect();
  });
  it('restricts password-only admins, binds enrollment to its session, and rejects replay', async () => {
    expect((await call('GET', '/admin/config', admin)).statusCode).toBe(403);
    expect((await call('GET', '/tickets', admin)).statusCode).toBe(403);
    const setup = await call('POST', '/auth/mfa/setup', admin);
    secret = setup.json().secret;
    const code = totp(secret, Math.floor(Date.now() / 30000));
    expect((await call('POST', '/auth/mfa/verify', restricted, { code })).statusCode).toBe(401);
    const verified = await call('POST', '/auth/mfa/verify', admin, { code });
    expect(verified.statusCode, verified.body).toBe(201); admin.view = verified.json();
    expect(admin.view.mfaVerified).toBe(true);
    expect((await call('POST', '/auth/mfa/verify', admin, { code })).statusCode).toBe(401);
    expect((await call('GET', '/admin/config', restricted)).statusCode).toBe(403);
    expect((await call('POST', '/auth/mfa/setup', admin)).statusCode).toBe(409);
    const row = await owner.user.findUniqueOrThrow({ where: { id: admin.view.user.id } });
    expect(row.mfaSecret).not.toContain(secret);
    expect(JSON.stringify((await call('GET', '/auth/session', admin)).json())).not.toContain(secret);
    const loginBody = { organisation: admin.view.tenant.slug, email: admin.view.user.email, password };
    expect((await call('POST', '/auth/login', undefined, loginBody)).statusCode).toBe(401);
    expect((await call('POST', '/auth/login', undefined, { ...loginBody, totpCode: code })).statusCode).toBe(401);
    await owner.user.update({ where: { id: admin.view.user.id }, data: { mfaLastStep: -1, mfaFailures: 0 } });
    const validLogin = await call('POST', '/auth/login', undefined, { ...loginBody, totpCode: code });
    expect(validLogin.statusCode, validLogin.body).toBe(201); expect(validLogin.json().mfaVerified).toBe(true);
  });
  it('denies every admin endpoint for nonadmins and protects tenant lookups and CSRF', async () => {
    const paths = ['/admin/groups', `/admin/groups/${randomUUID()}`, '/admin/categories', `/admin/categories/${randomUUID()}`, '/admin/subcategories', `/admin/subcategories/${randomUUID()}`, `/admin/categories/${randomUUID()}/delete`, `/admin/subcategories/${randomUUID()}/delete`];
    expect((await call('GET', '/admin/config', employee)).statusCode).toBe(403);
    // Valid bodies reach authorization before configuration access.
    const bodies = [{ name: 'Denied', memberIds: [] }, { revision: 0, name: 'Denied', active: true, memberIds: [] }, { name: 'Denied', departmentId: baseId, sensitive: false }, { revision: 0, name: 'Denied', departmentId: baseId, sensitive: false, active: true }, { categoryId: otherCategoryId, name: 'Denied', departmentId: null }, { revision: 0, name: 'Denied', departmentId: null, active: true }, { revision: 0 }, { revision: 0 }];
    for (const [i, path] of paths.entries()) {
      expect((await call('POST', path, employee, bodies[i])).statusCode).toBe(403);
      expect((await call('POST', path, undefined, bodies[i])).statusCode).toBe(401);
    }
    expect((await call('POST', '/auth/mfa/setup', employee)).statusCode).toBe(403);
    expect((await call('POST', '/auth/mfa/verify', employee, { code: '123456' })).statusCode).toBe(403);
    expect((await call('POST', '/admin/groups', admin, { name: 'Foreign member', memberIds: [foreignAgentId] })).statusCode).toBe(400);
    expect((await call('POST', '/admin/groups', admin, { name: 'Employee member', memberIds: [employee.view.user.id] })).statusCode).toBe(400);
    expect((await call('POST', '/admin/categories', foreign, { name: 'Foreign group', departmentId: baseId, sensitive: false })).statusCode).toBe(400);
    expect((await call('POST', '/admin/subcategories', admin, { categoryId: otherCategoryId, name: 'Foreign parent', departmentId: null })).statusCode).toBe(400);
    expect((await call('POST', '/admin/groups', admin, { name: 'Missing CSRF', memberIds: [] }, { 'x-csrf-token': '' })).statusCode).toBe(403);
  });
  it('creates groups/categories/subcategories, checks revisions and tenant-scoped updates/deletes', async () => {
    const created = await call('POST', '/admin/groups', admin, { name: 'Specialist group', memberIds: [agent.view.user.id] });
    expect(created.statusCode, created.body).toBe(201); group = created.json();
    category = (await call('POST', '/admin/categories', admin, { name: 'New category', departmentId: baseId, sensitive: true })).json();
    child = (await call('POST', '/admin/subcategories', admin, { categoryId: category.id, name: 'Override', departmentId: group.id })).json();
    inherited = (await call('POST', '/admin/subcategories', admin, { categoryId: category.id, name: 'Inherited', departmentId: null })).json();
    for (const [kind, row] of [['groups', group], ['categories', category], ['subcategories', child]] as const) {
      const { id, ...payload } = row;
      // Drop response-only fields to exercise valid update request schemas.
      const body = kind === 'groups' ? { revision: row.revision, name: row.name, active: row.active, memberIds: group.memberIds } : kind === 'categories' ? { revision: row.revision, name: row.name, active: row.active, departmentId: category.departmentId, sensitive: category.sensitive } : { revision: row.revision, name: row.name, active: row.active, departmentId: child.departmentId };
      void payload;
      expect((await call('POST', `/admin/${kind}/${id}`, foreign, body)).statusCode).toBe(404);
      expect((await call('POST', `/admin/${kind}/${id}`, admin, { ...body, revision: 99 })).statusCode).toBe(409);
      if (kind !== 'groups') expect((await call('POST', `/admin/${kind}/${id}/delete`, foreign, { revision: 0 })).statusCode).toBe(404);
    }
    const config = (await call('GET', '/admin/config', admin)).json<AdminConfig>();
    expect(config.organisation.id).toBe(tenants[0]); expect(config.groups.some(g => g.id === group.id)).toBe(true);
    expect((await call('GET', '/admin/config', foreign)).json<AdminConfig>().groups.some(g => g.id === group.id)).toBe(false);
  });
  it('routes inherited/overridden destinations, rejects mismatched and archived subcategories, preserves history', async () => {
    const create = (subcategoryId?: string, categoryId = category.id) => call('POST', '/tickets', employee, { categoryId, ...(subcategoryId ? { subcategoryId } : {}), summary: 'Check configured routing', description: 'The configured destination must be recorded on this incident.' }, { 'idempotency-key': randomUUID() });
    const overridden = await create(child.id); expect(overridden.statusCode, overridden.body).toBe(201); ticket = overridden.json();
    expect(ticket.departmentId).toBe(group.id); expect(ticket.subcategoryName).toBe(child.name);
    const inheritedTicket = await create(inherited.id); expect(inheritedTicket.statusCode, inheritedTicket.body).toBe(201); expect(inheritedTicket.json().departmentId).toBe(baseId);
    const config = (await call('GET', '/admin/config', admin)).json<AdminConfig>();
    const existingCategory = config.categories.find(c => c.id !== category.id)!;
    expect((await create(child.id, existingCategory.id)).statusCode).toBe(400);
    expect((await create(randomUUID())).statusCode).toBe(400);
    const changed = await call('POST', `/admin/subcategories/${child.id}`, admin, { revision: child.revision, name: child.name, departmentId: baseId, active: true });
    expect(changed.statusCode, changed.body).toBe(201); child = changed.json();
    expect((await call('GET', `/tickets/${ticket.id}`, employee)).json().departmentId).toBe(group.id);
    expect((await create(child.id)).json().departmentId).toBe(baseId);
    expect((await call('POST', `/admin/subcategories/${child.id}/delete`, admin, { revision: child.revision })).statusCode).toBe(409);
    child = (await call('POST', `/admin/subcategories/${child.id}`, admin, { revision: child.revision, name: child.name, departmentId: baseId, active: false })).json();
    expect((await create(child.id)).statusCode).toBe(400);
    expect((await call('POST', `/admin/categories/${category.id}/delete`, admin, { revision: 0 })).statusCode).toBe(409);
    const archived = await call('POST', `/admin/categories/${category.id}`, admin, { ...category, id: undefined, revision: 0, active: false });
    expect(archived.statusCode, archived.body).toBe(201); category = archived.json();
    const catalog = (await call('GET', '/catalog', employee)).json();
    expect(catalog.categories.some((c: {id:string}) => c.id === category.id)).toBe(false);
    expect((await call('GET', `/tickets/${ticket.id}`, employee)).json().subcategoryId).toBe(child.id);
  });
  it('protects triage, active mappings, unresolved assignments and stale authenticated memberships', async () => {
    const claimed = await call('POST', `/tickets/${ticket.id}/claim`, agent, { revision: ticket.revision });
    expect(claimed.statusCode, claimed.body).toBe(201);
    expect((await call('POST', `/admin/groups/${group.id}`, admin, { revision: group.revision, name: group.name, active: true, memberIds: [] })).statusCode).toBe(409);
    expect((await call('POST', `/admin/groups/${group.id}`, admin, { revision: group.revision, name: group.name, active: false, memberIds: group.memberIds })).statusCode).toBe(409);
    const triage = (await call('GET', '/admin/config', admin)).json<AdminConfig>().groups.find(g => g.id === baseId)!;
    expect((await call('POST', `/admin/groups/${baseId}`, admin, { revision: triage.revision, name: triage.name, active: true, memberIds: [] })).statusCode).toBe(409);
    expect((await call('GET', `/tickets/${ticket.id}`, admin)).statusCode).toBe(404);
    const audit = await owner.configAudit.findMany({ where: { tenantId: tenants[0] } });
    expect(audit.some(a => a.action === 'group.created')).toBe(true); expect(audit.some(a => a.action === 'subcategory.updated')).toBe(true);
    await expect(runtime.configAudit.findMany()).resolves.toEqual([]);
    await expect(runtime.$transaction(async tx => { await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenants[0]}, true)`; return tx.configAudit.deleteMany(); })).rejects.toThrow();
    await expect(owner.subcategory.create({ data: { tenantId: tenants[0]!, categoryId: otherCategoryId, name: 'Foreign parent FK' } })).rejects.toThrow();
    await expect(owner.ticket.update({ where: { id: ticket.id }, data: { subcategoryId: inherited.id, categoryId: otherCategoryId } })).rejects.toThrow();
  });
  it('deletes only unused rows, audits removal and persists MFA brute-force lockouts', async () => {
    const unusedCategory = (await call('POST', '/admin/categories', admin, { name: 'Unused', departmentId: baseId, sensitive: false })).json<AdminCategory>();
    const unused = (await call('POST', '/admin/subcategories', admin, { categoryId: unusedCategory.id, name: 'Unused child', departmentId: null })).json<AdminSubcategory>();
    expect((await call('POST', `/admin/subcategories/${unused.id}/delete`, admin, { revision: 0 })).statusCode).toBe(201);
    expect((await call('POST', `/admin/categories/${unusedCategory.id}/delete`, admin, { revision: 0 })).statusCode).toBe(201);
    expect(await owner.configAudit.count({ where: { tenantId: tenants[0], action: { endsWith: '.deleted' } } })).toBe(2);
    await owner.user.update({ where: { id: admin.view.user.id }, data: { mfaFailures: 0, mfaLockedUntil: null } });
    for (let i = 0; i < 5; i++) expect((await call('POST', '/auth/mfa/verify', restricted, { code: '000000' })).statusCode).toBe(401);
    expect((await call('POST', '/auth/mfa/verify', restricted, { code: '000000' })).statusCode).toBe(429);
    expect((await owner.user.findUniqueOrThrow({ where: { id: admin.view.user.id } })).mfaFailures).toBe(5);
  });
  it('serializes claim against membership removal and refreshes a stale authenticated actor', async () => {
    const raceGroup = (await call('POST', '/admin/groups', admin, { name: 'Membership race', memberIds: [agent.view.user.id] })).json<Group>();
    const raceCategory = (await call('POST', '/admin/categories', admin, { name: 'Membership race', departmentId: raceGroup.id, sensitive: true })).json<AdminCategory>();
    const created = (await call('POST', '/tickets', employee, { categoryId: raceCategory.id, summary: 'Membership race incident', description: 'Claiming and membership removal must not strand assigned work.' }, { 'idempotency-key': randomUUID() })).json<TicketDetail>();
    const [claim, remove] = await Promise.all([
      call('POST', `/tickets/${created.id}/claim`, agent, { revision: 0 }),
      call('POST', `/admin/groups/${raceGroup.id}`, admin, { revision: 0, name: raceGroup.name, active: true, memberIds: [] })
    ]);
    expect([[201, 409], [403, 201], [404, 201]]).toContainEqual([claim.statusCode, remove.statusCode]);
    if (claim.statusCode === 201) {
      await owner.ticket.update({ where: { id: created.id }, data: { assignedToId: null } });
      expect((await call('POST', `/admin/groups/${raceGroup.id}`, admin, { revision: 0, name: raceGroup.name, active: true, memberIds: [] })).statusCode).toBe(201);
    }
    const { TicketsService } = await import('../dist/tickets.js');
    const service = app.get(TicketsService);
    const stale = { id: agent.view.user.id, tenantId: tenants[0]!, role: 'agent' as const, departmentIds: [raceGroup.id] };
    await expect(service.get(stale, created.id)).rejects.toThrow('Ticket not found');
    await expect(service.claim(stale, created.id, { revision: 0 })).rejects.toThrow();
  });
  it('rejects parent reactivation when an active child routes to an archived group', async () => {
    const createdGroup = (await call('POST', '/admin/groups', admin, { name: 'Archive override', memberIds: [] })).json<Group>();
    const parent = (await call('POST', '/admin/categories', admin, { name: 'Archive parent', departmentId: baseId, sensitive: false })).json<AdminCategory>();
    await call('POST', '/admin/subcategories', admin, { categoryId: parent.id, name: 'Active child', departmentId: createdGroup.id });
    expect((await call('POST', `/admin/groups/${createdGroup.id}`, admin, { name: createdGroup.name, memberIds: [], active: false, revision: 0 })).statusCode).toBe(409);
    expect((await call('POST', `/admin/categories/${parent.id}`, admin, { name: parent.name, departmentId: baseId, sensitive: false, active: false, revision: 0 })).statusCode).toBe(201);
    expect((await call('POST', `/admin/groups/${createdGroup.id}`, admin, { name: createdGroup.name, memberIds: [], active: false, revision: 0 })).statusCode).toBe(201);
    expect((await call('POST', `/admin/categories/${parent.id}`, admin, { name: parent.name, departmentId: baseId, sensitive: false, active: true, revision: 1 })).statusCode).toBe(409);
  });
});
