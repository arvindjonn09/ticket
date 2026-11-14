import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type CatalogItem, type Ticket } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  addTargetMinutes,
  approvalPlan,
  eligibleApprover,
  canActApproval,
  canClaimTicket,
  canMessage,
  canReadTicket,
  hasActiveGroup,
  canTransition,
  isGroupAgent,
  effectiveDepartment,
  routeCategory,
  terminalStates,
  type Actor,
} from "@astrama/domain";
import {
  createTicketSchema,
  manageTicketSchema,
  messageSchema,
  revisionSchema,
  stateSchema,
  ticketQuerySchema,
  type TicketDetail,
  type TicketSummary,
} from "@astrama/contracts";
import {
  Database,
  lockConfiguration,
  lockConfigurationExclusive,
  type Tx,
} from "../../database.js";
import { makeSlaSnapshot } from "../sla/sla.policy.js";
export const ticketInclude = {
  category: true,
  subcategory: true,
  department: true,
  caller: true,
  submittedBy: true,
  assignedTo: true,
  requestedFor: true,
  item: true,
} satisfies Prisma.TicketInclude;
const include = ticketInclude;
export type RecordTicket = Prisma.TicketGetPayload<{ include: typeof include }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function decodeTicketCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      updatedAt: string;
      id: string;
    };
    const updatedAt = new Date(parsed.updatedAt);
    if (!uuid.test(parsed.id) || !Number.isFinite(updatedAt.getTime()))
      throw new Error("bad cursor");
    return { updatedAt, id: parsed.id };
  } catch {
    throw new BadRequestException("Invalid ticket page cursor");
  }
}
const encodeTicketCursor = (ticket: { updatedAt: Date; id: string }) =>
  Buffer.from(
    JSON.stringify({ updatedAt: ticket.updatedAt.toISOString(), id: ticket.id }),
  ).toString("base64url");
