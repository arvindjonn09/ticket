import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import { argon2id, hash, verify } from 'argon2';
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { canConfigureOrganisation, canReadTicket, type Actor } from '@astrama/domain';
import { createUserSchema, invitationActivationSchema, organisationSettingsSchema, passwordChangeSchema, revisionSchema, updateUserSchema, userImportCommitSchema, userImportSchema, type CreateUserInput, type OrganisationSettings, type ProfileHistory, type UserImportPreview, type UserProfile } from '@astrama/contracts';
import { AuthService, SessionGuard, tokenHash, reserveAuthAttempt, type AuthContext, type AuthRequest } from './auth.js';
import { Database, lockConfiguration, type Tx } from './database.js';
import { encryptSecret } from './mfa.js';
import { TicketsService } from './tickets.js';

const userView = (user: User): UserProfile => ({ id: user.id, name: user.name, email: user.email, role: user.role as UserProfile['role'], approverEligible: user.approverEligible, isVp: user.isVp, managerId: user.managerId, homeDepartment: user.homeDepartment, phone: user.phone, jobTitle: user.jobTitle, active: user.active, revision: user.revision, createdAt: user.createdAt.toISOString(), updatedAt: user.updatedAt.toISOString(), invitedAt: user.invitedAt?.toISOString() ?? null, invitationPending: !!user.invitationHash && !!user.invitationExpiresAt && user.invitationExpiresAt > new Date() });
const settingsSelect = { id: true, name: true, brandName: true, timezone: true, locale: true, primaryColour: true, incidentPrefix: true, requestPrefix: true, defaultPriority: true, defaultSeverity: true, revision: true } as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Handles RFC 4180 quoting without another dependency; bounded at the request and row limits.
export function parseUserCsv(csv: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false;
  csv = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!;
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === '"' && !value && !closed) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r') {
      row.push(value); value = ''; closed = false;
      if (char !== ',') {
        if (char === '\r' && csv[i + 1] === '\n') i++;
        if (row.some(cell => cell.trim())) rows.push(row);
        row = [];
        if (rows.length > 101) throw new BadRequestException('Import supports at most 100 users');
      }
    } else {
      if (closed || char === '"') throw new BadRequestException('Invalid CSV quoting');
      value += char;
    }
  }
  if (quoted) throw new BadRequestException('Unclosed CSV quotation');
  row.push(value); if (row.some(cell => cell.trim())) rows.push(row);
  if (rows.length < 2 || rows.length > 101) throw new BadRequestException('Import requires 1–100 users and a header row');
  return rows;
}

