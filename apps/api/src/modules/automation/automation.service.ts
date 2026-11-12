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
import { automationSettingsSchema, type AutomationSettingsView } from "@astrama/contracts";
import { canConfigureOrganisation, elapsedBusinessDays, type Actor } from "@astrama/domain";
import { SessionGuard, type AuthContext, type AuthRequest } from "../auth/auth.service.js";
import { Database, lockConfiguration, type Tx } from "../../database.js";
import { TicketsService } from "../tickets/tickets.service.js";

type SettingsRow = {
  enabled: boolean;
  working_weekdays: number[];
  holidays: string[];
  reminder_days: number;
  escalation_days: number;
  auto_close_days: number;
  responsible_admin_id: string;
  revision: number;
};
const defaults = {
  enabled: false,
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: [],
  reminderDays: 2,
  escalationDays: 5,
  autoCloseDays: 5,
  revision: 0,
  responsibleAdminId: null,
};

@Injectable()
export class AutomationService {
  constructor(
    private readonly db: Database,
    private readonly tickets: TicketsService,
  ) {}
  private admin(auth: AuthContext, actor: Actor) {
    if (!canConfigureOrganisation({ ...actor, mfaVerified: auth.view.mfaVerified }))
      throw new ForbiddenException("MFA-verified administrator required");
  }
  private async settings(tx: Tx, tenantId: string): Promise<AutomationSettingsView> {
    const [row] = await tx.$queryRaw<
      SettingsRow[]
    >`SELECT * FROM automation_settings WHERE tenant_id=${tenantId}::uuid`;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    return {
      ...(row
        ? {
            enabled: row.enabled,
            workingWeekdays: row.working_weekdays,
            holidays: row.holidays,
            reminderDays: row.reminder_days,
            escalationDays: row.escalation_days,
            autoCloseDays: row.auto_close_days,
            responsibleAdminId: row.responsible_admin_id,
            revision: row.revision,
          }
        : defaults),
      timezone: tenant.timezone,
    };
  }
  get(auth: AuthContext) {
    return this.tickets.scoped(auth, async (tx, actor) => {
      this.admin(auth, actor);
      return this.settings(tx, actor.tenantId);
    });
  }
  save(auth: AuthContext, body: unknown) {
    const input = automationSettingsSchema.parse(body);
    return this.tickets.scoped(auth, async (tx, actor) => {
      this.admin(auth, actor);
      const before = await this.settings(tx, actor.tenantId);
      if (before.revision !== input.revision)
        throw new ConflictException({
          message: "Automation settings changed. Refresh and try again.",
          current: before,
        });
      await tx.$executeRaw`INSERT INTO automation_settings(tenant_id,enabled,working_weekdays,holidays,reminder_days,escalation_days,auto_close_days,responsible_admin_id,revision)
        VALUES(${actor.tenantId}::uuid,${input.enabled},${input.workingWeekdays}::integer[],${input.holidays}::text[],${input.reminderDays},${input.escalationDays},${input.autoCloseDays},${actor.id}::uuid,${input.revision + 1})
        ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,working_weekdays=EXCLUDED.working_weekdays,holidays=EXCLUDED.holidays,reminder_days=EXCLUDED.reminder_days,escalation_days=EXCLUDED.escalation_days,auto_close_days=EXCLUDED.auto_close_days,responsible_admin_id=EXCLUDED.responsible_admin_id,revision=EXCLUDED.revision`;
      const after = await this.settings(tx, actor.tenantId);
      await tx.configAudit.create({
        data: {
          tenantId: actor.tenantId,
          actorId: actor.id,
          entityId: actor.tenantId,
          action: "automation.settings_updated",
          detail: { before, after },
        },
      });
      return after;
    });
  }
  async dispatch(now = new Date()) {
    const tenants = await this.db.$queryRaw<
      { tenant_id: string }[]
    >`SELECT * FROM pending_automation_tenants()`;
    for (const { tenant_id: tenantId } of tenants) {
      try {
        // ponytail: scan active waiting/resolved tickets per tenant; persist indexed due times if measured volume requires it.
        const candidates = await this.db.withTenant(tenantId, (tx) =>
          tx.ticket.findMany({
            where: { tenantId, state: { in: ["Pending Approval", "Resolved"] } },
            select: { id: true },
          }),
        );
        for (const ticket of candidates) await this.tick(tenantId, ticket.id, now);
      } catch (error) {
        if (!(error instanceof Error && error.message === "Tenant unavailable")) throw error;
      }
    }
  }
  async tick(tenantId: string, ticketId: string, now = new Date()) {
    return this.db.withTenant(tenantId, async (tx) => {
      await lockConfiguration(tx, tenantId);
      if (!(await tx.tenant.findFirst({ where: { id: tenantId, active: true } }))) return;
      const settings = await this.settings(tx, tenantId);
      if (!settings.enabled || !settings.responsibleAdminId) return;
      const responsible = await tx.user.findFirst({
        where: { tenantId, id: settings.responsibleAdminId, role: "admin", active: true },
      });
      if (!responsible) return; // Reassign responsibility by saving settings before automation resumes.
      const actor: Actor = { tenantId, id: responsible.id, role: "admin", departmentIds: [] };
      const ticket = await tx.ticket.findFirst({
        where: { tenantId, id: ticketId, state: { in: ["Pending Approval", "Resolved"] } },
        include: { item: true },
      });
      if (!ticket) return;
      const once = async (
        kind: string,
        stage: string,
        detail: Record<string, string | number | boolean>,
      ) => {
        const inserted =
          await tx.$executeRaw`INSERT INTO automation_actions(tenant_id,ticket_id,approval_version,stage,kind) VALUES(${tenantId}::uuid,${ticketId}::uuid,${ticket.approvalVersion},${stage},${kind}) ON CONFLICT DO NOTHING`;
        if (inserted)
          await this.tickets.event(tx, actor, ticketId, `automation.${kind}`, {
            ...detail,
            automation: true,
            responsibleAdminId: actor.id,
            trigger: "business_calendar",
            calendarRevision: settings.revision,
          });
      };
      if (ticket.state === "Resolved") {
        if (ticket.type !== "incident") return;
        const transition = await tx.audit.findFirst({
          where: {
            tenantId,
            ticketId,
            action: "incident.state",
            detail: { path: ["to"], equals: "Resolved" },
          },
          orderBy: { createdAt: "desc" },
        });
        if (
          !transition ||
          elapsedBusinessDays(transition.createdAt, now, settings) < settings.autoCloseDays
        )
          return;
        await tx.ticket.update({
          where: { id: ticketId },
          data: { state: "Complete", revision: { increment: 1 }, updatedAt: now },
        });
        await once("auto_completed", "", {
          from: "Resolved",
          to: "Complete",
          resolutionAuditId: transition.id,
          audience: "customer",
        });
        return;
      }
      if (!ticket.item || !(await this.tickets.approvalsMatch(tx, actor, ticket, ticket.item)))
        return;
      const approvals = await tx.approval.findMany({
        where: { tenantId, ticketId, version: ticket.approvalVersion },
      });
      const approval =
        approvals.find((a) => a.stage === "manager" && a.status === "Pending") ??
        approvals.find((a) => a.stage === "vp" && a.status === "Pending");
      if (!approval?.approverId || approval.correctionReason || ticket.approvalCorrectionReason)
        return;
      if (
        approval.stage === "vp" &&
        approvals.some((a) => a.stage === "manager" && a.status !== "Approved")
      )
        return;
      const evaluated = await tx.audit.findFirst({
        where: {
          tenantId,
          ticketId,
          action: "request.approvals_evaluated",
          detail: { path: ["version"], equals: ticket.approvalVersion },
        },
        orderBy: { createdAt: "desc" },
      });
      if (!evaluated) return;
      const manager = approvals.find((a) => a.stage === "manager");
      const since =
        approval.stage === "vp" && manager?.decidedAt && manager.decidedAt > evaluated.createdAt
          ? manager.decidedAt
          : evaluated.createdAt;
      const elapsed = elapsedBusinessDays(since, now, settings);
      const detail = {
        approvalId: approval.id,
        approvalVersion: ticket.approvalVersion,
        stage: approval.stage,
      };
      if (elapsed >= settings.reminderDays)
        await once("approval_reminder", approval.stage, {
          ...detail,
          kind: "approval_reminder",
          target: "approver",
        });
      if (elapsed >= settings.escalationDays)
        await once("approval_escalation", approval.stage, {
          ...detail,
          kind: "approval_escalation",
          target: "owner_admin",
        });
    });
  }
}

@Controller("admin/automation")
@UseGuards(SessionGuard)
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}
  @Get() get(@Req() request: AuthRequest) {
    return this.automation.get(request.auth!);
  }
  @Post() save(@Req() request: AuthRequest) {
    return this.automation.save(request.auth!, request.body);
  }
}
