import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canConfigureOrganisation } from '@astrama/domain';
import { createCategorySchema, createGroupSchema, createSubcategorySchema, revisionSchema, updateCategorySchema, updateGroupSchema, updateSubcategorySchema, type AdminConfig, type Group } from '@astrama/contracts';
import { Database, lockConfiguration, type Tx } from './database.js';
import type { AuthContext } from './auth.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const openTickets = { state: { notIn: ['Complete', 'Cancelled', 'Rejected'] } };
const groupInclude = { memberships: true } satisfies Prisma.DepartmentInclude;
type GroupRow = Prisma.DepartmentGetPayload<{ include: typeof groupInclude }>;
const groupView = (row: GroupRow): Group => ({ id: row.id, name: row.name, active: row.active, isTriage: row.isTriage, revision: row.revision, memberIds: row.memberships.map(m => m.userId).sort(), queueOwnerId: row.queueOwnerId, substituteId: row.substituteId });
const categorySelect = { id: true, name: true, departmentId: true, active: true, sensitive: true, revision: true, allowIncidents: true, allowRequests: true } as const;
const subcategorySelect = { id: true, categoryId: true, name: true, departmentId: true, active: true, revision: true } as const;

@Injectable()
export class AdminService {
  constructor(private readonly db: Database) {}
  private run<T>(auth: AuthContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (!canConfigureOrganisation({ ...auth, mfaVerified: auth.view.mfaVerified })) throw new ForbiddenException('MFA-verified administrator required');
    return this.db.withTenant(auth.tenantId, async tx => {
      await lockConfiguration(tx, auth.tenantId);
      const actor = await tx.user.findFirst({ where: { tenantId: auth.tenantId, id: auth.id, active: true, role: 'admin' } });
      const session = await tx.session.findFirst({ where: { tenantId: auth.tenantId, id: auth.sessionId, userId: auth.id, mfaVerified: true, expiresAt: { gt: new Date() } } });
      if (!actor || !session) throw new ForbiddenException('MFA-verified administrator required');
      try { return await work(tx); }
      catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003'].includes(error.code)) throw new ConflictException('Name is already used or record is still referenced. Archive used records.');
        throw error;
      }
    });
  }
  private id(id: string) { if (!uuid.test(id)) throw new NotFoundException('Configuration record not found'); }
  private revision(input: number, row: { revision: number }) { if (input !== row.revision) throw new ConflictException({ message: 'Configuration changed. Refresh and try again.', current: row }); }
  private audit(tx: Tx, auth: AuthContext, entityId: string, action: string, before: unknown, after: unknown) {
    return tx.configAudit.create({ data: { tenantId: auth.tenantId, actorId: auth.id, entityId, action, detail: { before, after } as Prisma.InputJsonObject } });
  }
  private async destination(tx: Tx, tenantId: string, id: string | null) {
    if (id && !await tx.department.findFirst({ where: { tenantId, id, active: true } })) throw new BadRequestException('Choose an active support group in this organisation');
  }
  config(auth: AuthContext): Promise<AdminConfig> {
    return this.run(auth, async tx => ({
      organisation: await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { id: true, name: true, brandName: true } }),
      groups: (await tx.department.findMany({ where: { tenantId: auth.tenantId }, include: groupInclude, orderBy: { name: 'asc' } })).map(groupView),
      agents: await tx.user.findMany({ where: { tenantId: auth.tenantId, role: 'agent', active: true }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }),
      categories: await tx.category.findMany({ where: { tenantId: auth.tenantId }, select: categorySelect, orderBy: { name: 'asc' } }),
      subcategories: await tx.subcategory.findMany({ where: { tenantId: auth.tenantId }, select: subcategorySelect, orderBy: { name: 'asc' } })
    }));
  }
  group(auth: AuthContext, body: unknown, id?: string) {
    const input = id ? updateGroupSchema.parse(body) : createGroupSchema.parse(body);
    if (id) this.id(id);
    return this.run(auth, async tx => {
      const before = id ? await tx.department.findFirst({ where: { id, tenantId: auth.tenantId }, include: groupInclude }) : null;
      if (id && !before) throw new NotFoundException('Support group not found');
      if (before) this.revision(updateGroupSchema.parse(body).revision, groupView(before));
      const active = id ? updateGroupSchema.parse(body).active : true;
      if (await tx.user.count({ where: { tenantId: auth.tenantId, id: { in: input.memberIds }, role: 'agent', active: true } }) !== input.memberIds.length) throw new BadRequestException('Members must be active agents in this organisation');
      const queueOwnerId = input.queueOwnerId === undefined ? before?.queueOwnerId ?? null : input.queueOwnerId;
      const substituteId = input.substituteId === undefined ? before?.substituteId ?? null : input.substituteId;
      if ([queueOwnerId, substituteId].some(userId => userId && !input.memberIds.includes(userId))) throw new BadRequestException('Queue owner and substitute must be selected active group members. Clear or replace removed owners.');
      if (queueOwnerId && queueOwnerId === substituteId) throw new BadRequestException('Choose different queue owner and substitute');
      if (before?.isTriage && (!active || !input.memberIds.length)) throw new ConflictException('Triage must remain active with an agent');
      if (before) {
        const removed = before.memberships.map(m => m.userId).filter(member => !input.memberIds.includes(member));
        if (removed.length && await tx.ticket.count({ where: { tenantId: auth.tenantId, departmentId: id, assignedToId: { in: removed }, ...openTickets } })) throw new ConflictException('A removed member still has unresolved assigned tickets');
        if (!active && (await tx.category.count({ where: { tenantId: auth.tenantId, departmentId: id, active: true } }) || await tx.subcategory.count({ where: { tenantId: auth.tenantId, departmentId: id, active: true, category: { active: true } } }) || await tx.ticket.count({ where: { tenantId: auth.tenantId, departmentId: id, ...openTickets } }))) throw new ConflictException('Group is used by active routing or unresolved tickets');
      }
      const row = before ? await tx.department.update({ where: { id: before.id }, data: { name: input.name, active, queueOwnerId, substituteId, revision: { increment: 1 } } }) : await tx.department.create({ data: { tenantId: auth.tenantId, name: input.name, queueOwnerId, substituteId } });
      await tx.membership.deleteMany({ where: { tenantId: auth.tenantId, departmentId: row.id } });
      await tx.membership.createMany({ data: input.memberIds.map(userId => ({ tenantId: auth.tenantId, departmentId: row.id, userId })) });
      const result = groupView(await tx.department.findUniqueOrThrow({ where: { id: row.id }, include: groupInclude }));
      await this.audit(tx, auth, row.id, before ? 'group.updated' : 'group.created', before ? groupView(before) : null, result);
      return result;
    });
  }
  category(auth: AuthContext, body: unknown, id?: string) {
    const input = id ? updateCategorySchema.parse(body) : createCategorySchema.parse(body);
    if (id) this.id(id);
    return this.run(auth, async tx => {
      const before = id ? await tx.category.findFirst({ where: { id, tenantId: auth.tenantId }, select: categorySelect }) : null;
      if (id && !before) throw new NotFoundException('Category not found');
      if (before) this.revision(updateCategorySchema.parse(body).revision, before);
      await this.destination(tx, auth.tenantId, input.departmentId);
      if ('active' in input && input.active && before && await tx.subcategory.count({ where: { tenantId: auth.tenantId, categoryId: before.id, active: true, department: { active: false } } })) throw new ConflictException('An active subcategory routes to an archived group. Update its routing first.');
      const after = before ? await tx.category.update({ where: { id: before.id }, data: { ...input, revision: { increment: 1 } }, select: categorySelect }) : await tx.category.create({ data: { tenantId: auth.tenantId, ...input }, select: categorySelect });
      await this.audit(tx, auth, after.id, before ? 'category.updated' : 'category.created', before, after);
      return after;
    });
  }
  subcategory(auth: AuthContext, body: unknown, id?: string) {
    const input = id ? updateSubcategorySchema.parse(body) : createSubcategorySchema.parse(body);
    if (id) this.id(id);
    return this.run(auth, async tx => {
      const before = id ? await tx.subcategory.findFirst({ where: { id, tenantId: auth.tenantId }, select: subcategorySelect }) : null;
      if (id && !before) throw new NotFoundException('Subcategory not found');
      if (before && 'revision' in input) this.revision(input.revision, before);
      const categoryId = before?.categoryId ?? ('categoryId' in input ? input.categoryId : '');
      const parent = await tx.category.findFirst({ where: { tenantId: auth.tenantId, id: categoryId } });
      const active = 'active' in input ? input.active : true;
      if (!parent || (active && !parent.active)) throw new BadRequestException('Choose an active category in this organisation');
      await this.destination(tx, auth.tenantId, input.departmentId);
      const after = before ? await tx.subcategory.update({ where: { id: before.id }, data: { name: input.name, active, departmentId: input.departmentId, revision: { increment: 1 } }, select: subcategorySelect }) : await tx.subcategory.create({ data: { tenantId: auth.tenantId, categoryId, name: input.name, departmentId: input.departmentId }, select: subcategorySelect });
      await this.audit(tx, auth, after.id, before ? 'subcategory.updated' : 'subcategory.created', before, after);
      return after;
    });
  }
  remove(auth: AuthContext, id: string, body: unknown, kind: 'category' | 'subcategory') {
    this.id(id); const input = revisionSchema.parse(body);
    return this.run(auth, async tx => {
      const before = kind === 'category' ? await tx.category.findFirst({ where: { id, tenantId: auth.tenantId }, select: categorySelect }) : await tx.subcategory.findFirst({ where: { id, tenantId: auth.tenantId }, select: subcategorySelect });
      if (!before) throw new NotFoundException('Configuration record not found');
      this.revision(input.revision, before);
      if (await tx.ticket.count({ where: { tenantId: auth.tenantId, ...(kind === 'category' ? { categoryId: id } : { subcategoryId: id }) } }) || (kind === 'category' && await tx.subcategory.count({ where: { tenantId: auth.tenantId, categoryId: id } }))) throw new ConflictException('This record is in use. Archive it instead.');
      if (kind === 'category') await tx.category.delete({ where: { id } });
      else await tx.subcategory.delete({ where: { id } });
      await this.audit(tx, auth, id, `${kind}.deleted`, before, null);
      return { ok: true };
    });
  }
}