@Injectable()
export class TicketsService {
  constructor(private readonly db: Database) {}
  scoped<T>(
    actor: Actor,
    work: (tx: Tx, current: Actor) => Promise<T>,
    options: { approvals?: boolean; lock?: "shared" | "exclusive" | "none" } = {},
  ): Promise<T> {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      if (options.lock === "exclusive") await lockConfigurationExclusive(tx, actor.tenantId);
      else if (options.lock !== "none") await lockConfiguration(tx, actor.tenantId);
      const user = await tx.user.findFirst({
        where: { tenantId: actor.tenantId, id: actor.id, active: true },
        include: { memberships: { where: { department: { active: true } } } },
      });
      if (!user) throw new ForbiddenException("Active user required");
      const now = new Date();
      if ("sessionId" in actor) {
        const session = await tx.session.findFirst({
          where: {
            tenantId: actor.tenantId,
            id: actor.sessionId as string,
            userId: user.id,
            expiresAt: { gt: now },
          },
        });
        if (!session) throw new ForbiddenException("Session expired. Sign in again.");
        if (["admin", "agent"].includes(user.role) && (!session.mfaVerified || !user.mfaEnrolled))
          throw new ForbiddenException("MFA-enrolled support user required");
      }
      const approvalTicketIds: string[] = [];
      if (options.approvals) {
        const outgoing = await tx.approvalDelegation.count({
          where: {
            tenantId: actor.tenantId,
            approverId: actor.id,
            active: true,
            startsAt: { lte: now },
            endsAt: { gt: now },
          },
        });
        const delegations =
          user.approverEligible && !outgoing
            ? await tx.approvalDelegation.findMany({
                where: {
                  tenantId: actor.tenantId,
                  delegateId: actor.id,
                  active: true,
                  startsAt: { lte: now },
                  endsAt: { gt: now },
                },
              })
            : [];
        const approvals = user.approverEligible
          ? await tx.approval.findMany({
              where: {
                tenantId: actor.tenantId,
                approverId: { in: [actor.id, ...delegations.map((d) => d.approverId)] },
                status: { in: ["Pending", "Approved", "Rejected"] },
              },
              include: { approver: true, ticket: { include: { item: true } } },
            })
          : [];
        const requirementsByTicket = new Map<
          string,
          Promise<{ stage: string; approverId: string | null; correctionReason: string | null }[]>
        >();
        for (const approval of approvals) {
          if (
            approval.version !== approval.ticket.approvalVersion ||
            !canActApproval(
              actor.id,
              approval.approver,
              user,
              approval.ticket,
              approval.stage === "vp",
              delegations.find((d) => d.approverId === approval.approverId),
              now,
            )
          )
            continue;
          if (approval.status === "Pending") {
            const item = approval.ticket.item;
            if (!item) continue;
            let requirements = requirementsByTicket.get(approval.ticketId);
            if (!requirements) {
              requirements = this.approvalRequirements(tx, actor, approval.ticket, item);
              requirementsByTicket.set(approval.ticketId, requirements);
            }
            if (
              !(await requirements).some(
                (row) =>
                  row.stage === approval.stage &&
                  row.approverId === approval.approverId &&
                  !row.correctionReason,
              )
            )
              continue;
          }
          approvalTicketIds.push(approval.ticketId);
        }
      }
      return work(tx, {
        ...actor,
        role: user.role as Actor["role"],
        departmentIds: user.memberships.map((m) => m.departmentId),
        approvalTicketIds,
      });
    });
  }
  summary(ticket: RecordTicket): TicketSummary {
    return {
      id: ticket.id,
      number: ticket.number,
      summary: ticket.summary,
      description: ticket.description,
      state: ticket.state as TicketSummary["state"],
      priority: ticket.priority as TicketSummary["priority"],
      severity: ticket.severity,
      categoryId: ticket.categoryId,
      categoryName: ticket.category.name,
      subcategoryId: ticket.subcategoryId,
      subcategoryName: ticket.subcategory?.name ?? null,
      departmentId: ticket.departmentId,
      departmentName: ticket.department.name,
      callerId: ticket.callerId,
      callerName: ticket.caller.name,
      assignedToId: ticket.assignedToId,
      assignedToName: ticket.assignedTo?.name ?? null,
      revision: ticket.revision,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      type: ticket.type as "incident" | "request",
      requestedForId: ticket.requestedForId,
      requestedForName: ticket.requestedFor?.name ?? null,
      itemId: ticket.itemId,
      itemName: ticket.item?.name ?? null,
      quantity: ticket.quantity,
      unitCostMinor: ticket.unitCostMinor,
      totalCostMinor: ticket.totalCostMinor,
      currency: ticket.currency,
      justification: ticket.justification,
      approvalVersion: ticket.approvalVersion,
      approvalCorrectionReason: ticket.approvalCorrectionReason,
      untriaged: ticket.untriaged,
      channel: ticket.channel,
      holdReason: ticket.holdReason,
      previousState: ticket.previousState,
      submittedById: ticket.submittedById,
      submittedByName: ticket.submittedBy.name,
      duplicateOfId: ticket.duplicateOfId,
      slaFirstResponseDueAt: ticket.slaFirstResponseDueAt?.toISOString() ?? null,
      slaResolutionDueAt: ticket.slaResolutionDueAt?.toISOString() ?? null,
      slaFirstRespondedAt: ticket.slaFirstRespondedAt?.toISOString() ?? null,
      inboundUnverified: ticket.inboundUnverified,
    };
  }
  async record(tx: Tx, actor: Actor, id: string) {
    if (!uuid.test(id)) throw new NotFoundException("Ticket not found");
    const ticket = await tx.ticket.findFirst({ where: { tenantId: actor.tenantId, id }, include });
    if (!ticket || !canReadTicket(actor, ticket)) throw new NotFoundException("Ticket not found");
    return ticket;
  }
  async detail(tx: Tx, actor: Actor, ticket: RecordTicket): Promise<TicketDetail> {
    const activities = await tx.activity.findMany({
      where: {
        tenantId: actor.tenantId,
        ticketId: ticket.id,
        ...(isGroupAgent(actor, ticket) ? {} : { audience: "customer" }),
      },
      include: { author: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const approvals = await tx.approval.findMany({
      where: { tenantId: actor.tenantId, ticketId: ticket.id },
      include: { approver: true, decidedBy: true },
      orderBy: [{ version: "asc" }, { stage: "asc" }],
    });
    return {
      ...this.summary(ticket),
      inboundSenderEmail: isGroupAgent(actor, ticket) ? ticket.inboundSenderEmail : null,
      activities: activities.map((a) => ({
        id: a.id,
        body: a.body,
        audience: a.audience as "customer" | "internal",
        authorName: a.author.name,
        createdAt: a.createdAt.toISOString(),
      })),
      approvals: approvals.map((a) => ({
        id: a.id,
        stage: a.stage as "manager" | "vp",
        status: a.status as "Pending" | "Approved" | "Rejected" | "Invalidated",
        version: a.version,
        approverId: a.approverId,
        approverName: a.approver?.name ?? null,
        decidedById: a.decidedById,
        decidedByName: a.decidedBy?.name ?? null,
        comment: a.comment,
        decidedAt: a.decidedAt?.toISOString() ?? null,
        correctionReason: a.correctionReason,
      })),
    };
  }
  async catalog(actor: Actor) {
    return this.scoped(
      actor,
      async (tx, actor) => ({
        categories: (
          await tx.category.findMany({
            where: { tenantId: actor.tenantId, active: true },
            include: {
              department: true,
              subcategories: {
                where: { active: true },
                include: { department: true },
                orderBy: { name: "asc" },
              },
            },
            orderBy: { name: "asc" },
          })
        ).map((c) => ({
          id: c.id,
          name: c.name,
          departmentId: c.departmentId,
          departmentName: c.department.name,
          allowIncidents: c.allowIncidents,
          allowRequests: c.allowRequests,
          subcategories: c.subcategories.map((s) => ({
            id: s.id,
            name: s.name,
            departmentId: s.departmentId,
            departmentName: s.department?.name ?? c.department.name,
          })),
        })),
        departments: await tx.department.findMany({
          where: { tenantId: actor.tenantId, active: true },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
        agents:
          actor.role === "agent"
            ? await tx.user.findMany({
                where: {
                  tenantId: actor.tenantId,
                  active: true,
                  role: "agent",
                  memberships: {
                    some: {
                      departmentId: { in: actor.departmentIds },
                      department: { active: true },
                    },
                  },
                },
                select: { id: true, name: true },
                orderBy: { name: "asc" },
              })
            : [],
      }),
      { lock: "none" },
    );
  }
  async list(actor: Actor, query: unknown) {
    const input = ticketQuerySchema.parse(query);
    return this.scoped(
      actor,
      async (tx, actor) => {
        const own = [
          { callerId: actor.id },
          { submittedById: actor.id },
          { requestedForId: actor.id },
          { id: { in: actor.approvalTicketIds ?? [] } },
        ];
        const visible: Prisma.TicketWhereInput = {
          OR: [
            ...own,
            ...(hasActiveGroup(actor) ? [{ sensitive: false }] : []),
            ...(actor.role === "agent" && actor.departmentIds.length
              ? [{ departmentId: { in: actor.departmentIds } }]
              : []),
          ],
        };
        const cursor = decodeTicketCursor(input.cursor);
        const exactNumberSearch = /^(INC|SR)-?\d+$/i.test(input.search ?? "");
        const searchPage = input.search
          ? await tx.$queryRaw<{ id: string }[]>`
            SELECT ticket.id
            FROM public.tickets ticket
            LEFT JOIN public.users caller ON caller.tenant_id=ticket.tenant_id AND caller.id=ticket.caller_id
            LEFT JOIN public.users requested_for ON requested_for.tenant_id=ticket.tenant_id AND requested_for.id=ticket.requested_for_id
            WHERE ticket.tenant_id=${actor.tenantId}::uuid
              AND (
                ticket.caller_id=${actor.id}::uuid OR ticket.submitted_by_id=${actor.id}::uuid
                OR ticket.requested_for_id=${actor.id}::uuid OR ticket.id=ANY(${actor.approvalTicketIds ?? []}::uuid[])
                OR (${hasActiveGroup(actor)} AND ticket.sensitive=false)
                OR (${actor.role === "agent"} AND ticket.department_id=ANY(${actor.departmentIds}::uuid[]))
              )
              AND (${input.scope === "mine"} = false OR ticket.caller_id=${actor.id}::uuid OR ticket.submitted_by_id=${actor.id}::uuid OR ticket.requested_for_id=${actor.id}::uuid OR ticket.assigned_to_id=${actor.id}::uuid)
              AND (${input.state ?? null}::text IS NULL OR ticket.state=${input.state ?? null})
              AND (${input.priority ?? null}::text IS NULL OR ticket.priority=${input.priority ?? null})
              AND (${input.type ?? null}::text IS NULL OR ticket.type=${input.type ?? null})
              AND (${input.departmentId ?? null}::uuid IS NULL OR ticket.department_id=${input.departmentId ?? null}::uuid)
              AND (${input.categoryId ?? null}::uuid IS NULL OR ticket.category_id=${input.categoryId ?? null}::uuid)
              AND (${input.channel ?? null}::text IS NULL OR ticket.channel=${input.channel ?? null})
              AND (${input.assignedToId ?? null}::uuid IS NULL OR ticket.assigned_to_id=${input.assignedToId ?? null}::uuid)
              AND (${input.assigned === "unassigned"} = false OR ticket.assigned_to_id IS NULL)
              AND (${input.assigned === "me"} = false OR ticket.assigned_to_id=${actor.id}::uuid)
              AND (${input.untriaged === undefined ? null : input.untriaged === "true"}::boolean IS NULL OR ticket.untriaged=${input.untriaged === "true"})
              AND (${cursor?.updatedAt ?? null}::timestamptz IS NULL OR ticket.updated_at < ${cursor?.updatedAt ?? null}::timestamptz OR (ticket.updated_at=${cursor?.updatedAt ?? null}::timestamptz AND ticket.id>${cursor?.id ?? null}::uuid))
              AND (
                ticket.search_vector @@ plainto_tsquery('simple',${input.search})
                OR (${exactNumberSearch} AND lower(ticket.number)=lower(${input.search}))
                OR (NOT ${exactNumberSearch} AND (lower(ticket.number) LIKE '%' || lower(${input.search}) || '%' OR lower(ticket.number) % lower(${input.search})))
                OR lower(caller.name) LIKE '%' || lower(${input.search}) || '%'
                OR lower(caller.name) % lower(${input.search})
                OR lower(requested_for.name) LIKE '%' || lower(${input.search}) || '%'
                OR lower(requested_for.name) % lower(${input.search})
              )
            ORDER BY (lower(ticket.number)=lower(${input.search})) DESC,ticket.updated_at DESC,ticket.id ASC
            LIMIT ${input.limit + 1}
          `
          : null;
        const rows = searchPage
          ? await tx.ticket.findMany({
              where: {
                tenantId: actor.tenantId,
                id: { in: searchPage.slice(0, input.limit + 1).map((row) => row.id) },
              },
              include,
            })
          : await tx.ticket.findMany({
              where: {
                tenantId: actor.tenantId,
                AND: [
                  visible,
                  ...(input.scope === "mine"
                    ? [
                        {
                          OR: [
                            { callerId: actor.id },
                            { submittedById: actor.id },
                            { requestedForId: actor.id },
                            { assignedToId: actor.id },
                          ],
                        },
                      ]
                    : []),
                  ...(cursor
                    ? [
                        {
                          OR: [
                            { updatedAt: { lt: cursor.updatedAt } },
                            { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
                          ],
                        },
                      ]
                    : []),
                ],
                state: input.state,
                priority: input.priority,
                type: input.type,
                departmentId: input.departmentId,
                categoryId: input.categoryId,
                channel: input.channel,
                assignedToId:
                  input.assignedToId ??
                  (input.assigned === "unassigned"
                    ? null
                    : input.assigned === "me"
                      ? actor.id
                      : undefined),
                untriaged: input.untriaged === undefined ? undefined : input.untriaged === "true",
              },
              include,
              orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
              take: input.limit + 1,
            });
        if (searchPage) {
          const positions = new Map(searchPage.map((row, index) => [row.id, index]));
          rows.sort((left, right) => positions.get(left.id)! - positions.get(right.id)!);
        }
        const hasMore = (searchPage?.length ?? rows.length) > input.limit;
        const page = rows.slice(0, input.limit).filter((ticket) => canReadTicket(actor, ticket));
        return {
          tickets: page.map((ticket) => this.summary(ticket)),
          nextCursor: hasMore && page.length ? encodeTicketCursor(page[page.length - 1]!) : null,
          limitReached: hasMore,
        };
      },
      { lock: "none" },
    );
  }
  get(actor: Actor, id: string) {
    return this.scoped(
      actor,
      async (tx, actor) => this.detail(tx, actor, await this.record(tx, actor, id)),
      { approvals: true, lock: "none" },
    );
  }
  async event(
    tx: Tx,
    actor: Actor,
    ticketId: string,
    action: string,
    detail: Prisma.InputJsonObject = {},
  ) {
    const audit = await tx.audit.create({
      data: { tenantId: actor.tenantId, ticketId, actorId: actor.id, action, detail },
    });
    await tx.outbox.create({
      data: {
        tenantId: actor.tenantId,
        ticketId,
        event: action,
        payload: { auditId: audit.id, actorId: actor.id, ...detail },
      },
    });
  }
  async create(actor: Actor, body: unknown, key: unknown) {
    const input = createTicketSchema.parse(body);
    if (typeof key !== "string" || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new BadRequestException("A valid Idempotency-Key header is required");
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.scoped(actor, async (tx, actor) => {
      // One lock per actor/create key serializes concurrent retries without a failed transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.tenantId}:${actor.id}:incident.create:${key}`}, 0))`;
      const existing = await tx.idempotency.findUnique({
        where: {
          tenantId_actorId_operation_key: {
            tenantId: actor.tenantId,
            actorId: actor.id,
            operation: "incident.create",
            key,
          },
        },
      });
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new ConflictException("Idempotency key was used with different content");
        return this.detail(tx, actor, await this.record(tx, actor, existing.ticketId));
      }
      this.validateChannel(actor, input.channel);
      const callerId = input.callerId ?? actor.id;
      if (callerId !== actor.id && actor.role !== "agent")
        throw new ForbiddenException("Only support agents can submit incidents for another caller");
      if (
        !(await tx.user.findFirst({
          where: { tenantId: actor.tenantId, id: callerId, active: true },
        }))
      )
        throw new BadRequestException("Choose an active caller in this organisation");
      const route = await this.routing(
        tx,
        actor,
        input.categoryId,
        input.subcategoryId,
        "incident",
      );
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
      const [counter] = await tx.$queryRaw<
        { sequence: number }[]
      >`INSERT INTO counters(tenant_id, type, sequence) VALUES (${actor.tenantId}::uuid, 'incident', 1) ON CONFLICT (tenant_id, type) DO UPDATE SET sequence = counters.sequence + 1 RETURNING sequence`;
      if (!counter) throw new Error("Incident counter allocation failed");
      const now = new Date();
      const sla = await makeSlaSnapshot(tx, actor.tenantId, tenant.defaultPriority, now, true);
      const ticket = await tx.ticket.create({
        data: {
          tenantId: actor.tenantId,
          type: "incident",
          sequence: counter.sequence,
          number: `${tenant.incidentPrefix}${String(counter.sequence).padStart(4, "0")}`,
          ...input,
          subcategoryId: route.subcategoryId,
          departmentId: route.departmentId,
          sensitive: route.sensitive,
          callerId,
          submittedById: actor.id,
          priority: tenant.defaultPriority,
          severity: tenant.defaultSeverity,
          ...sla,
        },
        include,
      });
      await tx.idempotency.create({
        data: {
          tenantId: actor.tenantId,
          actorId: actor.id,
          operation: "incident.create",
          key,
          fingerprint,
          ticketId: ticket.id,
        },
      });
      await this.event(tx, actor, ticket.id, "incident.created", {
        departmentId: route.departmentId,
        routingException: route.exception,
        callerId,
        submittedById: actor.id,
        channel: input.channel,
      });
      return this.detail(tx, actor, ticket);
    });
  }
  validateChannel(actor: Actor, channel: string) {
    if (actor.role !== "agent" && channel !== "Self Service")
      throw new ForbiddenException("Only support agents can record assisted channels");
  }
  async conflict(tx: Tx, actor: Actor, id: string): Promise<never> {
    throw new ConflictException({
      message: "Ticket changed. Refresh and try again.",
      current: await this.detail(tx, actor, await this.record(tx, actor, id)),
    });
  }
  async update(
    tx: Tx,
    actor: Actor,
    ticket: RecordTicket,
    revision: number,
    data: Prisma.TicketUncheckedUpdateManyInput,
  ) {
    const changed = await tx.ticket.updateMany({
      where: { id: ticket.id, tenantId: actor.tenantId, revision },
      data: { ...data, revision: { increment: 1 }, updatedAt: new Date() },
    });
    if (changed.count !== 1) await this.conflict(tx, actor, ticket.id);
  }
  claim(actor: Actor, id: string, body: unknown) {
    const input = revisionSchema.parse(body);
    return this.scoped(actor, async (tx, actor) => {
      const ticket = await this.record(tx, actor, id);
      if (!isGroupAgent(actor, ticket))
        throw new ForbiddenException("Only an agent in the assigned group can claim this ticket");
      if (ticket.revision !== input.revision || ticket.assignedToId)
        return this.conflict(tx, actor, id);
      if (!canClaimTicket(actor, ticket))
        throw new ForbiddenException("This ticket cannot be claimed");
      await this.update(tx, actor, ticket, input.revision, { assignedToId: actor.id });
      await this.event(tx, actor, id, "incident.claimed", { assignedToId: actor.id });
      return this.detail(tx, actor, await this.record(tx, actor, id));
    });
  }
  message(actor: Actor, id: string, body: unknown) {
    const input = messageSchema.parse(body);
    return this.scoped(actor, async (tx, actor) => {
      const ticket = await this.record(tx, actor, id);
      if (!canMessage(actor, ticket, input.audience))
        throw new ForbiddenException("This message is not permitted");
      const resumes =
        input.audience === "customer" &&
        [ticket.callerId, ticket.submittedById, ticket.requestedForId].includes(actor.id) &&
        ticket.state === "On Hold" &&
        ticket.holdReason === "Awaiting customer";
      await this.update(
        tx,
        actor,
        ticket,
        input.revision,
        resumes
          ? { state: ticket.previousState ?? "Open", holdReason: null, previousState: null }
          : {},
      );
      if (resumes)
        await this.event(tx, actor, id, "ticket.resumed", {
          from: "On Hold",
          to: ticket.previousState ?? "Open",
        });
      const activity = await tx.activity.create({
        data: {
          tenantId: actor.tenantId,
          ticketId: id,
          authorId: actor.id,
          body: input.body,
          audience: input.audience,
        },
      });
      if (input.audience === "customer" && actor.role === "agent" && !ticket.slaFirstRespondedAt)
        await tx.ticket.update({
          where: { id: ticket.id },
          data: { slaFirstRespondedAt: activity.createdAt },
        });
      await this.event(tx, actor, id, "incident.message", {
        activityId: activity.id,
        audience: input.audience,
      });
      return this.detail(tx, actor, await this.record(tx, actor, id));
    });
  }
  state(actor: Actor, id: string, body: unknown) {
    const input = stateSchema.parse(body);
    return this.scoped(actor, async (tx, actor) => {
      const ticket = await this.record(tx, actor, id);
      if (
        !isGroupAgent(actor, ticket) &&
        ![ticket.callerId, ticket.submittedById].includes(actor.id)
      )
        throw new ForbiddenException("This state transition is not permitted");
      if (ticket.revision !== input.revision) return this.conflict(tx, actor, id);
      if (
        ticket.type === "request" &&
        ticket.item &&
        ["In Progress", "Complete"].includes(input.state) &&
        !terminalStates.includes(ticket.state) &&
        !(await this.approvalsMatch(tx, actor, ticket, ticket.item))
      ) {
        await this.update(tx, actor, ticket, input.revision, {});
        await this.evaluateApprovals(tx, actor, ticket, ticket.item);
        return { stalePolicy: true as const };
      }
      if (!canTransition(actor, ticket, input.state))
        throw new ForbiddenException("This state transition is not permitted");
      const resolves =
        input.state === "Resolved" || (ticket.type === "request" && input.state === "Complete");
      const reopens = ticket.state === "Resolved" && !terminalStates.includes(input.state);
      if (resolves && (!input.resolution || !input.customerSummary))
        throw new BadRequestException("Internal resolution and customer summary are required");
      if (!resolves && (input.resolution || input.customerSummary))
        throw new BadRequestException(
          "Resolution fields are only allowed when resolving or fulfilling a ticket",
        );
      if (input.state === "On Hold" && !input.holdReason)
        throw new BadRequestException("Hold reason is required");
      if (input.state === "Cancelled" && !input.reason)
        throw new BadRequestException("Cancellation reason is required");
      if (input.duplicateOfId) {
        if (input.state !== "Cancelled" || input.duplicateOfId === id)
          throw new BadRequestException("Duplicate link requires cancellation and another ticket");
        await this.record(tx, actor, input.duplicateOfId);
      }
      if (
        ticket.type === "request" &&
        ["In Progress", "Complete"].includes(input.state) &&
        (await tx.approval.count({
          where: {
            tenantId: actor.tenantId,
            ticketId: id,
            version: ticket.approvalVersion,
            status: { not: "Approved" },
          },
        }))
      )
        throw new ForbiddenException("All required approvals must succeed before fulfilment");
      const reopenTime = new Date();
      const reopenCalendar = ticket.slaCalendar as unknown as
        import("@astrama/domain").HourCalendar | null;
      const reopenedSla =
        reopens && reopenCalendar && ticket.slaResolutionTargetMinutes && ticket.slaCalendarType
          ? {
              slaResolutionStartedAt: reopenTime,
              slaResolutionDueAt: addTargetMinutes(
                reopenTime,
                ticket.slaResolutionTargetMinutes,
                reopenCalendar,
                ticket.slaCalendarType as "business" | "24x7",
              ),
            }
          : null;
      await this.update(tx, actor, ticket, input.revision, {
        state: input.state,
        ...(resolves
          ? {
              slaResolvedAt: new Date(),
              ...(actor.role === "agent" && !ticket.slaFirstRespondedAt
                ? { slaFirstRespondedAt: new Date() }
                : {}),
            }
          : {}),
        ...(reopenedSla
          ? {
              slaResolutionDueAt: reopenedSla.slaResolutionDueAt,
              slaResolutionStartedAt: reopenedSla.slaResolutionStartedAt,
              slaResolvedAt: null,
            }
          : {}),
        ...(resolves ? { resolution: input.resolution } : {}),
        ...(input.state === "On Hold"
          ? { holdReason: input.holdReason, previousState: ticket.state }
          : ticket.state === "On Hold"
            ? { holdReason: null, previousState: null }
            : {}),
        ...(input.duplicateOfId ? { duplicateOfId: input.duplicateOfId } : {}),
      });
      if (input.state === "Cancelled")
        await tx.approval.updateMany({
          where: { tenantId: actor.tenantId, ticketId: id, status: "Pending" },
          data: { status: "Invalidated" },
        });
      if (input.state === "Cancelled" || input.state === "On Hold")
        await tx.activity.create({
          data: {
            tenantId: actor.tenantId,
            ticketId: id,
            authorId: actor.id,
            audience: "customer",
            body: input.state === "Cancelled" ? input.reason! : input.holdReason!,
          },
        });
      if (resolves) {
        await tx.activity.createMany({
          data: [
            {
              tenantId: actor.tenantId,
              ticketId: id,
              authorId: actor.id,
              body: input.resolution!,
              audience: "internal",
            },
            {
              tenantId: actor.tenantId,
              ticketId: id,
              authorId: actor.id,
              body: input.customerSummary!,
              audience: "customer",
            },
          ],
        });
      }
      await this.event(tx, actor, id, "incident.state", {
        from: ticket.state,
        to: input.state,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.holdReason ? { holdReason: input.holdReason } : {}),
      });
      return this.detail(tx, actor, await this.record(tx, actor, id));
    }).then((result) => {
      if ("stalePolicy" in result)
        throw new ConflictException(
          "Approval authority changed. The request was re-evaluated; refresh before fulfilment.",
        );
      return result;
    });
  }
  async approvalRequirements(tx: Tx, actor: Actor, ticket: Ticket, item: CatalogItem) {
    const recipient = await tx.user.findFirst({
      where: { tenantId: actor.tenantId, id: ticket.requestedForId!, active: true },
      include: { manager: true },
    });
    const alternate = item.alternateApproverId
      ? await tx.user.findFirst({
          where: { tenantId: actor.tenantId, id: item.alternateApproverId },
        })
      : null;
    const vps = await tx.user.findMany({
      where: {
        tenantId: actor.tenantId,
        active: true,
        approverEligible: true,
        isVp: true,
        ...(item.vpApproverId ? { id: item.vpApproverId } : {}),
      },
      orderBy: { id: "asc" },
      take: 2,
    });
    const select = (candidate: typeof alternate, vp: boolean) =>
      eligibleApprover(candidate, ticket.callerId, ticket.requestedForId!, vp)
        ? candidate
        : eligibleApprover(alternate, ticket.callerId, ticket.requestedForId!, vp)
          ? alternate
          : null;
    const manager = select(recipient?.manager ?? null, false),
      vp = select(vps.length === 1 ? vps[0]! : null, true),
      plan = approvalPlan(item, ticket.totalCostMinor!);
    const rows: { stage: string; approverId: string | null; correctionReason: string | null }[] =
      [];
    if (plan.manager && !(plan.vp && manager && vp && manager.id === vp.id))
      rows.push({
        stage: "manager",
        approverId: manager?.id ?? null,
        correctionReason: !recipient
          ? "Requested-for user is inactive"
          : !manager
            ? "Missing eligible manager or alternate"
            : null,
      });
    if (plan.vp)
      rows.push({
        stage: "vp",
        approverId: vp?.id ?? null,
        correctionReason: !recipient
          ? "Requested-for user is inactive"
          : !vp
            ? "Missing eligible VP or VP alternate"
            : null,
      });
    return rows;
  }
  async approvalsMatch(tx: Tx, actor: Actor, ticket: Ticket, item: CatalogItem) {
    const expected = await this.approvalRequirements(tx, actor, ticket, item),
      current = await tx.approval.findMany({
        where: { tenantId: actor.tenantId, ticketId: ticket.id, version: ticket.approvalVersion },
      });
    return (
      expected.length === current.length &&
      expected.every((e) =>
        current.some(
          (c) =>
            c.stage === e.stage &&
            c.approverId === e.approverId &&
            c.correctionReason === e.correctionReason,
        ),
      )
    );
  }
  async evaluateApprovals(tx: Tx, actor: Actor, ticket: Ticket, item: CatalogItem) {
    const rows = await this.approvalRequirements(tx, actor, ticket, item),
      version = ticket.approvalVersion + 1;
    await tx.approval.updateMany({
      where: { tenantId: actor.tenantId, ticketId: ticket.id, status: { not: "Invalidated" } },
      data: { status: "Invalidated" },
    });
    if (rows.length)
      await tx.approval.createMany({
        data: rows.map((r) => ({ ...r, tenantId: actor.tenantId, ticketId: ticket.id, version })),
      });
    const correction =
      rows
        .map((r) => r.correctionReason)
        .filter(Boolean)
        .join("; ") || null;
    await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        approvalVersion: version,
        state: rows.length ? "Pending Approval" : "Open",
        approvalCorrectionReason: correction,
        holdReason: null,
        previousState: null,
      },
    });
    if (correction)
      await this.event(tx, actor, ticket.id, "request.approval_correction", { reason: correction });
    await this.event(tx, actor, ticket.id, "request.approvals_evaluated", {
      version,
      stages: rows.map((r) => r.stage),
    });
  }
  async routing(
    tx: Tx,
    actor: Actor,
    categoryId: string,
    subcategoryId: string | undefined,
    type: string,
  ) {
    const category = await tx.category.findFirst({
      where: {
        tenantId: actor.tenantId,
        id: categoryId,
        active: true,
        ...(type === "request" ? { allowRequests: true } : { allowIncidents: true }),
      },
      include: { department: true },
    });
    if (!category) throw new BadRequestException("Choose an active applicable category");
    const subcategory = subcategoryId
      ? await tx.subcategory.findFirst({
          where: { tenantId: actor.tenantId, id: subcategoryId, categoryId, active: true },
          include: { department: true },
        })
      : null;
    if (subcategoryId && !subcategory)
      throw new BadRequestException("Choose a subcategory belonging to the category");
    const departmentId = effectiveDepartment(category.departmentId, subcategory?.departmentId),
      destination = subcategory?.department ?? category.department;
    const staffed =
      destination.active &&
      (await tx.membership.count({
        where: { tenantId: actor.tenantId, departmentId, user: { active: true, role: "agent" } },
      })) > 0;
    const triage = staffed
      ? null
      : await tx.department.findFirst({
          where: {
            tenantId: actor.tenantId,
            active: true,
            isTriage: true,
            memberships: { some: { user: { active: true, role: "agent" } } },
          },
        });
    if (!staffed && !triage) throw new ConflictException("No staffed routing queue is available");
    return {
      category,
      subcategoryId: subcategory?.id ?? null,
      ...routeCategory({ ...category, departmentId }, staffed, triage?.id ?? departmentId),
    };
  }
  manage(actor: Actor, id: string, body: unknown) {
    const input = manageTicketSchema.parse(body);
    return this.scoped(actor, async (tx, actor) => {
      const ticket = await this.record(tx, actor, id);
      if (
        (!isGroupAgent(actor, ticket) && !(input.action === "transfer" && hasActiveGroup(actor))) ||
        terminalStates.includes(ticket.state)
      )
        throw new ForbiddenException(
          "An agent in the assigned group and an active ticket are required",
        );
      if (ticket.revision !== input.revision) return this.conflict(tx, actor, id);
      const data: Prisma.TicketUncheckedUpdateManyInput = {};
      let routingException = false;
      let slaAudit: Prisma.InputJsonObject | undefined;
      if (input.action === "triage") {
        if (!input.priority || !input.severity)
          throw new BadRequestException("Priority and severity are required");
        Object.assign(data, {
          priority: input.priority,
          severity: input.severity,
          untriaged: false,
        });
        if (input.priority !== ticket.priority) {
          const snapshot = await makeSlaSnapshot(
            tx,
            actor.tenantId,
            input.priority,
            ticket.createdAt,
            false,
            ticket.slaResolutionStartedAt ?? ticket.createdAt,
          );
          Object.assign(data, snapshot);
          slaAudit = {
            old: {
              firstResponseDueAt: ticket.slaFirstResponseDueAt?.toISOString() ?? null,
              resolutionDueAt: ticket.slaResolutionDueAt?.toISOString() ?? null,
            },
            new: {
              firstResponseDueAt: snapshot.slaFirstResponseDueAt.toISOString(),
              resolutionDueAt: snapshot.slaResolutionDueAt.toISOString(),
            },
          };
        }
      } else if (input.action === "assign") {
        if (![ticket.department.queueOwnerId, ticket.department.substituteId].includes(actor.id))
          throw new ForbiddenException("Queue owner or substitute required");
        if (input.assignedToId === undefined)
          throw new BadRequestException("Choose an assignee or unassign");
        if (
          input.assignedToId &&
          !(await tx.membership.findFirst({
            where: {
              tenantId: actor.tenantId,
              departmentId: ticket.departmentId,
              userId: input.assignedToId,
              user: { active: true, role: "agent" },
              department: { active: true },
            },
          }))
        )
          throw new BadRequestException("Assignee must be an active agent in the assigned group");
        data.assignedToId = input.assignedToId;
      } else {
        let destinationId: string;
        if (input.action === "category") {
          if (!input.categoryId) throw new BadRequestException("Category is required");
          const route = await this.routing(
            tx,
            actor,
            input.categoryId,
            input.subcategoryId,
            ticket.type,
          );
          routingException = route.exception;
          destinationId = route.departmentId;
          Object.assign(data, {
            categoryId: input.categoryId,
            subcategoryId: route.subcategoryId,
            sensitive: ticket.sensitive || route.sensitive,
          });
        } else {
          if (
            !input.departmentId ||
            !(await tx.department.findFirst({
              where: {
                tenantId: actor.tenantId,
                id: input.departmentId,
                active: true,
                memberships: { some: { user: { active: true, role: "agent" } } },
              },
            }))
          )
            throw new BadRequestException("Choose a staffed active destination group");
          destinationId = input.departmentId;
        }
        data.departmentId = destinationId;
        if (
          ticket.assignedToId &&
          !(await tx.membership.findFirst({
            where: {
              tenantId: actor.tenantId,
              departmentId: destinationId,
              userId: ticket.assignedToId,
              user: { active: true, role: "agent" },
            },
          }))
        )
          data.assignedToId = null;
      }
      await this.update(tx, actor, ticket, input.revision, data);
      await this.event(tx, actor, id, `ticket.${input.action}`, {
        reason: input.reason,
        fromDepartmentId: ticket.departmentId,
        ...(input.action === "category" ? { routingException } : {}),
        ...(typeof data.departmentId === "string" ? { departmentId: data.departmentId } : {}),
        ...(typeof data.priority === "string"
          ? { priority: data.priority, severity: input.severity }
          : {}),
        ...(input.action === "triage" && input.priority !== ticket.priority && slaAudit
          ? { slaDueDates: slaAudit }
          : {}),
        ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
      });
      return this.detail(tx, actor, await tx.ticket.findUniqueOrThrow({ where: { id }, include }));
    });
  }
  assignmentOptions(actor: Actor, id: string) {
    return this.scoped(actor, async (tx, actor) => {
      const ticket = await this.record(tx, actor, id);
      if (!isGroupAgent(actor, ticket))
        throw new ForbiddenException("Assigned-group agent required");
      return {
        users: await tx.user.findMany({
          where: {
            tenantId: actor.tenantId,
            active: true,
            role: "agent",
            memberships: {
              some: { departmentId: ticket.departmentId, department: { active: true } },
            },
          },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
        canAssign: [ticket.department.queueOwnerId, ticket.department.substituteId].includes(
          actor.id,
        ),
      };
    });
  }
}
