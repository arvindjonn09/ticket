import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { elapsedBusinessMinutes, type HourCalendar } from "@astrama/domain";
import { Prisma } from "@prisma/client";
import { slaSettingsSchema, type SlaSettingsView } from "@astrama/contracts";
import { canConfigureOrganisation, type Actor } from "@astrama/domain";
import { Database, lockConfiguration, type Tx } from "../../database.js";
import { SessionGuard, type AuthContext, type AuthRequest } from "../auth/auth.service.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { readSlaSettings } from "./sla.policy.js";

@Injectable()
export class SlaService {
  constructor(
    private readonly db: Database,
    private readonly tickets: TicketsService,
  ) {}

  private admin(auth: AuthContext, actor: Actor) {
    if (!canConfigureOrganisation({ ...actor, mfaVerified: auth.view.mfaVerified }))
      throw new ForbiddenException("MFA-verified administrator required");
  }

  async settings(tx: Tx, tenantId: string): Promise<SlaSettingsView> {
    return readSlaSettings(tx, tenantId);
  }

  get(auth: AuthContext) {
    return this.tickets.scoped(
      auth,
      async (tx, actor) => {
        this.admin(auth, actor);
        return this.settings(tx, actor.tenantId);
      },
      { lock: "none" },
    );
  }

  save(auth: AuthContext, body: unknown) {
    const input = slaSettingsSchema.parse(body);
    return this.tickets.scoped(
      auth,
      async (tx, actor) => {
        this.admin(auth, actor);
        const before = await this.settings(tx, actor.tenantId);
        if (before.revision !== input.revision)
          throw new ConflictException({
            message: "SLA settings changed. Refresh and try again.",
            current: before,
          });
        const revision = input.revision + 1;
        const stored = { ...input, revision };
        await tx.slaSettings.upsert({
          where: { tenantId: actor.tenantId },
          create: { tenantId: actor.tenantId, revision, settings: stored as Prisma.InputJsonValue },
          update: { revision, settings: stored as Prisma.InputJsonValue, updatedAt: new Date() },
        });
        const after = await this.settings(tx, actor.tenantId);
        await tx.configAudit.create({
          data: {
            tenantId: actor.tenantId,
            actorId: actor.id,
            entityId: actor.tenantId,
            action: "sla.settings_updated",
            detail: { before, after },
          },
        });
        return after;
      },
      { lock: "exclusive" },
    );
  }

  async dispatch(now = new Date()) {
    const tenants = await this.db.$queryRaw<
      { tenant_id: string }[]
    >`SELECT * FROM pending_sla_tenants()`;
    for (const { tenant_id: tenantId } of tenants) {
      try {
        await this.db.withTenant(tenantId, async (tx) => {
          await lockConfiguration(tx, tenantId);
          let cursor: string | undefined;
          while (true) {
            const tickets = await tx.ticket.findMany({
              where: {
                tenantId,
                OR: [
                  { slaFirstRespondedAt: null, slaFirstResponseDueAt: { not: null } },
                  {
                    slaResolvedAt: null,
                    slaResolutionDueAt: { not: null },
                    state: { notIn: ["Resolved", "Complete", "Cancelled", "Rejected"] },
                  },
                ],
              },
              orderBy: { id: "asc" },
              take: 500,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
            if (!tickets.length) break;
            for (const ticket of tickets) {
              if (!ticket.slaCalendar || !ticket.slaCalendarType) continue;
              const calendar = ticket.slaCalendar as unknown as HourCalendar;
              const checks = [
                {
                  name: "first_response",
                  start: ticket.createdAt,
                  target: ticket.slaFirstResponseTargetMinutes,
                  due: ticket.slaFirstResponseDueAt,
                  done: !!ticket.slaFirstRespondedAt,
                  active: true,
                },
                {
                  name: "resolution",
                  start: ticket.slaResolutionStartedAt ?? ticket.createdAt,
                  target: ticket.slaResolutionTargetMinutes,
                  due: ticket.slaResolutionDueAt,
                  done: !!ticket.slaResolvedAt,
                  active: !["Resolved", "Complete", "Cancelled", "Rejected"].includes(ticket.state),
                },
              ];
              for (const check of checks) {
                if (check.done || !check.active || !check.target || !check.due) continue;
                const mode =
                  check.name === "first_response"
                    ? (ticket.slaFirstResponseCalendarType ?? ticket.slaCalendarType)
                    : ticket.slaCalendarType;
                const elapsed =
                  mode === "24x7"
                    ? Math.max(0, (now.getTime() - check.start.getTime()) / 60000)
                    : elapsedBusinessMinutes(check.start, now, calendar);
                const stage =
                  now >= check.due ? "breach" : elapsed >= check.target * 0.75 ? "warning" : null;
                if (!stage) continue;
                const inserted = await tx.slaAlert.createMany({
                  data: [
                    {
                      tenantId,
                      ticketId: ticket.id,
                      target: check.name,
                      stage,
                      cycleStartedAt: check.start,
                    },
                  ],
                  skipDuplicates: true,
                });
                if (!inserted.count) continue;
                await tx.outbox.create({
                  data: {
                    tenantId,
                    ticketId: ticket.id,
                    event: `sla.${stage}`,
                    payload: { kind: "sla", target: check.name, stage, audience: "internal" },
                  },
                });
              }
            }
            cursor = tickets[tickets.length - 1]!.id;
            if (tickets.length < 500) break;
          }
        });
      } catch (error) {
        if (!(error instanceof Error && error.message === "Tenant unavailable")) throw error;
      }
    }
  }
}

@Controller("admin/sla")
@UseGuards(SessionGuard)
export class SlaController {
  constructor(private readonly service: SlaService) {}
  @Get() get(@Req() req: AuthRequest) {
    return this.service.get(req.auth);
  }
  @Post() save(@Req() req: AuthRequest) {
    return this.service.save(req.auth, req.body);
  }
}
