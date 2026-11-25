import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tenant } from "@prisma/client";
import {
  canConfigureOrganisation,
  canReadOperatorTicket,
  type OperatorAccess,
} from "@astrama/domain";
import { Database, lockConfiguration, lockConfigurationExclusive, type Tx } from "./database.js";
import { SessionGuard, type AuthContext, type AuthRequest } from "./modules/auth/auth.service.js";
import {
  OperatorGuard,
  type OperatorRequest,
  type OperatorSessionContext,
} from "./operator-auth.js";

const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);

/** Recheck the current account, role and MFA session within the business transaction. */
export async function currentOperator(tx: Tx, auth: OperatorSessionContext) {
  const [operator] = await tx.$queryRaw<{ id: string; role: "support" | "owner" }[]>`
    SELECT o.id,o.role FROM operators o JOIN operator_sessions s ON s.operator_id=o.id
    WHERE o.id=${auth.id}::uuid AND o.active AND o.mfa_enrolled AND s.id=${auth.sessionId}::uuid
      AND s.mfa_verified AND s.expires_at>now() AND s.last_seen_at>now()-interval '15 minutes'
    FOR SHARE OF o,s`;
  if (!operator)
    throw new ForbiddenException("An active MFA-verified operator session is required");
  return operator;
}

export async function operatorAudit(
  tx: Tx,
  operatorId: string,
  tenant: { id: string; slug: string } | null,
  action: string,
  explanation: string,
  detail: Record<string, unknown> = {},
) {
  await tx.$executeRaw`INSERT INTO operator_audits(id,operator_id,tenant_id,tenant_slug,action,reason,detail)
    VALUES(${randomUUID()}::uuid,${operatorId}::uuid,${tenant?.id ?? null}::uuid,${tenant?.slug ?? null},
      ${action},${explanation},${JSON.stringify(detail)}::jsonb)`;
}

export function withOperatorTenant<T>(
  db: Database,
  auth: OperatorSessionContext,
  id: string,
  exclusive: boolean,
  work: (tx: Tx, tenant: Tenant, operator: { id: string; role: "support" | "owner" }) => Promise<T>,
  allowInactive = false,
) {
  const tenantId = uuid.parse(id);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
      if (exclusive) await lockConfigurationExclusive(tx, tenantId);
      else await lockConfiguration(tx, tenantId);
      const operator = await currentOperator(tx, auth);
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new NotFoundException("Organisation not found");
      if (!allowInactive && !tenant.active)
        throw new ForbiddenException("Organisation is unavailable");
      return work(tx, tenant, operator);
    },
    { maxWait: 10000, timeout: 30000 },
  );
}

