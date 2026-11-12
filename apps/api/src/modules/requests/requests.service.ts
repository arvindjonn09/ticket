import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Prisma, type CatalogItem, type Ticket } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  canActApproval,
  canConfigureOrganisation,
  isGroupAgent,
  terminalStates,
  type Actor,
} from "@astrama/domain";
import {
  approvalDecisionSchema,
  changeRequestSchema,
  correctionSchema,
  createRequestItemSchema,
  createRequestSchema,
  delegationSchema,
  revisionSchema,
  updateRequestItemSchema,
} from "@astrama/contracts";
import { SessionGuard, type AuthContext, type AuthRequest } from "../auth/auth.service.js";
import { type Tx } from "../../database.js";
import { ticketInclude, TicketsService } from "../tickets/tickets.service.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemView = (item: CatalogItem) => ({
  id: item.id,
  name: item.name,
  categoryId: item.categoryId,
  unitCostMinor: item.unitCostMinor,
  currency: item.currency,
  recurringPeriod: item.recurringPeriod,
  requiresManager: item.requiresManager,
  requiresVp: item.requiresVp,
  vpThresholdMinor: item.vpThresholdMinor,
  vpApproverId: item.vpApproverId,
  alternateApproverId: item.alternateApproverId,
  active: item.active,
  revision: item.revision,
});