@Injectable()
export class UsersService {
  private readonly activating = new Set<string>();
  constructor(private readonly db: Database, private readonly tickets: TicketsService) {}
  private async run<T>(auth: AuthContext, admin: boolean, work: (tx: Tx, user: User) => Promise<T>): Promise<T> {
    if (admin && !canConfigureOrganisation({ ...auth, mfaVerified: auth.view.mfaVerified })) throw new ForbiddenException('MFA-verified administrator required');
    return this.db.withTenant(auth.tenantId, async tx => {
      await lockConfiguration(tx, auth.tenantId);
      const user = await tx.user.findFirst({ where: { tenantId: auth.tenantId, id: auth.id, active: true } });
      const session = await tx.session.findFirst({ where: { id: auth.sessionId, tenantId: auth.tenantId, userId: auth.id, expiresAt: { gt: new Date() } } });
      if (!user || !session) throw new UnauthorizedException('Session expired. Sign in again.');
      if (admin && !canConfigureOrganisation({ ...auth, role: user.role as Actor['role'], mfaVerified: session.mfaVerified })) throw new ForbiddenException('MFA-verified administrator required');
      try { return await work(tx, user); }
      catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003'].includes(error.code)) throw new ConflictException('Email is already used or a related record changed. Refresh and try again.');
        throw error;
      }
    });
  }
  private async audit(tx: Tx, auth: { tenantId: string; id: string }, id: string, action: string, before: unknown, after: unknown) {
    await tx.configAudit.create({ data: { tenantId: auth.tenantId, actorId: auth.id, entityId: id, action, detail: { before, after } as Prisma.InputJsonObject } });
  }
  private async record(tx: Tx, tenantId: string, id: string) {
    const user = uuid.test(id) ? await tx.user.findFirst({ where: { tenantId, id } }) : null;
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
  private revision(revision: number, user: User) { if (revision !== user.revision) throw new ConflictException({ message: 'User changed. Refresh and try again.', current: userView(user) }); }
  private async manager(tx: Tx, tenantId: string, managerId: string | null, id?: string) {
    const seen = new Set(id ? [id] : []);
    while (managerId) {
      if (seen.has(managerId)) throw new BadRequestException('Manager relationships cannot form a cycle');
      seen.add(managerId);
      const manager = await tx.user.findFirst({ where: { tenantId, id: managerId, active: true } });
      if (!manager) throw new BadRequestException('Manager must be active in this organisation');
      managerId = manager.managerId;
    }
  }
  list(auth: AuthContext) { return this.run(auth, true, async tx => ({ users: (await tx.user.findMany({ where: { tenantId: auth.tenantId }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })).map(userView) })); }
  profile(auth: AuthContext, id = auth.id): Promise<ProfileHistory> {
    return this.run(auth, false, async (tx, current) => {
      if (id !== auth.id && !['agent', 'admin'].includes(current.role)) throw new NotFoundException('User not found');
      const user = await this.record(tx, auth.tenantId, id);
      const memberships = await tx.membership.findMany({ where: { tenantId: auth.tenantId, userId: current.id, department: { active: true } } });
      const actor: Actor = { ...auth, role: current.role as Actor['role'], departmentIds: memberships.map(m => m.departmentId) };
      const own = [{ callerId: actor.id }, { submittedById: actor.id }, { requestedForId: actor.id }];
      const visible: Prisma.TicketWhereInput = actor.role === 'agent' ? { OR: [...own, { sensitive: false }, { departmentId: { in: actor.departmentIds } }] } : { OR: own };
      const tickets = await tx.ticket.findMany({ where: { tenantId: auth.tenantId, AND: [{ OR: [{ callerId: id }, { submittedById: id }, { requestedForId: id }] }, visible] }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 201 });
      return { ...userView(user), tickets: tickets.slice(0, 200).filter(ticket => canReadTicket(actor, ticket)).map(ticket => ({ id: ticket.id, number: ticket.number, summary: ticket.summary, state: ticket.state, createdAt: ticket.createdAt.toISOString(), updatedAt: ticket.updatedAt.toISOString() })), limitReached: tickets.length > 200 };
    });
  }
  private async invite(tx: Tx, auth: AuthContext, user: User) {
    const token = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + 48 * 3600000);
    const updated = await tx.user.update({ where: { id: user.id }, data: { invitationHash: tokenHash(token), invitationExpiresAt: expiresAt, invitedAt: new Date(), updatedAt: new Date(), revision: { increment: 1 } } });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
    const url = `${process.env.APP_ORIGIN}/#activate?token=${encodeURIComponent(token)}&organisation=${encodeURIComponent(tenant.slug)}`;
    await tx.invitationMail.updateMany({ where: { tenantId: auth.tenantId, userId: user.id, status: 'pending' }, data: { status: 'skipped', encryptedUrl: null, lastError: 'Invitation superseded' } });
    await tx.invitationMail.create({ data: { tenantId: auth.tenantId, userId: user.id, invitationHash: tokenHash(token), encryptedUrl: encryptSecret(url, `invitation:${auth.tenantId}:${user.id}`) } });
    await this.audit(tx, auth, user.id, 'user.invited', null, { expiresAt: expiresAt.toISOString() });
    return { user: userView(updated), invitation: { url, expiresAt: expiresAt.toISOString() }, emailQueued: true };
  }
  private async add(tx: Tx, auth: AuthContext, input: CreateUserInput) {
    await this.manager(tx, auth.tenantId, input.managerId);
    const user = await tx.user.create({ data: { tenantId: auth.tenantId, ...input, active: false, passwordHash: '!' } });
    await this.audit(tx, auth, user.id, 'user.created', null, userView(user));
    return this.invite(tx, auth, user);
  }
  create(auth: AuthContext, body: unknown) { const input = createUserSchema.parse(body); return this.run(auth, true, tx => this.add(tx, auth, input)); }
  reinvite(auth: AuthContext, id: string, body: unknown) {
    const input = revisionSchema.parse(body);
    return this.run(auth, true, async tx => {
      const user = await this.record(tx, auth.tenantId, id); this.revision(input.revision, user);
      if (user.active) throw new ConflictException('Active users change their own passwords');
      return this.invite(tx, auth, user);
    });
  }
  update(auth: AuthContext, id: string, body: unknown) {
    const input = updateUserSchema.parse(body);
    return this.run(auth, true, async tx => {
      const before = await this.record(tx, auth.tenantId, id); this.revision(input.revision, before);
      if (id === auth.id && (input.role !== before.role || input.active !== before.active || input.approverEligible !== before.approverEligible || input.isVp !== before.isVp || input.email !== before.email)) throw new ConflictException('Another administrator must change your access or sign-in email');
      if (!before.active && input.active) throw new ConflictException('Reinvite this user to activate their account');
      await this.manager(tx, auth.tenantId, input.managerId, id);
      const removesAdmin = before.active && before.role === 'admin' && (!input.active || input.role !== 'admin');
      if (removesAdmin && !await tx.user.count({ where: { tenantId: auth.tenantId, id: { not: id }, active: true, role: 'admin' } })) throw new ConflictException('Keep at least one active administrator');
      if (before.active && (!input.active || (before.role === 'agent' && input.role !== 'agent'))) {
        if (await tx.ticket.count({ where: { tenantId: auth.tenantId, assignedToId: id, state: { notIn: ['Complete', 'Cancelled', 'Rejected'] } } })) throw new ConflictException('Reassign unresolved tickets first');
        if (await tx.department.count({ where: { tenantId: auth.tenantId, active: true, OR: [{ queueOwnerId: id }, { substituteId: id }] } })) throw new ConflictException('Replace queue owner or substitute first');
        const triage = await tx.membership.findMany({ where: { tenantId: auth.tenantId, userId: id, department: { active: true, isTriage: true } } });
        for (const membership of triage) if (!await tx.membership.count({ where: { tenantId: auth.tenantId, departmentId: membership.departmentId, userId: { not: id }, user: { active: true, role: 'agent' } } })) throw new ConflictException('Triage must retain an active agent');
      }
      if ((!input.active || !input.approverEligible || (before.isVp && !input.isVp)) && before.approverEligible) {
        if (await tx.approval.count({ where: { tenantId: auth.tenantId, approverId: id, status: 'Pending' } }) || await tx.approvalDelegation.count({ where: { tenantId: auth.tenantId, active: true, endsAt: { gt: new Date() }, OR: [{ approverId: id }, { delegateId: id }] } })) throw new ConflictException('Resolve pending approvals and revoke active delegations first');
      }
      if (before.active && !input.active && await tx.user.count({ where: { tenantId: auth.tenantId, managerId: id, active: true } })) throw new ConflictException('Assign a new manager to active direct reports first');
      const sensitive = input.role !== before.role || input.active !== before.active || input.email !== before.email || input.approverEligible !== before.approverEligible || input.isVp !== before.isVp;
      const { revision: _revision, ...data } = input;
      const user = await tx.user.update({ where: { id }, data: { ...data, revision: { increment: 1 }, updatedAt: new Date(), ...((before.active && !input.active) || input.email !== before.email ? { invitationHash: null, invitationExpiresAt: null } : {}) } });
      if ((before.active && !input.active) || input.email !== before.email) await tx.invitationMail.updateMany({ where: { tenantId: auth.tenantId, userId: id, status: 'pending' }, data: { status: 'skipped', encryptedUrl: null, lastError: 'Invitation revoked' } });
      if ((before.active && !input.active) || input.email !== before.email) await tx.$executeRaw`UPDATE password_recoveries SET used_at=COALESCE(used_at,now()),encrypted_url=NULL,status='skipped',last_error='Account access changed' WHERE tenant_id=${auth.tenantId}::uuid AND user_id=${id}::uuid`;
      if (sensitive) await tx.session.deleteMany({ where: { tenantId: auth.tenantId, userId: id } });
      if (input.role !== 'agent' || !input.active) await tx.membership.deleteMany({ where: { tenantId: auth.tenantId, userId: id } });
      if (input.managerId !== before.managerId) {
        const requests = await tx.ticket.findMany({ where: { tenantId: auth.tenantId, requestedForId: id, type: 'request', state: { notIn: ['Complete', 'Cancelled', 'Rejected'] } }, include: { item: true } });
        for (const request of requests) if (request.item) {
          await tx.ticket.update({ where: { id: request.id }, data: { revision: { increment: 1 }, updatedAt: new Date() } });
          await this.tickets.evaluateApprovals(tx, auth, request, request.item);
        }
      }
      await this.audit(tx, auth, id, 'user.updated', userView(before), userView(user));
      return userView(user);
    });
  }
  async activate(body: unknown) {
    const input = invitationActivationSchema.parse(body), invitationHash = tokenHash(input.token);
    if (this.activating.has(invitationHash) || this.activating.size >= 100) throw new ConflictException('Invitation activation is already in progress. Try again shortly.');
    this.activating.add(invitationHash);
    try {
      const [found] = await this.db.$queryRaw<{ id: string; tenant_id: string }[]>`SELECT * FROM auth_invitation_lookup(${invitationHash}, ${input.organisation.toLowerCase()})`;
      if (!found) throw new BadRequestException('Invitation is invalid or expired');
      const passwordHash = await hash(input.password, { type: argon2id });
      return await this.db.withTenant(found.tenant_id, async tx => {
        await lockConfiguration(tx, found.tenant_id);
        const changed = await tx.user.updateMany({ where: { tenantId: found.tenant_id, id: found.id, active: false, invitationHash, invitationExpiresAt: { gt: new Date() } }, data: { passwordHash, active: true, invitationHash: null, invitationExpiresAt: null, updatedAt: new Date(), revision: { increment: 1 } } });
        if (changed.count !== 1) throw new BadRequestException('Invitation is invalid or expired');
        await tx.session.deleteMany({ where: { tenantId: found.tenant_id, userId: found.id } });
        await tx.invitationMail.updateMany({ where: { tenantId: found.tenant_id, userId: found.id, status: 'pending' }, data: { status: 'skipped', encryptedUrl: null, lastError: 'Invitation already used' } });
        await this.audit(tx, { tenantId: found.tenant_id, id: found.id }, found.id, 'user.activated', null, { active: true });
        return { ok: true };
      });
    } finally { this.activating.delete(invitationHash); }
  }
  async changePassword(auth: AuthContext, body: unknown) {
    const input = passwordChangeSchema.parse(body), key = `password-change:${auth.tenantId}:${auth.id}`;
    await reserveAuthAttempt(this.db, key, 5);
    return this.run(auth, false, async (tx, user) => {
      if (!await verify(user.passwordHash, input.currentPassword)) throw new UnauthorizedException('Current password is incorrect');
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: await hash(input.newPassword, { type: argon2id }), updatedAt: new Date(), revision: { increment: 1 } } });
      await tx.session.deleteMany({ where: { tenantId: auth.tenantId, userId: auth.id } });
      await this.audit(tx, auth, user.id, 'user.password_changed', null, {});
      await tx.$executeRaw`SELECT auth_release_attempt(${tokenHash(key)}, true)`;
      return { ok: true };
    });
  }
  preview(auth: AuthContext, body: unknown): Promise<UserImportPreview> {
    const { csv } = userImportSchema.parse(body), [headers, ...records] = parseUserCsv(csv);
    const allowed = ['name', 'email', 'role', 'approverEligible', 'isVp', 'managerEmail', 'homeDepartment', 'phone', 'jobTitle'];
    if (!headers || !['name', 'email'].every(name => headers.includes(name)) || new Set(headers).size !== headers.length || headers.some(name => !allowed.includes(name))) throw new BadRequestException('CSV requires name,email and supported unique headers');
    return this.run(auth, true, async tx => {
      const users = await tx.user.findMany({ where: { tenantId: auth.tenantId } });
      const emails = new Set(users.map(user => user.email.toLowerCase()));
      const rows = records.map((values, index) => {
        const row = Object.fromEntries(headers.map((header, i) => [header, (values[i] ?? '').trim()])), errors: string[] = [];
        if (values.length !== headers.length) errors.push('Column count differs from header');
        const email = (row.email ?? '').toLowerCase();
        if (emails.has(email)) errors.push('Email already exists or is repeated in this CSV');
        emails.add(email);
        const manager = row.managerEmail ? users.find(user => user.email.toLowerCase() === row.managerEmail!.toLowerCase() && user.active) : null;
        if (row.managerEmail && !manager) errors.push('Manager must be an existing active user in this organisation');
        for (const key of ['approverEligible', 'isVp']) if (row[key] && !['true', 'false'].includes(row[key]!)) errors.push(`${key} must be true or false`);
        const result = createUserSchema.safeParse({ name: row.name, email, role: row.role || 'employee', approverEligible: row.approverEligible === 'true', isVp: row.isVp === 'true', managerId: manager?.id ?? null, homeDepartment: row.homeDepartment ?? '', phone: row.phone ?? '', jobTitle: row.jobTitle ?? '' });
        if (!result.success) errors.push(...result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`));
        return { row: index + 2, user: result.success ? result.data : null, errors };
      });
      const valid = rows.every(row => !row.errors.length);
      let previewToken: string | null = null, expiresAt: string | null = null;
      if (valid) {
        await tx.$executeRaw`DELETE FROM user_import_previews WHERE tenant_id=${auth.tenantId}::uuid AND expires_at <= now()`;
        const [count] = await tx.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM user_import_previews WHERE tenant_id=${auth.tenantId}::uuid`;
        if (Number(count?.total) >= 100) throw new ConflictException('Too many import previews. Try again later.');
        previewToken = randomBytes(32).toString('base64url'); const expires = Date.now() + 600000; expiresAt = new Date(expires).toISOString();
        await tx.$executeRaw`INSERT INTO user_import_previews(token_hash,tenant_id,actor_id,session_id,expires_at,users) VALUES(${tokenHash(previewToken)},${auth.tenantId}::uuid,${auth.id}::uuid,${auth.sessionId}::uuid,${new Date(expires)},${JSON.stringify(rows.map(row => row.user!))}::jsonb)`;
      }
      return { rows, valid, previewToken, expiresAt };
    });
  }
  commit(auth: AuthContext, body: unknown) {
    const input = userImportCommitSchema.parse(body), key = tokenHash(input.previewToken);
    return this.run(auth, true, async tx => {
      // Delete/return and account creation commit together; another process cannot reuse the token.
      const [preview] = await tx.$queryRaw<{ users: unknown[] }[]>`DELETE FROM user_import_previews WHERE token_hash=${key} AND tenant_id=${auth.tenantId}::uuid AND actor_id=${auth.id}::uuid AND session_id=${auth.sessionId}::uuid AND expires_at > now() RETURNING users`;
      if (!preview) throw new ConflictException('Import preview expired. Validate the CSV again.');
      const users = [];
      for (const input of preview.users) users.push(await this.add(tx, auth, createUserSchema.parse(input)));
      await this.audit(tx, auth, auth.tenantId, 'users.imported', null, { count: users.length });
      return { users };
    });
  }
  settings(auth: AuthContext): Promise<OrganisationSettings> { return this.run(auth, true, async tx => await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: settingsSelect }) as OrganisationSettings); }
  updateSettings(auth: AuthContext, body: unknown) {
    const input = organisationSettingsSchema.parse(body);
    try { new Intl.DateTimeFormat(input.locale, { timeZone: input.timezone }).format(); } catch { throw new BadRequestException('Choose a valid locale and IANA timezone'); }
    return this.run(auth, true, async tx => {
      const before = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: settingsSelect });
      if (before.revision !== input.revision) throw new ConflictException({ message: 'Settings changed. Refresh and try again.', current: before });
      const after = await tx.tenant.update({ where: { id: auth.tenantId }, data: { ...input, revision: { increment: 1 } }, select: settingsSelect });
      await this.audit(tx, auth, auth.tenantId, 'organisation.updated', before, after);
      return after;
    });
  }
}

