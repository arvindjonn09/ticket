import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/database.js';
import { TicketsService } from '../src/tickets.js';
import { RequestsService } from '../src/requests.js';
import { AutomationService } from '../src/automation.js';
import type { AuthContext } from '../src/auth.js';

describe.skipIf(!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)('business automation — real PostgreSQL runtime', () => {
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const db = new Database(), tickets = new TicketsService(db), requests = new RequestsService(tickets), automation = new AutomationService(db, tickets);
  const now = new Date('2026-11-11T01:00:00Z'), old = new Date('2026-10-26T00:00:00Z');
  let tenantId: string, foreignTenantId: string, departmentId: string, categoryId: string, itemId: string, admin: AuthContext, employee: AuthContext, recipient: AuthContext, manager: AuthContext;
  const auth = (user: { id: string; name: string; email: string; role: string }): AuthContext => ({ id: user.id, tenantId, role: user.role as AuthContext['role'], departmentIds: [], sessionId: randomUUID(), view: { user: { ...user, role: user.role as AuthContext['role'], departmentIds: [] }, tenant: { id: tenantId, slug: 'automation-test', name: 'Test', brandName: 'Test' }, csrfToken: 'test', mfaVerified: true } });
  const configure = async (enabled = true) => {
    const { timezone: _timezone, responsibleAdminId: _responsible, ...settings } = await automation.get(admin); void _timezone; void _responsible;
    return automation.save(admin, { ...settings, enabled });
  };
  const pending = async () => {
    const ticket = await requests.create(employee, { itemId, requestedForId: recipient.id, quantity: 1, summary: 'Automation waiting request', description: 'A request to verify business calendar timers' }, randomUUID());
    await owner.audit.updateMany({ where: { ticketId: ticket.id, action: 'request.approvals_evaluated' }, data: { createdAt: old } });
    return ticket;
  };
  const events = (ticketId: string) => owner.outbox.findMany({ where: { ticketId, event: { startsWith: 'automation.' } } });
  beforeAll(async () => {
    await db.assertRuntimeRole();
    tenantId = (await owner.tenant.create({ data: { slug: `automation-${randomUUID()}`, name: 'Automation test', brandName: 'Test' } })).id;
    foreignTenantId = (await owner.tenant.create({ data: { slug: `automation-foreign-${randomUUID()}`, name: 'Foreign', brandName: 'Test' } })).id;
    const people: AuthContext[] = [];
    for (const [name, role, eligible] of [['Admin', 'admin', false], ['Employee', 'employee', false], ['Recipient', 'employee', false], ['Manager', 'employee', true]] as const) {
      const person = auth(await owner.user.create({ data: { tenantId, name, email: `${name}@test.invalid`, role, passwordHash: 'disabled', approverEligible: eligible, mfaEnrolled: role === 'admin', mfaSecret: role === 'admin' ? 'test-secret' : null } }));
      await owner.session.create({ data: { id: person.sessionId, tenantId, userId: person.id, tokenHash: randomUUID(), csrfToken: 'test', mfaVerified: role === 'admin', expiresAt: new Date(Date.now() + 3600000) } });
      people.push(person);
    }
    [admin, employee, recipient, manager] = people;
    await owner.user.update({ where: { id: recipient.id }, data: { managerId: manager.id } });
    departmentId = (await owner.department.create({ data: { tenantId, name: 'Triage', isTriage: true } })).id;
    const agent = await owner.user.create({ data: { tenantId, name: 'Agent', email: 'agent@test.invalid', role: 'agent', passwordHash: 'disabled' } });
    await owner.membership.create({ data: { tenantId, userId: agent.id, departmentId } });
    categoryId = (await owner.category.create({ data: { tenantId, name: 'Software', departmentId } })).id;
    itemId = (await owner.catalogItem.create({ data: { tenantId, categoryId, name: 'Manager approval', currency: 'AUD', requiresManager: true } })).id;
  });
  afterAll(async () => {
    await db.$disconnect();
    if (tenantId) {
      await owner.user.updateMany({ where: { tenantId }, data: { managerId: null } });
      for (const table of ['automation_actions', 'automation_settings', 'notification_deliveries', 'attachments', 'approval_delegations', 'approvals', 'idempotency', 'outbox', 'audits', 'config_audits', 'activities', 'tickets', 'catalog_items', 'sessions', 'memberships', 'subcategories', 'categories', 'counters', 'departments', 'users', 'tenants']) await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${table === 'tenants' ? 'id' : 'tenant_id'}"=$1::uuid`, tenantId);
    }
    if (foreignTenantId) await owner.tenant.delete({ where: { id: foreignTenantId } });
    await owner.$disconnect();
  });
  it('defaults off, requires current MFA admin, validates calendars and detects revisions', async () => {
    expect(await automation.get(admin)).toMatchObject({ enabled: false, reminderDays: 2, escalationDays: 5, autoCloseDays: 5, responsibleAdminId: null });
    const ticket = await pending(); await automation.tick(tenantId, ticket.id, now); expect(await events(ticket.id)).toHaveLength(0);
    await expect(automation.get(employee)).rejects.toThrow('MFA');
    await expect(automation.get({ ...admin, view: { ...admin.view, mfaVerified: false } })).rejects.toThrow('MFA');
    const settings = await configure();
    const { timezone: _timezone, responsibleAdminId: _responsible, ...input } = settings; void _timezone; void _responsible;
    expect(() => automation.save(admin, { ...input, holidays: ['2026-02-30'] })).toThrow();
    expect(() => automation.save(admin, { ...input, workingWeekdays: [] })).toThrow();
    await expect(automation.save(admin, { ...input, revision: 0 })).rejects.toThrow('changed');
    await owner.session.update({ where: { id: admin.sessionId }, data: { mfaVerified: false } });
    await expect(automation.get(admin)).rejects.toThrow('MFA');
    await owner.session.update({ where: { id: admin.sessionId }, data: { mfaVerified: true } });
  });
  it('records reminder and escalation once under concurrency, keeps RLS and composite tenant constraints', async () => {
    const ticket = await pending();
    await Promise.all(Array.from({ length: 5 }, () => automation.tick(tenantId, ticket.id, now)));
    expect((await events(ticket.id)).map(e => e.event).sort()).toEqual(['automation.approval_escalation', 'automation.approval_reminder']);
    expect(await owner.audit.count({ where: { ticketId: ticket.id, action: { startsWith: 'automation.' }, actorId: admin.id } })).toBe(2);
    expect(await db.$queryRaw`SELECT * FROM automation_settings`).toEqual([]);
    expect(await db.withTenant(foreignTenantId, tx => tx.$queryRaw`SELECT * FROM automation_settings`)).toEqual([]);
    await expect(owner.$executeRaw`INSERT INTO automation_actions(tenant_id,ticket_id,approval_version,stage,kind) VALUES(${foreignTenantId}::uuid,${ticket.id}::uuid,1,'manager','approval_reminder')`).rejects.toThrow();
  });
  it('rechecks approval authority and version, ignores terminal/held tickets and inactive responsibility', async () => {
    const ticket = await pending();
    await owner.user.update({ where: { id: manager.id }, data: { approverEligible: false } });
    await automation.tick(tenantId, ticket.id, now); expect(await events(ticket.id)).toHaveLength(0);
    await owner.user.update({ where: { id: manager.id }, data: { approverEligible: true } });
    await owner.user.update({ where: { id: recipient.id }, data: { managerId: employee.id } }); // self-approval drift
    await automation.tick(tenantId, ticket.id, now); expect(await events(ticket.id)).toHaveLength(0);
    await owner.user.update({ where: { id: recipient.id }, data: { managerId: manager.id } });
    await owner.ticket.update({ where: { id: ticket.id }, data: { approvalVersion: ticket.approvalVersion + 1 } });
    await automation.tick(tenantId, ticket.id, now); expect(await events(ticket.id)).toHaveLength(0);
    await owner.ticket.update({ where: { id: ticket.id }, data: { approvalVersion: ticket.approvalVersion } });
    for (const state of ['On Hold', 'Cancelled', 'Rejected', 'Complete']) {
      await owner.ticket.update({ where: { id: ticket.id }, data: { state } });
      await automation.tick(tenantId, ticket.id, now); expect(await events(ticket.id)).toHaveLength(0);
    }
    await owner.ticket.update({ where: { id: ticket.id }, data: { state: 'Pending Approval' } });
    await owner.user.update({ where: { id: admin.id }, data: { active: false } });
    await automation.tick(tenantId, ticket.id, now); expect(await events(ticket.id)).toHaveLength(0);
    await owner.user.update({ where: { id: admin.id }, data: { active: true } });
    await configure(false); await automation.tick(tenantId, ticket.id, now); expect(await events(ticket.id)).toHaveLength(0); await configure();
  });
  it('starts VP timing only after manager decision and uses current stage identity', async () => {
    const vp = await owner.user.create({ data: { tenantId, name: 'VP', email: 'vp@test.invalid', role: 'employee', passwordHash: 'disabled', approverEligible: true, isVp: true } });
    await owner.catalogItem.update({ where: { id: itemId }, data: { requiresVp: true, vpApproverId: vp.id } });
    const ticket = await pending();
    await owner.approval.updateMany({ where: { ticketId: ticket.id, stage: 'manager' }, data: { status: 'Approved', decidedAt: now, decidedById: manager.id } });
    await automation.tick(tenantId, ticket.id, now); expect(await events(ticket.id)).toHaveLength(0);
    await owner.approval.updateMany({ where: { ticketId: ticket.id, stage: 'manager' }, data: { decidedAt: old } });
    await automation.tick(tenantId, ticket.id, now);
    expect((await events(ticket.id)).every(event => (event.payload as { stage: string }).stage === 'vp')).toBe(true);
    expect(await events(ticket.id)).toHaveLength(2);
    await owner.catalogItem.update({ where: { id: itemId }, data: { requiresVp: false, vpApproverId: null } });
  });
  it('closes once from the latest resolution transition despite unrelated edits and resets after reopening', async () => {
    const ticket = await tickets.create(employee, { categoryId, summary: 'A resolved incident timer', description: 'An incident whose resolved timestamp is audited' }, randomUUID());
    await owner.ticket.update({ where: { id: ticket.id }, data: { state: 'Resolved', updatedAt: old } });
    await automation.tick(tenantId, ticket.id, now); expect((await owner.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).state).toBe('Resolved');
    const resolution = await owner.audit.create({ data: { tenantId, ticketId: ticket.id, actorId: admin.id, action: 'incident.state', detail: { from: 'In Progress', to: 'Resolved' }, createdAt: old } });
    await owner.ticket.update({ where: { id: ticket.id }, data: { updatedAt: now } });
    const recent = await owner.audit.create({ data: { tenantId, ticketId: ticket.id, actorId: admin.id, action: 'incident.state', detail: { from: 'In Progress', to: 'Resolved' }, createdAt: now } });
    await automation.tick(tenantId, ticket.id, now); expect((await owner.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).state).toBe('Resolved');
    await owner.audit.update({ where: { id: recent.id }, data: { createdAt: new Date(old.getTime() + 1000) } });
    await Promise.all([automation.tick(tenantId, ticket.id, now), automation.tick(tenantId, ticket.id, now)]);
    expect((await owner.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).state).toBe('Complete');
    expect(await events(ticket.id)).toHaveLength(1); expect(resolution.id).toBeTruthy();
  });
});