@Injectable()
export class RequestsService {
  constructor(private readonly tickets: TicketsService) {}
  private admin(auth: AuthContext, actor: Actor) {
    if (!canConfigureOrganisation({ ...actor, mfaVerified: auth.view.mfaVerified }))
      throw new ForbiddenException("MFA-verified administrator required");
  }
  private validId(id: string) {
    if (!uuid.test(id)) throw new NotFoundException("Record not found");
  }
  private total(quantity: number, unitCostMinor: number) {
    const total = quantity * unitCostMinor;
    if (total > 2_000_000_000)
      throw new BadRequestException("Total cost exceeds the supported limit");
    return total;
  }
  catalog(auth: AuthContext) {
    return this.tickets.scoped(auth, async (tx) => ({
      items: (
        await tx.catalogItem.findMany({
          where: {
            tenantId: auth.tenantId,
            active: true,
            category: { active: true, allowRequests: true },
          },
          orderBy: { name: "asc" },
        })
      ).map(itemView),
      users: await tx.user.findMany({
        where: { tenantId: auth.tenantId, active: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    }));
  }
  items(auth: AuthContext) {
    return this.tickets.scoped(auth, async (tx, actor) => {
      this.admin(auth, actor);
      return {
        items: (
          await tx.catalogItem.findMany({
            where: { tenantId: actor.tenantId },
            orderBy: { name: "asc" },
          })
        ).map(itemView),
        approvers: await tx.user.findMany({
          where: { tenantId: actor.tenantId, active: true, approverEligible: true },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
      };
    });
  }
  item(auth: AuthContext, body: unknown, id?: string) {
    const input = id ? updateRequestItemSchema.parse(body) : createRequestItemSchema.parse(body);
    if (id) this.validId(id);
    return this.tickets.scoped(auth, async (tx, actor) => {
      this.admin(auth, actor);
      const before = id
        ? await tx.catalogItem.findFirst({ where: { tenantId: actor.tenantId, id } })
        : null;
      if (id && !before) throw new NotFoundException("Request item not found");
      if (before && before.revision !== updateRequestItemSchema.parse(body).revision)
        throw new ConflictException({ message: "Request item changed", current: itemView(before) });
      if (
        before &&
        (before.currency !== input.currency || before.recurringPeriod !== input.recurringPeriod) &&
        (await tx.ticket.count({
          where: { tenantId: actor.tenantId, itemId: before.id, state: { notIn: terminalStates } },
        }))
      )
        throw new ConflictException(
          "Currency and recurring cost period cannot change while requests are active. Create another item or finish the existing requests first.",
        );
      if (
        !(await tx.category.findFirst({
          where: {
            tenantId: actor.tenantId,
            id: input.categoryId,
            active: true,
            allowRequests: true,
          },
        }))
      )
        throw new BadRequestException("Choose an active request category");
      for (const [approverId, vp] of [
        [input.vpApproverId, true],
        [input.alternateApproverId, false],
      ] as const) {
        if (
          approverId &&
          !(await tx.user.findFirst({
            where: {
              tenantId: actor.tenantId,
              id: approverId,
              active: true,
              approverEligible: true,
              ...(vp ? { isVp: true } : {}),
            },
          }))
        )
          throw new BadRequestException("Choose an active eligible approver in this organisation");
      }
      const { revision: _revision, ...data } = { ...input, revision: 0 };
      void _revision;
      try {
        const row = before
          ? await tx.catalogItem.update({
              where: { id: before.id },
              data: { ...data, revision: { increment: 1 } },
            })
          : await tx.catalogItem.create({ data: { tenantId: actor.tenantId, ...data } });
        if (
          before &&
          (
            [
              "requiresManager",
              "requiresVp",
              "vpThresholdMinor",
              "vpApproverId",
              "alternateApproverId",
            ] as const
          ).some((field) => before[field] !== row[field])
        ) {
          const affected = await tx.ticket.findMany({
            where: { tenantId: actor.tenantId, itemId: row.id, state: { notIn: terminalStates } },
          });
          for (const ticket of affected) {
            await tx.ticket.update({
              where: { id: ticket.id },
              data: { revision: { increment: 1 }, updatedAt: new Date() },
            });
            await this.tickets.evaluateApprovals(tx, actor, ticket, row);
          }
        }
        await tx.configAudit.create({
          data: {
            tenantId: actor.tenantId,
            actorId: actor.id,
            entityId: row.id,
            action: before ? "request_item.updated" : "request_item.created",
            detail: { before: before ? itemView(before) : null, after: itemView(row) },
          },
        });
        return itemView(row);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
          throw new ConflictException("Request item name is already used");
        throw error;
      }
    });
  }
  private async evaluate(tx: Tx, actor: Actor, ticket: Ticket, item: CatalogItem) {
    return this.tickets.evaluateApprovals(tx, actor, ticket, item);
  }
  create(auth: AuthContext, body: unknown, key: unknown) {
    const input = createRequestSchema.parse(body);
    if (typeof key !== "string" || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new BadRequestException("A valid Idempotency-Key header is required");
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.tickets.scoped(auth, async (tx, actor) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.tenantId}:${actor.id}:request.create:${key}`},0))`;
      const existing = await tx.idempotency.findUnique({
        where: {
          tenantId_actorId_operation_key: {
            tenantId: actor.tenantId,
            actorId: actor.id,
            operation: "request.create",
            key,
          },
        },
      });
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new ConflictException("Idempotency key was used with different content");
        return this.tickets.detail(
          tx,
          actor,
          await this.tickets.record(tx, actor, existing.ticketId),
        );
      }
      this.tickets.validateChannel(actor, input.channel);
      const item = await tx.catalogItem.findFirst({
        where: { tenantId: actor.tenantId, id: input.itemId, active: true },
      });
      if (!item) throw new BadRequestException("Choose an active request item");
      if (
        !(await tx.user.findFirst({
          where: { tenantId: actor.tenantId, id: input.requestedForId, active: true },
        }))
      )
        throw new BadRequestException("Choose an active requested-for user in this organisation");
      const route = await this.tickets.routing(
        tx,
        actor,
        item.categoryId,
        input.subcategoryId,
        "request",
      );
      const totalCostMinor = this.total(input.quantity, item.unitCostMinor),
        tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
      const [counter] = await tx.$queryRaw<
        { sequence: number }[]
      >`INSERT INTO counters(tenant_id,type,sequence) VALUES (${actor.tenantId}::uuid,'request',1) ON CONFLICT (tenant_id,type) DO UPDATE SET sequence=counters.sequence+1 RETURNING sequence`;
      if (!counter) throw new Error("Request number allocation failed");
      const ticket = await tx.ticket.create({
        data: {
          tenantId: actor.tenantId,
          type: "request",
          sequence: counter.sequence,
          number: `${tenant.requestPrefix}${String(counter.sequence).padStart(4, "0")}`,
          callerId: actor.id,
          submittedById: actor.id,
          categoryId: item.categoryId,
          subcategoryId: route.subcategoryId,
          departmentId: route.departmentId,
          sensitive: route.sensitive,
          priority: "P4",
          severity: tenant.defaultSeverity,
          ...input,
          unitCostMinor: item.unitCostMinor,
          totalCostMinor,
          currency: item.currency,
        },
      });
      await this.evaluate(tx, actor, ticket, item);
      await tx.idempotency.create({
        data: {
          tenantId: actor.tenantId,
          actorId: actor.id,
          operation: "request.create",
          key,
          fingerprint,
          ticketId: ticket.id,
        },
      });
      await this.tickets.event(tx, actor, ticket.id, "request.created", {
        departmentId: route.departmentId,
        routingException: route.exception,
        submittedById: actor.id,
        channel: input.channel,
      });
      return this.tickets.detail(tx, actor, await this.tickets.record(tx, actor, ticket.id));
    });
  }
  change(auth: AuthContext, id: string, body: unknown) {
    const input = changeRequestSchema.parse(body);
    return this.tickets.scoped(auth, async (tx, actor) => {
      const ticket = await this.tickets.record(tx, actor, id);
      if (
        ticket.type !== "request" ||
        terminalStates.includes(ticket.state) ||
        (!isGroupAgent(actor, ticket) &&
          !canConfigureOrganisation({ ...actor, mfaVerified: auth.view.mfaVerified }))
      )
        throw new ForbiddenException("Authorized request staff and an active request required");
      if (ticket.revision !== input.revision) return this.tickets.conflict(tx, actor, id);
      const item = await tx.catalogItem.findFirst({
        where: { tenantId: actor.tenantId, id: input.itemId, active: true },
      });
      if (
        !item ||
        !(await tx.user.findFirst({
          where: { tenantId: actor.tenantId, id: input.requestedForId, active: true },
        }))
      )
        throw new BadRequestException("Choose an active item and requested-for user");
      const unitCostMinor = input.unitCostMinor ?? item.unitCostMinor,
        totalCostMinor = this.total(input.quantity, unitCostMinor);
      const route = await this.tickets.routing(
        tx,
        actor,
        item.categoryId,
        item.categoryId === ticket.categoryId ? (ticket.subcategoryId ?? undefined) : undefined,
        "request",
      );
      await this.tickets.update(tx, actor, ticket, input.revision, {
        itemId: item.id,
        requestedForId: input.requestedForId,
        quantity: input.quantity,
        unitCostMinor,
        totalCostMinor,
        currency: item.currency,
        categoryId: item.categoryId,
        subcategoryId: route.subcategoryId,
        departmentId: route.departmentId,
        sensitive: ticket.sensitive || route.sensitive,
        assignedToId: null,
      });
      await this.evaluate(tx, actor, await tx.ticket.findUniqueOrThrow({ where: { id } }), item);
      await this.tickets.event(tx, actor, id, "request.changed", {
        reason: input.reason,
        previousVersion: ticket.approvalVersion,
        routingException: route.exception,
      });
      return this.tickets.detail(
        tx,
        actor,
        await tx.ticket.findUniqueOrThrow({ where: { id }, include: ticketInclude }),
      );
    });
  }
  corrections(auth: AuthContext) {
    return this.tickets.scoped(auth, async (tx, actor) => {
      this.admin(auth, actor);
      return {
        tickets: (
          await tx.ticket.findMany({
            where: {
              tenantId: actor.tenantId,
              state: "Pending Approval",
              approvalCorrectionReason: { not: null },
            },
            select: { id: true, number: true, revision: true, approvalCorrectionReason: true },
            orderBy: { createdAt: "asc" },
          })
        ).map((t) => ({
          id: t.id,
          number: t.number,
          summary: "Approval configuration correction required",
          revision: t.revision,
          correctionReason: t.approvalCorrectionReason,
        })),
      };
    });
  }
  correct(auth: AuthContext, id: string, body: unknown) {
    const input = correctionSchema.parse(body);
    this.validId(id);
    return this.tickets.scoped(auth, async (tx, actor) => {
      this.admin(auth, actor);
      const ticket = await tx.ticket.findFirst({
        where: { tenantId: actor.tenantId, id, type: "request", state: "Pending Approval" },
        include: { item: true },
      });
      if (!ticket?.item) throw new NotFoundException("Pending request not found");
      if (ticket.revision !== input.revision)
        throw new ConflictException("Request changed. Refresh and try again.");
      await tx.ticket.update({
        where: { id },
        data: { revision: { increment: 1 }, updatedAt: new Date() },
      });
      await this.evaluate(tx, actor, ticket, ticket.item);
      await this.tickets.event(tx, actor, id, "request.approvals_corrected", {
        reason: input.reason,
      });
      return { id, revision: ticket.revision + 1 };
    });
  }
  private async acting(
    tx: Tx,
    actor: Actor,
    approval: {
      approverId: string | null;
      stage: string;
      ticket: { callerId: string; requestedForId: string | null };
    },
  ) {
    if (!approval.approverId) return false;
    const original = await tx.user.findFirst({
        where: { tenantId: actor.tenantId, id: approval.approverId },
      }),
      actual = await tx.user.findFirst({ where: { tenantId: actor.tenantId, id: actor.id } }),
      now = new Date();
    const delegation =
      approval.approverId === actor.id
        ? undefined
        : await tx.approvalDelegation.findFirst({
            where: {
              tenantId: actor.tenantId,
              approverId: approval.approverId,
              delegateId: actor.id,
              active: true,
              startsAt: { lte: now },
              endsAt: { gt: now },
            },
          });
    if (approval.approverId !== actor.id && !delegation) return false;
    // A nominee cannot exercise incoming authority through their own delegate.
    if (
      approval.approverId !== actor.id &&
      (await tx.approvalDelegation.count({
        where: {
          tenantId: actor.tenantId,
          approverId: actor.id,
          active: true,
          startsAt: { lte: now },
          endsAt: { gt: now },
        },
      }))
    )
      return false;
    return canActApproval(
      actor.id,
      original,
      actual,
      approval.ticket,
      approval.stage === "vp",
      delegation ?? undefined,
      now,
    );
  }
  queue(auth: AuthContext) {
    return this.tickets.scoped(auth, async (tx, actor) => {
      const rows = await tx.approval.findMany({
        where: {
          tenantId: actor.tenantId,
          status: "Pending",
          ticket: { state: "Pending Approval", id: { in: actor.approvalTicketIds ?? [] } },
        },
        include: {
          approver: true,
          ticket: { include: { requestedFor: true, caller: true, item: true } },
          decidedBy: true,
        },
        orderBy: [{ ticket: { createdAt: "asc" } }, { stage: "asc" }],
      });
      const approvals = [];
      for (const row of rows) {
        if (
          row.version !== row.ticket.approvalVersion ||
          row.correctionReason ||
          !(await this.acting(tx, actor, row))
        )
          continue;
        if (
          row.stage === "vp" &&
          (await tx.approval.count({
            where: {
              tenantId: actor.tenantId,
              ticketId: row.ticketId,
              version: row.version,
              stage: "manager",
              status: { not: "Approved" },
            },
          }))
        )
          continue;
        approvals.push({
          id: row.id,
          ticketId: row.ticketId,
          number: row.ticket.number,
          summary: row.ticket.summary,
          stage: row.stage,
          status: row.status,
          version: row.version,
          approverId: row.approverId,
          approverName: row.approver?.name ?? null,
          decidedById: null,
          decidedByName: null,
          decidedAt: null,
          comment: null,
          correctionReason: row.correctionReason,
          revision: row.ticket.revision,
          requestedForName: row.ticket.requestedFor?.name ?? "",
          totalCostMinor: row.ticket.totalCostMinor,
          currency: row.ticket.currency,
          createdAt: row.ticket.createdAt.toISOString(),
          callerName: row.ticket.caller.name,
          itemName: row.ticket.item?.name ?? "",
          justification: row.ticket.justification,
        });
      }
      return { approvals };
    });
  }
  decide(auth: AuthContext, id: string, body: unknown) {
    const input = approvalDecisionSchema.parse(body);
    this.validId(id);
    return this.tickets
      .scoped(auth, async (tx, actor) => {
        const approval = await tx.approval.findFirst({
          where: { tenantId: actor.tenantId, id },
          include: { ticket: { include: ticketInclude } },
        });
        if (!approval || !(await this.acting(tx, actor, approval)))
          throw new NotFoundException("Approval not found or no longer eligible");
        const ticket = approval.ticket;
        if (
          ticket.revision !== input.revision ||
          ticket.approvalVersion !== input.version ||
          approval.version !== input.version ||
          approval.status !== "Pending" ||
          ticket.state !== "Pending Approval"
        )
          throw new ConflictException("Approval or request changed. Refresh and try again.");
        if (!(await this.tickets.approvalsMatch(tx, actor, ticket, ticket.item!))) {
          await this.tickets.update(tx, actor, ticket, input.revision, {});
          await this.evaluate(tx, actor, ticket, ticket.item!);
          return { stalePolicy: true as const };
        }
        if (
          approval.stage === "vp" &&
          (await tx.approval.count({
            where: {
              tenantId: actor.tenantId,
              ticketId: ticket.id,
              version: input.version,
              stage: "manager",
              status: { not: "Approved" },
            },
          }))
        )
          throw new ConflictException("Manager approval must succeed first");
        await this.tickets.update(tx, actor, ticket, input.revision, {});
        await tx.approval.update({
          where: { id },
          data: {
            status: input.decision,
            decidedById: actor.id,
            comment: input.comment,
            decidedAt: new Date(),
          },
        });
        if (input.decision === "Rejected") {
          await tx.ticket.update({ where: { id: ticket.id }, data: { state: "Rejected" } });
          await tx.approval.updateMany({
            where: {
              tenantId: actor.tenantId,
              ticketId: ticket.id,
              version: input.version,
              status: "Pending",
            },
            data: { status: "Invalidated" },
          });
          await tx.activity.create({
            data: {
              tenantId: actor.tenantId,
              ticketId: ticket.id,
              authorId: actor.id,
              audience: "customer",
              body: input.comment!,
            },
          });
        } else if (
          !(await tx.approval.count({
            where: {
              tenantId: actor.tenantId,
              ticketId: ticket.id,
              version: input.version,
              status: { not: "Approved" },
            },
          }))
        )
          await tx.ticket.update({
            where: { id: ticket.id },
            data: { state: "Open", approvalCorrectionReason: null },
          });
        await this.tickets.event(tx, actor, ticket.id, "request.approval_decided", {
          approvalId: id,
          version: input.version,
          stage: approval.stage,
          originalApproverId: approval.approverId,
          decisionMakerId: actor.id,
          decision: input.decision,
        });
        return this.tickets.detail(
          tx,
          actor,
          await tx.ticket.findUniqueOrThrow({ where: { id: ticket.id }, include: ticketInclude }),
        );
      })
      .then((result) => {
        if ("stalePolicy" in result)
          throw new ConflictException(
            "Approval authority changed. The request was re-evaluated; refresh before deciding.",
          );
        return result;
      });
  }
  delegations(auth: AuthContext) {
    return this.tickets.scoped(auth, async (tx, actor) => ({
      delegations: (
        await tx.approvalDelegation.findMany({
          where: { tenantId: actor.tenantId, approverId: actor.id, active: true },
          orderBy: { startsAt: "asc" },
        })
      ).map((d) => ({
        id: d.id,
        delegateId: d.delegateId,
        startsAt: d.startsAt.toISOString(),
        endsAt: d.endsAt.toISOString(),
        revision: d.revision,
      })),
      users: await tx.user.findMany({
        where: {
          tenantId: actor.tenantId,
          active: true,
          approverEligible: true,
          id: { not: actor.id },
        },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    }));
  }
  delegate(auth: AuthContext, body: unknown) {
    const input = delegationSchema.parse(body);
    return this.tickets.scoped(auth, async (tx, actor) => {
      const [original, delegate] = await Promise.all([
        tx.user.findFirst({
          where: { tenantId: actor.tenantId, id: actor.id, active: true, approverEligible: true },
        }),
        tx.user.findFirst({
          where: {
            tenantId: actor.tenantId,
            id: input.delegateId,
            active: true,
            approverEligible: true,
          },
        }),
      ]);
      if (
        !original ||
        !delegate ||
        original.id === delegate.id ||
        (original.isVp && !delegate.isVp)
      )
        throw new BadRequestException(
          "Delegate must be another active eligible same-organisation approver with sufficient authority",
        );
      const startsAt = new Date(input.startsAt),
        endsAt = new Date(input.endsAt);
      if (endsAt <= new Date()) throw new BadRequestException("Delegation must end in the future");
      if (
        await tx.approvalDelegation.count({
          where: {
            tenantId: actor.tenantId,
            active: true,
            startsAt: { lt: endsAt },
            endsAt: { gt: startsAt },
            OR: [{ delegateId: actor.id }, { approverId: delegate.id }, { approverId: actor.id }],
          },
        })
      )
        throw new ConflictException(
          "Overlapping delegations and delegation chains are not permitted",
        );
      const row = await tx.approvalDelegation.create({
        data: {
          tenantId: actor.tenantId,
          approverId: actor.id,
          delegateId: delegate.id,
          startsAt,
          endsAt,
        },
      });
      await tx.configAudit.create({
        data: {
          tenantId: actor.tenantId,
          actorId: actor.id,
          entityId: row.id,
          action: "approval.delegation_created",
          detail: { delegateId: delegate.id, startsAt: input.startsAt, endsAt: input.endsAt },
        },
      });
      return {
        id: row.id,
        delegateId: row.delegateId,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        revision: row.revision,
      };
    });
  }
  revoke(auth: AuthContext, id: string, body: unknown) {
    const input = revisionSchema.parse(body);
    this.validId(id);
    return this.tickets.scoped(auth, async (tx, actor) => {
      const row = await tx.approvalDelegation.findFirst({
        where: { tenantId: actor.tenantId, id, approverId: actor.id },
      });
      if (!row) throw new NotFoundException("Delegation not found");
      if (row.revision !== input.revision || !row.active)
        throw new ConflictException("Delegation changed");
      await tx.approvalDelegation.update({
        where: { id },
        data: { active: false, revision: { increment: 1 } },
      });
      await tx.configAudit.create({
        data: {
          tenantId: actor.tenantId,
          actorId: actor.id,
          entityId: id,
          action: "approval.delegation_revoked",
          detail: {},
        },
      });
      return { ok: true };
    });
  }
}

@Controller()
@UseGuards(SessionGuard)
export class RequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly tickets: TicketsService,
  ) {}
  @Get("requests/catalog") catalog(@Req() req: AuthRequest) {
    return this.requests.catalog(req.auth);
  }
  @Get("admin/request-items") items(@Req() req: AuthRequest) {
    return this.requests.items(req.auth);
  }
  @Post("admin/request-items") createItem(@Req() req: AuthRequest) {
    return this.requests.item(req.auth, req.body);
  }
  @Post("admin/request-items/:id") item(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.requests.item(req.auth, req.body, id);
  }
  @Post("requests") create(@Req() req: AuthRequest) {
    return this.requests.create(req.auth, req.body, req.headers["idempotency-key"]);
  }
  @Post("requests/:id/change") change(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.requests.change(req.auth, id, req.body);
  }
  @Get("admin/approval-corrections") corrections(@Req() req: AuthRequest) {
    return this.requests.corrections(req.auth);
  }
  @Post("requests/:id/correct-approvals") correct(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.requests.correct(req.auth, id, req.body);
  }
  @Get("approvals") queue(@Req() req: AuthRequest) {
    return this.requests.queue(req.auth);
  }
  @Post("approvals/:id/decision") decide(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.requests.decide(req.auth, id, req.body);
  }
  @Get("approvals/delegations") delegations(@Req() req: AuthRequest) {
    return this.requests.delegations(req.auth);
  }
  @Post("approvals/delegations") delegate(@Req() req: AuthRequest) {
    return this.requests.delegate(req.auth, req.body);
  }
  @Post("approvals/delegations/:id/revoke") revoke(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.requests.revoke(req.auth, id, req.body);
  }
  @Post("tickets/:id/manage") manage(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.tickets.manage(req.auth, id, req.body);
  }
  @Get("tickets/:id/assignment-options") assignmentOptions(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.tickets.assignmentOptions(req.auth, id);
  }
}
