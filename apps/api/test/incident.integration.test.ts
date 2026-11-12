import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
const testIp = 'fd00:' + randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0, 7).join(':');
import { hash, argon2id } from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { SessionView, TicketDetail } from '@astrama/contracts';

const enabled = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const password = 'Integration-test-password-2026!';
type Identity = { cookie: string; csrf: string; view: SessionView };
describe.skipIf(!enabled)('first incident slice — real PostgreSQL/runtime RLS', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let runtime: PrismaClient;
  let employee: Identity, agent: Identity, secondAgent: Identity, colleague: Identity, otherTenant: Identity;
  let tenantId: string, tenant2Id: string, categoryId: string, otherCategoryId: string, sensitiveCategoryId: string;
  let incident: TicketDetail;
  const fixtures: string[] = [];
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:4310';
  const inject = (method: 'GET' | 'POST', url: string, identity?: Identity, payload?: unknown, extra: Record<string, string> = {}) => app.inject({ remoteAddress: testIp, method, url: `/api${url}`, headers: { origin, ...(identity ? { cookie: identity.cookie, 'x-csrf-token': identity.csrf } : {}), ...extra }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  async function login(slug: string, email: string): Promise<Identity> {
    const response = await inject('POST', '/auth/login', undefined, { organisation: slug, email, password });
    expect(response.statusCode, response.body).toBe(201);
    const cookies = response.headers['set-cookie'];
    const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)!.split(';')[0]!;
    const view = response.json<SessionView>();
    return { cookie, csrf: view.csrfToken, view };
  }
  async function scoped<T>(id: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runtime.$transaction(async tx => { await tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, true)`; return work(tx); });
  }
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ORIGIN = origin;
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    const runtimeUrl = new URL(process.env.DATABASE_URL!);
    runtimeUrl.searchParams.set('connection_limit', '1');
    runtime = new PrismaClient({ datasourceUrl: runtimeUrl.toString() });
    const passwordHash = await hash(password, { type: argon2id });
    const tenantSlugs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const tenant = await owner.tenant.create({ data: { slug: `integration-${randomUUID()}`, name: 'Integration organisation', brandName: 'Astrama' } });
      fixtures.push(tenant.id); tenantSlugs.push(tenant.slug);
      const department = await owner.department.create({ data: { tenantId: tenant.id, name: 'Test support', isTriage: true } });
      const category = await owner.category.create({ data: { tenantId: tenant.id, name: 'Test incidents', departmentId: department.id } });
      const sensitiveDepartment = await owner.department.create({ data: { tenantId: tenant.id, name: 'Restricted support' } });
      const sensitive = await owner.category.create({ data: { tenantId: tenant.id, name: 'Restricted incidents', departmentId: sensitiveDepartment.id, sensitive: true } });
      for (const [email, role] of [['employee@test.invalid', 'employee'], ['colleague@test.invalid', 'employee'], ['agent@test.invalid', 'agent'], ['agent2@test.invalid', 'agent']]) {
        const user = await owner.user.create({ data: { tenantId: tenant.id, email, role, name: email.split('@')[0]!, passwordHash } });
        if (role === 'agent') await owner.membership.create({ data: { tenantId: tenant.id, userId: user.id, departmentId: department.id } });
      }
      if (i === 0) { tenantId = tenant.id; categoryId = category.id; sensitiveCategoryId = sensitive.id; }
      else { tenant2Id = tenant.id; otherCategoryId = category.id; }
    }
    // Use tsc output: Nest dependency metadata is emitted by TypeScript, not esbuild.
    const { createApp } = await import('../dist/main.js');
    app = await createApp();
    await app.getHttpAdapter().getInstance().ready();
    employee = await login(tenantSlugs[0]!, 'employee@test.invalid');
    agent = await login(tenantSlugs[0]!, 'agent@test.invalid');
    secondAgent = await login(tenantSlugs[0]!, 'agent2@test.invalid');
    colleague = await login(tenantSlugs[0]!, 'colleague@test.invalid');
    otherTenant = await login(tenantSlugs[1]!, 'employee@test.invalid');
  }, 30000);
  afterAll(async () => {
    await app?.close(); await runtime?.$disconnect();
    if (owner) {
      // Fixtures are named, isolated tenants; never truncate shared demo data.
      for (const id of fixtures) {
        for (const table of ['idempotency', 'outbox', 'audits', 'activities', 'tickets', 'sessions', 'memberships', 'categories', 'counters', 'departments', 'users', 'tenants']) {
          await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${table === 'tenants' ? 'id' : 'tenant_id'}" = $1::uuid`, id);
        }
      }
      await owner.$disconnect();
    }
  });
  it('requires login for every protected endpoint and rejects invalid login/origin', async () => {
    expect((await inject('GET', '/health')).json()).toEqual({ status: 'ok' });
    for (const [method, path] of [['GET', '/auth/session'], ['POST', '/auth/logout'], ['GET', '/catalog'], ['GET', '/tickets'], ['POST', '/tickets'], ['GET', `/tickets/${randomUUID()}`], ['POST', `/tickets/${randomUUID()}/claim`], ['POST', `/tickets/${randomUUID()}/messages`], ['POST', `/tickets/${randomUUID()}/state`]] as const) expect((await inject(method, path)).statusCode).toBe(401);
    expect((await inject('POST', '/auth/login', undefined, { organisation: employee.view.tenant.slug, email: 'employee@test.invalid', password: 'incorrect' })).statusCode).toBe(401);
    expect((await inject('POST', '/auth/login', undefined, { organisation: employee.view.tenant.slug, email: 'employee@test.invalid', password }, { origin: 'https://foreign.invalid' })).statusCode).toBe(403);
    expect((await inject('GET', '/auth/session', employee)).json().tenant.id).toBe(tenantId);
  });
  it('enforces CSRF and strict input/category validation', async () => {
    const body = { categoryId, summary: 'Cannot use the laptop', description: 'The laptop does not start when I press the power button.' };
    for (const headers of [{ 'x-csrf-token': '' }, { 'x-csrf-token': 'é'.repeat(43) }, { origin: 'https://foreign.invalid' }]) expect((await inject('POST', '/tickets', employee, body, { 'idempotency-key': randomUUID(), ...headers })).statusCode).toBe(403);
    expect((await inject('POST', '/tickets', employee, { ...body, summary: 'tiny' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    expect((await inject('POST', '/tickets', employee, body)).statusCode).toBe(400);
    expect((await inject('POST', '/tickets', employee, { ...body, categoryId: otherCategoryId }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
  });
  it('creates one atomic incident for simultaneous identical retries; independent tenant numbering', async () => {
    const payload = { categoryId, summary: 'Network connection fails', description: 'The network connection fails repeatedly when opening the application.' };
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 6 }, () => inject('POST', '/tickets', employee, payload, { 'idempotency-key': key })));
    for (const response of responses) expect(response.statusCode, response.body).toBe(201);
    expect(new Set(responses.map(r => r.json().id)).size).toBe(1);
    incident = responses[0]!.json<TicketDetail>();
    expect(incident.number).toBe('INC0001');
    expect((await inject('POST', '/tickets', employee, { ...payload, summary: 'Changed request content' }, { 'idempotency-key': key })).statusCode).toBe(409);
    const foreign = await Promise.all([key, randomUUID()].map(foreignKey => inject('POST', '/tickets', otherTenant, { ...payload, categoryId: otherCategoryId }, { 'idempotency-key': foreignKey })));
    for (const response of foreign) expect(response.statusCode, response.body).toBe(201);
    expect(foreign.map(r => r.json().number).sort()).toEqual(['INC0001', 'INC0002']);
    const sameKeyOtherActor = await inject('POST', '/tickets', colleague, payload, { 'idempotency-key': key });
    expect(sameKeyOtherActor.statusCode).toBe(201); expect(sameKeyOtherActor.json().id).not.toBe(incident.id);
    expect(await owner.audit.count({ where: { ticketId: incident.id } })).toBe(1);
    expect(await owner.outbox.count({ where: { ticketId: incident.id } })).toBe(1);
  });
  it('filters list/search/catalog and denies other employees and tenants on detail and mutations', async () => {
    for (const identity of [colleague, otherTenant]) {
      expect((await inject('GET', `/tickets/${incident.id}`, identity)).statusCode).toBe(404);
      for (const [action, body] of [['claim', { revision: 0 }], ['messages', { revision: 0, body: 'Attempted access', audience: 'customer' }], ['state', { revision: 0, state: 'In Progress' }]] as const) expect((await inject('POST', `/tickets/${incident.id}/${action}`, identity, body)).statusCode).toBe(404);
      const searchResults = (await inject('GET', '/tickets?search=Network', identity)).json().tickets as TicketDetail[];
      expect(searchResults.some(t => t.id === incident.id)).toBe(false);
    }
    expect((await inject('GET', '/tickets?search=Network&state=Open&priority=P3&scope=mine', employee)).json().tickets.some((t: TicketDetail) => t.id === incident.id)).toBe(true);
    expect((await inject('GET', '/catalog', otherTenant)).json().categories.some((c: { id: string }) => c.id === categoryId)).toBe(false);
    expect((await inject('POST', `/tickets/${incident.id}/claim`, employee, { revision: 0 })).statusCode).toBe(403);
  });
  it('claims once under contention and returns safe current values on stale revisions', async () => {
    const responses = await Promise.all([agent, secondAgent].map(identity => inject('POST', `/tickets/${incident.id}/claim`, identity, { revision: incident.revision })));
    expect(responses.map(r => r.statusCode).sort()).toEqual([201, 409]);
    incident = responses.find(r => r.statusCode === 201)!.json();
    const stale = await inject('POST', `/tickets/${incident.id}/messages`, employee, { revision: 0, body: 'More information about this incident.', audience: 'customer' });
    expect(stale.statusCode).toBe(409); expect(stale.json().current.revision).toBe(1); expect(stale.body).not.toContain('resolution');
  });
  it('completes employee→agent→employee journey without internal content leakage', async () => {
    const internal = 'PRIVATE diagnostic details never shown to requester';
    expect((await inject('POST', `/tickets/${incident.id}/messages`, employee, { revision: incident.revision, body: internal, audience: 'internal' })).statusCode).toBe(403);
    incident = (await inject('POST', `/tickets/${incident.id}/messages`, agent, { revision: incident.revision, body: internal, audience: 'internal' })).json();
    expect((await inject('GET', `/tickets/${incident.id}`, employee)).body).not.toContain(internal);
    incident = (await inject('POST', `/tickets/${incident.id}/messages`, employee, { revision: incident.revision, body: 'The connection is still failing.', audience: 'customer' })).json();
    incident = (await inject('POST', `/tickets/${incident.id}/state`, agent, { revision: incident.revision, state: 'In Progress' })).json();
    expect((await inject('POST', `/tickets/${incident.id}/state`, agent, { revision: incident.revision, state: 'Resolved' })).statusCode).toBe(400);
    const resolved = await inject('POST', `/tickets/${incident.id}/state`, agent, { revision: incident.revision, state: 'Resolved', resolution: internal, customerSummary: 'The network connection has been restored.' });
    expect(resolved.statusCode, resolved.body).toBe(201); incident = resolved.json();
    const employeeView = await inject('GET', `/tickets/${incident.id}`, employee);
    expect(employeeView.body).not.toContain(internal); expect(employeeView.body).toContain('The network connection has been restored.');
    incident = (await inject('POST', `/tickets/${incident.id}/state`, employee, { revision: incident.revision, state: 'In Progress' })).json();
    incident = (await inject('POST', `/tickets/${incident.id}/state`, agent, { revision: incident.revision, state: 'Resolved', resolution: internal, customerSummary: 'The connection now works reliably.' })).json();
    incident = (await inject('POST', `/tickets/${incident.id}/state`, employee, { revision: incident.revision, state: 'Complete' })).json();
    expect(incident.state).toBe('Complete');
    expect((await inject('POST', `/tickets/${incident.id}/messages`, employee, { revision: incident.revision, body: 'Cannot post after closure', audience: 'customer' })).statusCode).toBe(403);
    expect((await inject('POST', `/tickets/${incident.id}/state`, employee, { revision: incident.revision, state: 'In Progress' })).statusCode).toBe(403);
  });
  it('preserves sensitivity on unstaffed category triage and hides notes from agents outside the stored group', async () => {
    const response = await inject('POST', '/tickets', employee, { categoryId: sensitiveCategoryId, summary: 'Sensitive routing fallback', description: 'A restricted category must preserve sensitivity while routing to triage.' }, { 'idempotency-key': randomUUID() });
    expect(response.statusCode, response.body).toBe(201);
    const ticket = response.json<TicketDetail>();
    const stored = await owner.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(stored.sensitive).toBe(true);
    expect(await owner.audit.findFirst({ where: { ticketId: ticket.id } })).toMatchObject({ detail: { routingException: true } });
    await owner.membership.deleteMany({ where: { tenantId, userId: secondAgent.view.user.id } });
    expect((await inject('GET', `/tickets/${ticket.id}`, secondAgent)).statusCode).toBe(404);
    expect((await inject('GET', `/tickets?search=Sensitive`, secondAgent)).json().tickets).toEqual([]);
    const outsideGroup = await inject('GET', `/tickets/${incident.id}`, secondAgent);
    expect(outsideGroup.statusCode).toBe(200);
    expect(outsideGroup.body).not.toContain('PRIVATE diagnostic');
    expect((await inject('GET', `/tickets/${ticket.id}`, employee)).statusCode).toBe(200);
  });
  it('allocates 50 unique consecutive numbers concurrently without repeating outbox actions', async () => {
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => inject('POST', '/tickets', employee, { categoryId, summary: `Concurrent incident ${i}`, description: 'A unique parallel incident to verify tenant counter allocation.' }, { 'idempotency-key': randomUUID() })));
    for (const response of responses) expect(response.statusCode, response.body).toBe(201);
    const tickets = responses.map(r => r.json<TicketDetail>());
    expect(new Set(tickets.map(t => t.number)).size).toBe(50);
    expect(await owner.outbox.count({ where: { ticketId: { in: tickets.map(t => t.id) } } })).toBe(50);
  }, 30000);
  it('enforces RLS without context, rejects cross-tenant writes/FKs and resets context on connection reuse', async () => {
    expect(await runtime.ticket.findMany()).toEqual([]);
    expect(await runtime.tenant.findMany()).toEqual([]);
    expect(await scoped(tenantId, tx => tx.ticket.count())).toBeGreaterThan(0);
    expect(await runtime.ticket.findMany()).toEqual([]);
    expect(await scoped(tenant2Id, tx => tx.ticket.findMany())).toHaveLength(2);
    expect(await runtime.ticket.findMany()).toEqual([]);
    await expect(scoped(tenantId, tx => tx.ticket.update({ where: { id: incident.id }, data: { categoryId: otherCategoryId } }))).rejects.toThrow();
    await expect(scoped(tenant2Id, tx => tx.counter.create({ data: { tenantId, type: 'forbidden' } }))).rejects.toThrow();
    const activity = await owner.activity.findFirstOrThrow({ where: { tenantId } });
    await expect(scoped(tenantId, tx => tx.activity.update({ where: { id: activity.id }, data: { body: 'forbidden alteration' } }))).rejects.toThrow();
    const [role] = await runtime.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it('rolls back number, incident, audit and outbox together', async () => {
    const before = await owner.counter.findUniqueOrThrow({ where: { tenantId_type: { tenantId, type: 'incident' } } });
    const id = randomUUID();
    await expect(scoped(tenantId, async tx => {
      const counter = await tx.counter.update({ where: { tenantId_type: { tenantId, type: 'incident' } }, data: { sequence: { increment: 1 } } });
      const category = await tx.category.findUniqueOrThrow({ where: { id: categoryId } });
      await tx.ticket.create({ data: { id, tenantId, sequence: counter.sequence, number: `INC${String(counter.sequence).padStart(4, '0')}`, summary: 'Rolled back incident', description: 'This incident must never be committed.', priority: 'P3', severity: 'S3', categoryId, departmentId: category.departmentId, callerId: employee.view.user.id } });
      await tx.audit.create({ data: { tenantId, ticketId: id, actorId: employee.view.user.id, action: 'test.rollback', detail: {} } });
      await tx.outbox.create({ data: { tenantId, ticketId: id, event: 'test.rollback', payload: {} } });
      throw new Error('deliberate rollback');
    })).rejects.toThrow('deliberate rollback');
    expect(await owner.ticket.count({ where: { id } })).toBe(0);
    expect(await owner.audit.count({ where: { ticketId: id } })).toBe(0);
    expect(await owner.outbox.count({ where: { ticketId: id } })).toBe(0);
    expect((await owner.counter.findUniqueOrThrow({ where: { tenantId_type: { tenantId, type: 'incident' } } })).sequence).toBe(before.sequence);
  });
  it('does not throttle successful sign-ins and revokes logout sessions with CSRF', async () => {
    for (let i = 0; i < 31; i++) await login(employee.view.tenant.slug, employee.view.user.email);
    const response = await inject('POST', '/auth/logout', employee);
    expect(response.statusCode).toBe(201);
    expect((await inject('GET', '/auth/session', employee)).statusCode).toBe(401);
    expect((await inject('GET', '/auth/session', agent)).statusCode).toBe(200);
  }, 30000);
  it('bounds concurrent failed sign-ins before asynchronous password work', async () => {
    const payload = { organisation: `absent-${randomUUID()}`, email: 'absent@test.invalid', password: 'wrong-password' };
    const responses = await Promise.all(Array.from({ length: 6 }, () => inject('POST', '/auth/login', undefined, payload)));
    expect(responses.filter(r => r.statusCode === 429)).toHaveLength(1);
    expect(responses.filter(r => r.statusCode === 401)).toHaveLength(5);
  });
  it('expires idle/absolute sessions and revokes deactivated users and tenants', async () => {
    await owner.session.updateMany({ where: { userId: secondAgent.view.user.id }, data: { lastSeenAt: new Date(Date.now() - 31 * 60000) } });
    expect((await inject('GET', '/auth/session', secondAgent)).statusCode).toBe(401);
    await owner.session.updateMany({ where: { userId: colleague.view.user.id }, data: { lastSeenAt: new Date(Date.now() - 9 * 3600000) } });
    expect((await inject('GET', '/auth/session', colleague)).statusCode).toBe(401);
    await owner.session.updateMany({ where: { userId: otherTenant.view.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await inject('GET', '/auth/session', otherTenant)).statusCode).toBe(401);
    await owner.user.update({ where: { id: agent.view.user.id }, data: { active: false } });
    expect((await inject('GET', '/auth/session', agent)).statusCode).toBe(401);
    await owner.tenant.update({ where: { id: tenantId }, data: { active: false } });
    expect((await inject('POST', '/auth/login', undefined, { organisation: employee.view.tenant.slug, email: employee.view.user.email, password })).statusCode).toBe(401);
  });
});