/** The granting administrator's current groups bound sensitive and internal access. */
export async function operatorSupportAccess(
  tx: Tx,
  operatorId: string,
  tenantId: string,
): Promise<OperatorAccess> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT g.id FROM operator_support_grants g JOIN users u ON u.tenant_id=g.tenant_id AND u.id=g.granted_by_id
    WHERE g.tenant_id=${tenantId}::uuid AND g.operator_id=${operatorId}::uuid
      AND g.revoked_at IS NULL AND g.expires_at>now() AND u.active AND u.role='admin' AND u.mfa_enrolled
    FOR SHARE OF g,u`;
  if (!row)
    throw new ForbiddenException("A current, explicit administrator support grant is required");
  const grant = await tx.operatorSupportGrant.findUniqueOrThrow({
    where: { id: row.id },
    include: {
      grantedBy: { include: { memberships: { where: { department: { active: true } } } } },
    },
  });
  return {
    tenantId,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    departmentIds: grant.grantedBy.memberships.map((membership) => membership.departmentId),
  };
}

@Injectable()
export class OperatorAccessService {
  constructor(private readonly db: Database) {}

  private async admin<T>(auth: AuthContext, exclusive: boolean, work: (tx: Tx) => Promise<T>) {
    if (!canConfigureOrganisation({ ...auth, mfaVerified: auth.view.mfaVerified }))
      throw new ForbiddenException("MFA-verified administrator required");
    return this.db.withTenant(auth.tenantId, async (tx) => {
      if (exclusive) await lockConfigurationExclusive(tx, auth.tenantId);
      else await lockConfiguration(tx, auth.tenantId);
      const session = await tx.session.findFirst({
        where: {
          id: auth.sessionId,
          tenantId: auth.tenantId,
          userId: auth.id,
          mfaVerified: true,
          expiresAt: { gt: new Date() },
          user: { active: true, role: "admin", mfaEnrolled: true },
        },
      });
      if (!session) throw new ForbiddenException("MFA-verified administrator required");
      return work(tx);
    });
  }

  list(auth: AuthContext, query: unknown) {
    const input = z
      .object({ email: z.string().trim().email().max(254).optional(), viewCursor: uuid.optional() })
      .strict()
      .parse(query);
    return this.admin(auth, false, async (tx) => {
      if (
        input.viewCursor &&
        !(await tx.operatorAudit.findFirst({
          where: {
            id: input.viewCursor,
            tenantId: auth.tenantId,
            action: { startsWith: "support." },
          },
          select: { id: true },
        }))
      )
        throw new NotFoundException("View history cursor not found");
      const views = await tx.operatorAudit.findMany({
        where: { tenantId: auth.tenantId, action: { startsWith: "support." } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 101,
        ...(input.viewCursor ? { cursor: { id: input.viewCursor }, skip: 1 } : {}),
        select: {
          id: true,
          action: true,
          reason: true,
          detail: true,
          createdAt: true,
          operator: { select: { name: true, email: true } },
        },
      });
      return {
        operators: input.email
          ? await tx.operator.findMany({
              where: { email: input.email.toLowerCase(), active: true },
              select: { id: true, name: true, email: true },
            })
          : [],
        grants: await tx.operatorSupportGrant.findMany({
          where: { tenantId: auth.tenantId },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            revision: true,
            expiresAt: true,
            revokedAt: true,
            reason: true,
            createdAt: true,
            operator: { select: { id: true, name: true, email: true } },
          },
        }),
        views: views.slice(0, 100),
        ...(views.length > 100 ? { nextViewCursor: views[99]!.id } : {}),
      };
    });
  }

  grant(auth: AuthContext, body: unknown) {
    const input = z
      .object({
        operatorEmail: z.string().trim().email().max(254),
        expiresAt: z.coerce.date(),
        reason,
        revision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(body);
    const now = new Date();
    if (input.expiresAt <= now || input.expiresAt.getTime() > now.getTime() + 24 * 3600000)
      throw new ForbiddenException("Choose a future expiry within 24 hours");
    return this.admin(auth, true, async (tx) => {
      const operator = await tx.operator.findFirst({
        where: { email: input.operatorEmail.toLowerCase(), active: true },
        select: { id: true },
      });
      if (!operator) throw new NotFoundException("Active operator not found");
      const before = await tx.operatorSupportGrant.findUnique({
        where: { tenantId_operatorId: { tenantId: auth.tenantId, operatorId: operator.id } },
      });
      if (before && input.revision !== before.revision)
        throw new ConflictException("Support grant changed. Refresh before submitting again.");
      const grant = await tx.operatorSupportGrant.upsert({
        where: { tenantId_operatorId: { tenantId: auth.tenantId, operatorId: operator.id } },
        create: {
          tenantId: auth.tenantId,
          operatorId: operator.id,
          grantedById: auth.id,
          expiresAt: input.expiresAt,
          reason: input.reason,
        },
        update: {
          grantedById: auth.id,
          expiresAt: input.expiresAt,
          revokedAt: null,
          reason: input.reason,
          createdAt: now,
          revision: { increment: 1 },
        },
      });
      await tx.configAudit.create({
        data: {
          tenantId: auth.tenantId,
          actorId: auth.id,
          entityId: grant.id,
          action: "operator_access.granted",
          detail: {
            operatorId: operator.id,
            expiresAt: input.expiresAt.toISOString(),
            reason: input.reason,
          },
        },
      });
      return { id: grant.id, expiresAt: grant.expiresAt };
    });
  }

  revoke(auth: AuthContext, body: unknown) {
    const input = z
      .object({ grantId: uuid, reason, revision: z.number().int().nonnegative() })
      .strict()
      .parse(body);
    return this.admin(auth, true, async (tx) => {
      const grant = await tx.operatorSupportGrant.findFirst({
        where: { tenantId: auth.tenantId, id: input.grantId },
      });
      if (!grant) throw new NotFoundException("Support grant not found");
      if (!grant.revokedAt) {
        if (grant.revision !== input.revision)
          throw new ConflictException("Support grant changed. Refresh before revoking.");
        await tx.operatorSupportGrant.update({
          where: { id: grant.id },
          data: { revokedAt: new Date(), revision: { increment: 1 } },
        });
        await tx.configAudit.create({
          data: {
            tenantId: auth.tenantId,
            actorId: auth.id,
            entityId: grant.id,
            action: "operator_access.revoked",
            detail: { operatorId: grant.operatorId, reason: input.reason },
          },
        });
      }
      return { ok: true };
    });
  }

  private support<T>(
    auth: OperatorSessionContext,
    id: string,
    work: (tx: Tx, access: OperatorAccess) => Promise<T>,
  ) {
    return withOperatorTenant(this.db, auth, id, false, async (tx, tenant) =>
      work(tx, await operatorSupportAccess(tx, auth.id, tenant.id)),
    );
  }

  tickets(auth: OperatorSessionContext, tenantId: string, query: unknown) {
    const input = z.object({ cursor: uuid.optional() }).strict().parse(query);
    return this.support(auth, tenantId, async (tx, access) => {
      const rows = await tx.ticket.findMany({
        where: {
          tenantId: access.tenantId,
          OR: [{ sensitive: false }, { departmentId: { in: access.departmentIds } }],
          ...(input.cursor ? { id: { gt: input.cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: 51,
        select: {
          id: true,
          tenantId: true,
          number: true,
          summary: true,
          state: true,
          departmentId: true,
          sensitive: true,
        },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const tickets = rows.slice(0, 50).filter((ticket) => canReadOperatorTicket(access, ticket));
      await operatorAudit(
        tx,
        auth.id,
        tenant,
        "support.tickets.viewed",
        "Time-limited support grant",
        { count: tickets.length },
      );
      return { tickets, ...(rows.length > 50 ? { nextCursor: rows[49]!.id } : {}) };
    });
  }

  ticket(auth: OperatorSessionContext, tenantId: string, id: string) {
    const ticketId = uuid.parse(id);
    return this.support(auth, tenantId, async (tx, access) => {
      const ticket = await tx.ticket.findFirst({
        where: { tenantId: access.tenantId, id: ticketId },
        select: {
          id: true,
          tenantId: true,
          number: true,
          summary: true,
          description: true,
          state: true,
          departmentId: true,
          sensitive: true,
          createdAt: true,
          updatedAt: true,
          priority: true,
          severity: true,
        },
      });
      if (!ticket || !canReadOperatorTicket(access, ticket))
        throw new NotFoundException("Ticket not found");
      const activities = await tx.activity.findMany({
        where: {
          tenantId: access.tenantId,
          ticketId,
          ...(access.departmentIds.includes(ticket.departmentId) ? {} : { audience: "customer" }),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          body: true,
          audience: true,
          createdAt: true,
          author: { select: { name: true } },
        },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      await operatorAudit(
        tx,
        auth.id,
        tenant,
        "support.ticket.viewed",
        "Time-limited support grant",
        { ticketId },
      );
      return { ...ticket, activities };
    });
  }
}

@Controller("admin/operator-access")
@UseGuards(SessionGuard)
export class TenantOperatorAccessController {
  constructor(private readonly service: OperatorAccessService) {}
  @Get() list(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.list(req.auth, query);
  }
  @Post() grant(@Req() req: AuthRequest) {
    return this.service.grant(req.auth, req.body);
  }
  @Post("revoke") revoke(@Req() req: AuthRequest) {
    return this.service.revoke(req.auth, req.body);
  }
}

@Controller("operator/organisations/:tenantId/tickets")
@UseGuards(OperatorGuard)
export class OperatorTicketsController {
  constructor(private readonly service: OperatorAccessService) {}
  @Get() list(
    @Req() req: OperatorRequest,
    @Param("tenantId") tenantId: string,
    @Query() query: unknown,
  ) {
    return this.service.tickets(req.operator, tenantId, query);
  }
  @Get(":id") get(
    @Req() req: OperatorRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
  ) {
    return this.service.ticket(req.operator, tenantId, id);
  }
  @Post() denyCreate() {
    throw new ForbiddenException("Operator support access is read-only");
  }
  @Post(":id") denyEdit() {
    throw new ForbiddenException("Operator support access is read-only");
  }
  @Post(":id/:operation") denyMutation() {
    throw new ForbiddenException("Operator support access is read-only");
  }
}