@Controller()
@UseGuards(SessionGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get('admin/users') list(@Req() req: AuthRequest) { return this.users.list(req.auth); }
  @Post('admin/users') create(@Req() req: AuthRequest) { return this.users.create(req.auth, req.body); }
  @Post('admin/users/import/preview') preview(@Req() req: AuthRequest) { return this.users.preview(req.auth, req.body); }
  @Post('admin/users/import/commit') commit(@Req() req: AuthRequest) { return this.users.commit(req.auth, req.body); }
  @Post('admin/users/:id') update(@Req() req: AuthRequest, @Param('id') id: string) { return this.users.update(req.auth, id, req.body); }
  @Post('admin/users/:id/invite') invite(@Req() req: AuthRequest, @Param('id') id: string) { return this.users.reinvite(req.auth, id, req.body); }
  @Get('profile') profile(@Req() req: AuthRequest) { return this.users.profile(req.auth); }
  @Get('users/:id') user(@Req() req: AuthRequest, @Param('id') id: string) { return this.users.profile(req.auth, id); }
  @Post('auth/password') password(@Req() req: AuthRequest) { return this.users.changePassword(req.auth, req.body); }
  @Get('admin/settings') settings(@Req() req: AuthRequest) { return this.users.settings(req.auth); }
  @Post('admin/settings') updateSettings(@Req() req: AuthRequest) { return this.users.updateSettings(req.auth, req.body); }
}
@Controller('auth')
export class PublicInvitationController {
  constructor(private readonly users: UsersService, private readonly auth: AuthService) {}
  @Post('activate') activate(@Req() req: FastifyRequest) { this.auth.checkOrigin(req); return this.users.activate(req.body); }
}
