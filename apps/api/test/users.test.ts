import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hash, verify } from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AuthContext } from '../src/auth.js';
import type { Database } from '../src/database.js';
import type { UsersService } from '../src/users.js';
import type { CreateUserInput, UserInvitation, UserProfile } from '@astrama/contracts';

describe.skipIf(!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)('organisation users — real PostgreSQL runtime RLS', () => {
  let owner: PrismaClient, db: Database, service: UsersService;
  let admin: AuthContext, employee: AuthContext, foreign: AuthContext, agent: AuthContext;
  let groupId: string, categoryId: string;
  const tenantIds: string[] = [];
  const password = 'User-test-password-2026!';
  const input = (email: string, extra: Partial<CreateUserInput> = {}): CreateUserInput => ({ name: 'New colleague', email, role: 'employee', approverEligible: false, isVp: false, managerId: null, homeDepartment: 'Finance', phone: '', jobTitle: 'Analyst', ...extra });
  const update = (user: UserProfile, extra: Record<string, unknown> = {}) => ({ name: user.name, email: user.email, role: user.role, approverEligible: user.approverEligible, isVp: user.isVp, managerId: user.managerId, homeDepartment: user.homeDepartment, phone: user.phone, jobTitle: user.jobTitle, revision: user.revision, active: user.active, ...extra });
  const token = (invite: UserInvitation) => new URLSearchParams(new URL(invite.invitation.url).hash.slice('#activate?'.length)).get('token')!;
  beforeAll(async () => {
    process.env.APP_ORIGIN = 'http://localhost:4310'; process.env.MFA_ENCRYPTION_KEY ??= 'cd'.repeat(32);
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    const { Database } = await import('../dist/database.js');
    const { UsersService } = await import('../dist/users.js');
    const { TicketsService } = await import('../dist/tickets.js');
    const { tokenHash } = await import('../dist/auth.js');
    db = new Database(); service = new UsersService(db, new TicketsService(db));
    const passwordHash = await hash(password);
    for (let i = 0; i < 2; i++) {
      const tenant = await owner.tenant.create({ data: { slug: `users-${randomUUID()}`, name: 'Users test', brandName: 'Test desk' } }); tenantIds.push(tenant.id);
      for (const role of (i ? ['admin'] : ['admin', 'employee', 'agent']) as ('admin' | 'employee' | 'agent')[]) {
        const user = await owner.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}@test.invalid`, passwordHash, role, mfaEnrolled: role === 'admin', mfaSecret: role === 'admin' ? 'fixture-secret-not-used' : null } });
        const session = await owner.session.create({ data: { tenantId: tenant.id, userId: user.id, tokenHash: tokenHash(randomBytes(32).toString('hex')), csrfToken: randomUUID(), mfaVerified: role === 'admin', expiresAt: new Date(Date.now() + 3600000) } });
        const auth: AuthContext = { id: user.id, tenantId: tenant.id, role, departmentIds: [], sessionId: session.id, view: { user: { id: user.id, name: role, email: user.email, role, departmentIds: [] }, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, brandName: tenant.brandName }, csrfToken: session.csrfToken, mfaVerified: role === 'admin' } };
        if (i) foreign = auth; else if (role === 'admin') admin = auth; else if (role === 'employee') employee = auth; else agent = auth;
      }
    }
    const group = await owner.department.create({ data: { tenantId: admin.tenantId, name: 'Triage', isTriage: true } }); groupId = group.id;
    await owner.membership.create({ data: { tenantId: admin.tenantId, userId: agent.id, departmentId: group.id } });
    const category = await owner.category.create({ data: { tenantId: admin.tenantId, name: 'General', departmentId: group.id } }); categoryId = category.id;
  }, 60000);
  afterAll(async () => {
    await db?.$disconnect();
    if (!owner) return;
    for (const id of tenantIds) {
      await owner.user.updateMany({ where: { tenantId: id }, data: { managerId: null } });
      for (const table of ['invitation_mails', 'notification_deliveries', 'attachments', 'approval_delegations', 'approvals', 'idempotency', 'outbox', 'audits', 'config_audits', 'activities', 'tickets', 'catalog_items', 'sessions', 'memberships', 'subcategories', 'categories', 'counters', 'departments', 'users', 'tenants']) await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${table === 'tenants' ? 'id' : 'tenant_id'}"=$1::uuid`, id);
    }
    await owner.$disconnect();
  });
  it('requires MFA admin, denies foreign updates and self access changes, and validates tenant manager references', async () => {
    await expect(service.list(employee)).rejects.toThrow('administrator');
    await expect(service.list({ ...admin, view: { ...admin.view, mfaVerified: false } })).rejects.toThrow('administrator');
    const invite = await service.create(admin, input('created@test.invalid'));
    await expect(service.update(foreign, invite.user.id, update(invite.user))).rejects.toThrow('User not found');
    await expect(service.create(admin, input('manager@test.invalid', { managerId: foreign.id }))).rejects.toThrow('Manager');
    const own = await service.profile(admin);
    await expect(service.update(admin, own.id, update(own, { role: 'employee' }))).rejects.toThrow('Another administrator');
    await expect(service.update(admin, own.id, update(own, { revision: 99 }))).rejects.toThrow('User changed');
    await expect(service.update(admin, invite.user.id, update(invite.user, { active: true }))).rejects.toThrow('Reinvite');
    await expect(owner.user.update({ where: { id: invite.user.id }, data: { managerId: foreign.id } })).rejects.toThrow();
  });
  it('activates only exact-tenant unexpired single-use tokens, supersedes old links, hashes passwords and preserves MFA', async () => {
    const invite = await service.create(admin, input('activate@test.invalid', { role: 'admin' }));
    expect(JSON.stringify(invite)).not.toMatch(/passwordHash|invitationHash|mfaSecret/);
    const raw = token(invite), row = await owner.user.findUniqueOrThrow({ where: { id: invite.user.id } });
    expect(row.invitationHash).not.toBe(raw); expect(row.active).toBe(false);
    await expect(service.activate({ organisation: foreign.view.tenant.slug, token: raw, password })).rejects.toThrow('invalid or expired');
    await owner.user.update({ where: { id: row.id }, data: { invitationExpiresAt: new Date(Date.now() - 1000) } });
    await expect(service.activate({ organisation: admin.view.tenant.slug, token: raw, password })).rejects.toThrow('invalid or expired');
    const replacement = await service.reinvite(admin, row.id, { revision: row.revision });
    await expect(service.activate({ organisation: admin.view.tenant.slug, token: raw, password })).rejects.toThrow('invalid or expired');
    await owner.user.update({ where: { id: row.id }, data: { mfaEnrolled: true, mfaSecret: 'retained-fixture' } });
    const payload = { organisation: admin.view.tenant.slug, token: token(replacement), password };
    const results = await Promise.allSettled([service.activate(payload), service.activate(payload)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const activated = await owner.user.findUniqueOrThrow({ where: { id: row.id } });
    expect(activated.active).toBe(true); expect(activated.invitationHash).toBeNull(); expect(await verify(activated.passwordHash, password)).toBe(true);
    expect(activated.mfaEnrolled).toBe(true); expect(activated.mfaSecret).toBe('retained-fixture');
    await expect(service.activate(payload)).rejects.toThrow('invalid or expired');
  });
  it('protects triage and unresolved assignments, revokes sessions on deactivation, and filters profile history', async () => {
    const profile = await service.profile(admin, agent.id);
    await expect(service.update(admin, agent.id, update(profile, { active: false }))).rejects.toThrow('Triage');
    const spare = await owner.user.create({ data: { tenantId: admin.tenantId, name: 'Spare', email: 'spare@test.invalid', role: 'agent', passwordHash: '!' } });
    await owner.membership.create({ data: { tenantId: admin.tenantId, userId: spare.id, departmentId: groupId } });
    const ticket = await owner.ticket.create({ data: { tenantId: admin.tenantId, type: 'incident', sequence: 1, number: 'INC0001', summary: 'Private profile ticket', description: 'Private', callerId: employee.id, departmentId: groupId, categoryId, priority: 'P3', severity: 'S3', assignedToId: agent.id, sensitive: true } });
    expect((await service.profile(admin, employee.id)).tickets).toHaveLength(0);
    expect((await service.profile(employee)).tickets.map(t => t.id)).toContain(ticket.id);
    await expect(service.profile(employee, agent.id)).rejects.toThrow('User not found');
    await expect(service.update(admin, agent.id, update(profile, { active: false }))).rejects.toThrow('unresolved');
    await owner.ticket.update({ where: { id: ticket.id }, data: { state: 'Complete' } });
    await service.update(admin, agent.id, update(profile, { active: false }));
    expect(await owner.session.count({ where: { userId: agent.id } })).toBe(0);
    expect(await owner.membership.count({ where: { userId: agent.id } })).toBe(0);
    await expect(service.profile(agent)).rejects.toThrow('Session expired');
  });
  it.skipIf(!process.env.SMTP_HOST || !process.env.MAILPIT_URL)('durably sends encrypted invitation mail through SMTP and clears superseded secrets', async () => {
    const email = `invitation-${randomUUID()}@test.invalid`, invite = await service.create(admin, input(email));
    const first = await owner.invitationMail.findFirstOrThrow({ where: { tenantId: admin.tenantId, userId: invite.user.id } });
    expect(first.status).toBe('pending'); expect(first.encryptedUrl?.includes(token(invite))).toBe(false);
    const replacement = await service.reinvite(admin, invite.user.id, { revision: invite.user.revision });
    const superseded = await owner.invitationMail.findUniqueOrThrow({ where: { id: first.id } });
    expect(superseded.status).toBe('skipped'); expect(superseded.encryptedUrl).toBeNull();
    const { InvitationMailer } = await import('../dist/invitation-mail.js');
    const smtpPort = process.env.SMTP_PORT;
    try { process.env.SMTP_PORT = '65534'; await new InvitationMailer(db).dispatch(); }
    finally { if (smtpPort === undefined) delete process.env.SMTP_PORT; else process.env.SMTP_PORT = smtpPort; }
    const retry = await owner.invitationMail.findFirstOrThrow({ where: { tenantId: admin.tenantId, userId: invite.user.id, status: 'pending' } });
    expect(retry.attempts).toBe(1); expect(retry.encryptedUrl).not.toBeNull(); expect(retry.lastError).toBe('Invitation delivery failed');
    await owner.invitationMail.update({ where: { id: retry.id }, data: { nextAttemptAt: new Date(0) } });
    // A fresh instance represents a restarted worker; the pending message comes from PostgreSQL.
    await new InvitationMailer(db).dispatch();
    const sent = await owner.invitationMail.findFirstOrThrow({ where: { tenantId: admin.tenantId, userId: invite.user.id, status: 'sent' } });
    expect(sent.encryptedUrl).toBeNull(); expect(sent.sentAt).not.toBeNull(); expect(sent.attempts).toBe(2);
    const mailbox = await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`).then(response => response.json()) as { messages: { ID: string }[] };
    expect(mailbox.messages).toHaveLength(1);
    const message = await fetch(`${process.env.MAILPIT_URL}/api/v1/message/${mailbox.messages[0]!.ID}`).then(response => response.json()) as { Text: string };
    expect(message.Text.includes(token(replacement))).toBe(true); expect(message.Text.includes(token(invite))).toBe(false);
    await new InvitationMailer(db).dispatch();
    expect((await owner.invitationMail.findUniqueOrThrow({ where: { id: sent.id } })).attempts).toBe(2);
    await expect(db.invitationMail.findMany()).resolves.toEqual([]);
  });
  it('invalidates previous approvals when a manager changes and grants only the new manager access', async () => {
    const managers = await Promise.all(['old', 'new'].map(name => owner.user.create({ data: { tenantId: admin.tenantId, name: `${name} manager`, email: `${name}-manager@test.invalid`, role: 'employee', approverEligible: true, passwordHash: '!' } })));
    await owner.user.update({ where: { id: employee.id }, data: { managerId: managers[0]!.id } });
    const item = await owner.catalogItem.create({ data: { tenantId: admin.tenantId, categoryId, name: 'Managed item', currency: 'AUD', unitCostMinor: 1000, requiresManager: true } });
    const request = await owner.ticket.create({ data: { tenantId: admin.tenantId, type: 'request', sequence: 1, number: 'SR0001', summary: 'Manager private request', description: 'Private request', callerId: employee.id, requestedForId: employee.id, itemId: item.id, quantity: 1, unitCostMinor: 1000, totalCostMinor: 1000, currency: 'AUD', departmentId: groupId, categoryId, priority: 'P4', severity: 'S3', state: 'Open', approvalVersion: 1, sensitive: true } });
    await owner.approval.create({ data: { tenantId: admin.tenantId, ticketId: request.id, version: 1, stage: 'manager', approverId: managers[0]!.id, decidedById: managers[0]!.id, decidedAt: new Date(), status: 'Approved' } });
    const profile = await service.profile(admin, employee.id);
    await service.update(admin, employee.id, update(profile, { managerId: managers[1]!.id }));
    const changed = await owner.ticket.findUniqueOrThrow({ where: { id: request.id } });
    expect(changed.state).toBe('Pending Approval'); expect(changed.approvalVersion).toBe(2); expect(changed.revision).toBe(1);
    const approvals = await owner.approval.findMany({ where: { ticketId: request.id }, orderBy: { version: 'asc' } });
    expect(approvals.map(row => row.status)).toEqual(['Invalidated', 'Pending']); expect(approvals[1]!.approverId).toBe(managers[1]!.id);
    const { TicketsService } = await import('../dist/tickets.js'); const tickets = new TicketsService(db);
    await expect(tickets.get({ tenantId: admin.tenantId, id: managers[0]!.id, role: 'employee', departmentIds: [] }, request.id)).rejects.toThrow('Ticket not found');
    expect((await tickets.get({ tenantId: admin.tenantId, id: managers[1]!.id, role: 'employee', departmentIds: [] }, request.id)).id).toBe(request.id);
  });
  it('tolerates a removed invitation during SMTP failure and skips an unavailable tenant', async () => {
    const invite = await service.create(admin, input('removed-during-smtp@test.invalid'));
    const row = await owner.invitationMail.findFirstOrThrow({ where: { tenantId: admin.tenantId, userId: invite.user.id } });
    let deletion: Promise<unknown> | undefined;
    const server = createServer(socket => {
      // Hold the SMTP greeting until the actual outbox row is removed by an operator/fixture cleanup.
      deletion = owner.invitationMail.delete({ where: { id: row.id } }).finally(() => socket.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test SMTP address');
    const saved = { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, from: process.env.SMTP_FROM };
    try {
      process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = String(address.port); process.env.SMTP_FROM = 'service-desk@test.invalid';
      const { InvitationMailer } = await import('../dist/invitation-mail.js'); const mailer = new InvitationMailer(db);
      await mailer.deliver(admin.tenantId, row.id); await deletion;
      expect(await owner.invitationMail.count({ where: { id: row.id } })).toBe(0);
      await expect(mailer.deliver(randomUUID(), randomUUID())).resolves.toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries({ SMTP_HOST: saved.host, SMTP_PORT: saved.port, SMTP_FROM: saved.from })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it('validates CSV previews, commits 100 accounts atomically once, and binds confirmation to tenant and session', async () => {
    const invalid = await service.preview(admin, { csv: 'name,email\r\nAlice,duplicate@test.invalid\r\nBob,duplicate@test.invalid' });
    expect(invalid.valid).toBe(false); expect(invalid.previewToken).toBeNull();
    const csv = 'name,email,role,approverEligible\r\n' + Array.from({ length: 100 }, (_, i) => `"Person, ${i}",bulk${i}@test.invalid,employee,false`).join('\r\n');
    const preview = await service.preview(admin, { csv });
    expect(preview.valid).toBe(true); expect(preview.rows).toHaveLength(100);
    expect(await owner.user.count({ where: { tenantId: admin.tenantId, email: { startsWith: 'bulk' } } })).toBe(0);
    await expect(service.commit(foreign, { previewToken: preview.previewToken })).rejects.toThrow('preview expired');
    // A different API instance must be able to commit a persisted preview exactly once.
    const { UsersService: OtherUsersService } = await import('../dist/users.js');
    const { TicketsService: OtherTicketsService } = await import('../dist/tickets.js');
    const result = await new OtherUsersService(db, new OtherTicketsService(db)).commit(admin, { previewToken: preview.previewToken });
    expect(result.users).toHaveLength(100);
    expect(await owner.user.count({ where: { tenantId: admin.tenantId, email: { startsWith: 'bulk' }, active: false } })).toBe(100);
    await expect(service.commit(admin, { previewToken: preview.previewToken })).rejects.toThrow('preview expired');
    const duplicate = await service.preview(admin, { csv: 'name,email\nFirst,rollback@test.invalid\nSecond,rollback2@test.invalid' });
    await owner.user.create({ data: { tenantId: admin.tenantId, name: 'Racing import', email: 'rollback2@test.invalid', role: 'employee', passwordHash: '!' } });
    await expect(service.commit(admin, { previewToken: duplicate.previewToken })).rejects.toThrow('Email');
    expect(await owner.user.count({ where: { tenantId: admin.tenantId, email: 'rollback@test.invalid' } })).toBe(0);
    expect(() => service.preview(admin, { csv: 'name,email\n' + Array.from({ length: 101 }, (_, i) => `Person,too${i}@test.invalid`).join('\n') })).toThrow('100');
  }, 30000);
  it('validates queue owners, preserves category restrictions, and rejects stale administrator sessions', async () => {
    const { AdminService } = await import('../dist/admin.js'); const config = new AdminService(db);
    const user = await owner.user.create({ data: { tenantId: admin.tenantId, name: 'Queue owner', email: 'queue-owner@test.invalid', role: 'agent', passwordHash: '!' } });
    await expect(config.group(admin, { name: 'Invalid owner', memberIds: [user.id], queueOwnerId: foreign.id })).rejects.toThrow('selected active group members');
    let group = await config.group(admin, { name: 'Owned group', memberIds: [user.id], queueOwnerId: user.id });
    expect(group.queueOwnerId).toBe(user.id);
    group = await config.group(admin, { name: group.name, memberIds: [user.id], revision: group.revision, active: true }, group.id);
    expect(group.queueOwnerId).toBe(user.id);
    const profile = await service.profile(admin, user.id);
    await expect(service.update(admin, user.id, update(profile, { active: false }))).rejects.toThrow('queue owner');
    await expect(config.group(admin, { name: group.name, memberIds: [], revision: group.revision, active: true }, group.id)).rejects.toThrow('Clear or replace');
    group = await config.group(admin, { name: group.name, memberIds: [], queueOwnerId: null, revision: group.revision, active: true }, group.id);
    expect(group.queueOwnerId).toBeNull();
    const category = await config.category(admin, { name: 'Request only', departmentId: groupId, sensitive: false, allowIncidents: false, allowRequests: true });
    const preserved = await config.category(admin, { name: category.name, departmentId: groupId, sensitive: false, active: true, revision: category.revision }, category.id);
    expect(preserved.allowIncidents).toBe(false);
    const staleSession = await owner.session.create({ data: { tenantId: admin.tenantId, userId: admin.id, tokenHash: randomUUID(), csrfToken: randomUUID(), mfaVerified: true, expiresAt: new Date(Date.now() + 3600000) } });
    const stale = { ...admin, sessionId: staleSession.id };
    await owner.session.delete({ where: { id: staleSession.id } });
    await expect(config.group(stale, { name: 'Revoked admin write', memberIds: [] })).rejects.toThrow('administrator');
    expect(await owner.department.count({ where: { tenantId: admin.tenantId, name: 'Revoked admin write' } })).toBe(0);
  });
  it('audits settings with revision checks and changes passwords without resetting enrolled MFA', async () => {
    const settings = await service.settings(admin);
    const { id: _id, ...body } = settings;
    const changed = await service.updateSettings(admin, { ...body, brandName: 'New desk', timezone: 'Australia/Sydney', primaryColour: '#334455' });
    expect(changed.revision).toBe(settings.revision + 1);
    await expect(service.updateSettings(admin, body)).rejects.toThrow('Settings changed');
    expect(() => service.updateSettings(admin, { ...body, timezone: 'Invalid/Zone' })).toThrow('timezone');
    await expect(service.changePassword(admin, { currentPassword: 'incorrect', newPassword: 'Changed-password-2026!' })).rejects.toThrow('incorrect');
    await service.changePassword(admin, { currentPassword: password, newPassword: 'Changed-password-2026!' });
    const user = await owner.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(await verify(user.passwordHash, 'Changed-password-2026!')).toBe(true); expect(user.mfaEnrolled).toBe(true);
    expect(await owner.session.count({ where: { tenantId: admin.tenantId, userId: admin.id } })).toBe(0);
    const audits = await owner.configAudit.findMany({ where: { tenantId: admin.tenantId } });
    expect(audits.some(event => event.action === 'organisation.updated')).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('Changed-password-2026!');
    expect(JSON.stringify(audits)).not.toContain('token=');
  });
});
