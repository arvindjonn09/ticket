import { createTransport } from "nodemailer";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { canActApproval, canReadTicket, isGroupAgent } from "@astrama/domain";
import { Database, lockConfiguration } from "../../database.js";
import { InvitationMailer } from "../../invitation-mail.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { RecoveryMailer } from "../../recovery-mail.js";
import { AutomationService } from "../automation/automation.service.js";
import { SlaService } from "../sla/sla.service.js";
import { InboundMailService } from "../inbound-mail/inbound-mail.service.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac, randomUUID } from "node:crypto";
import { encryptionKey } from "../../mfa.js";
import { replyTokenHash } from "../inbound-mail/inbound-mail.adapter.js";

const jobSchema = z.object({ tenantId: z.string().uuid(), eventId: z.string().uuid() }).strict();
const queue = "ticket-notification";
export class NotificationWorker {
  private readonly boss: PgBoss;
  private readonly mail = createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: process.env.SMTP_SECURE === "true",
    requireTLS: process.env.NODE_ENV === "production" && process.env.SMTP_SECURE !== "true",
    ...(process.env.SMTP_USER
      ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } }
      : {}),
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });
  private timer?: NodeJS.Timeout;
  private dispatching = false;
  private readonly invitations: InvitationMailer;
  private readonly recovery: RecoveryMailer;
  private readonly tickets: TicketsService;
  private readonly automation: AutomationService;
  private readonly sla: SlaService;
  private readonly inbound: InboundMailService;
  private lastAutomationAt = 0;
  private lastSlaAt = 0;
  private lastDigestAt = 0;
  constructor(private readonly db: Database) {
    this.tickets = new TicketsService(db);
    this.invitations = new InvitationMailer(db);
    this.recovery = new RecoveryMailer(db);
    this.automation = new AutomationService(db, this.tickets);
    this.sla = new SlaService(db, this.tickets);
    this.inbound = new InboundMailService(db, this.tickets);
    if (
      !process.env.DATABASE_URL ||
      !process.env.SMTP_HOST ||
      !process.env.SMTP_FROM ||
      !process.env.APP_ORIGIN
    )
      throw new Error("Notification worker configuration is incomplete");
    // Bootstrap owns schema creation; the worker has no database-wide CREATE privilege.
    this.boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      schema: "pgboss",
      createSchema: false,
    });
    this.boss.on("error", () =>
      console.error(JSON.stringify({ event: "notification.queue.error" })),
    );
  }
  async start() {
    await this.db.assertRuntimeRole();
    await this.boss.start();
    await this.boss.createQueue(queue, {
      retryLimit: 10,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 600,
      retentionSeconds: 30 * 86400,
    });
    await this.boss.work<{ tenantId: string; eventId: string }>(
      queue,
      { batchSize: 10 },
      async (jobs) => {
        for (const job of jobs) await this.deliver(jobSchema.parse(job.data));
      },
    );
    await this.dispatch();
    this.timer = setInterval(() => {
      void this.dispatch().catch(() =>
        console.error(JSON.stringify({ event: "notification.dispatch.error" })),
      );
    }, 5000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.boss.stop();
    await this.db.$disconnect();
  }
  async dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    let successful = false;
    try {
      if (Date.now() - this.lastAutomationAt > 60000) {
        await this.automation.dispatch();
        this.lastAutomationAt = Date.now();
      }
      if (Date.now() - this.lastSlaAt > 60000) {
        await this.sla.dispatch();
        this.lastSlaAt = Date.now();
      }
      if (Date.now() - this.lastDigestAt > 60000) {
        await this.dispatchDigests();
        this.lastDigestAt = Date.now();
      }
      await this.inbound.dispatch();
      await this.recovery.dispatch();
      await this.invitations.dispatch();
      // This narrowly privileged function exposes only tenant/event IDs, never ticket content.
      const events = await this.db.$queryRaw<
        { tenant_id: string; id: string }[]
      >`SELECT * FROM pending_outbox_events()`;
      for (const row of events) {
        const data = jobSchema.parse({ tenantId: row.tenant_id, eventId: row.id });
        // A stable job ID deduplicates a crash after enqueue but before marking published.
        await this.boss.send(queue, data, { id: row.id });
        await this.db.withTenant(row.tenant_id, (tx) =>
          tx.outbox.updateMany({
            where: { tenantId: row.tenant_id, id: row.id, publishedAt: null },
            data: { publishedAt: new Date(), attempts: { increment: 1 } },
          }),
        );
      }
      successful = true;
    } finally {
      this.dispatching = false;
      await writeFile(
        join(tmpdir(), "astrama-worker-health.json"),
        JSON.stringify({ checkedAt: Date.now(), successful }),
        { mode: 0o600 },
      );
      await this.db
        .$executeRaw`INSERT INTO operation_heartbeats(component,checked_at,successful) VALUES('worker',now(),${successful}) ON CONFLICT(component) DO UPDATE SET checked_at=now(),successful=EXCLUDED.successful`;
    }
  }
  async deliver(input: { tenantId: string; eventId: string }) {
    const data = jobSchema.parse(input);
    const recipients = await this.db
      .withTenant(data.tenantId, async (tx) => {
        const event = await tx.outbox.findFirst({
          where: { tenantId: data.tenantId, id: data.eventId },
          include: { ticket: true },
        });
        if (!event || event.event.endsWith(".seeded")) return [];
        const payload = event.payload as Record<string, unknown>;
        if (payload.kind === "sla") {
          const department = await tx.department.findUnique({
            where: { id: event.ticket.departmentId },
            select: { queueOwnerId: true, substituteId: true },
          });
          const recipientIds: (string | null | undefined)[] = event.ticket.assignedToId
            ? [event.ticket.assignedToId]
            : [department?.queueOwnerId, department?.substituteId];
          if (payload.stage === "breach") {
            const [settings] = await tx.$queryRaw<{ responsible_admin_id: string }[]>`
              SELECT responsible_admin_id FROM automation_settings WHERE tenant_id=${data.tenantId}::uuid
            `;
            recipientIds.push(settings?.responsible_admin_id);
          }
          return (
            await tx.user.findMany({
              where: {
                tenantId: data.tenantId,
                id: { in: [...new Set(recipientIds.filter((id): id is string => !!id))] },
                active: true,
              },
              select: { id: true },
            })
          ).map((user) => user.id);
        }
        if (payload.kind === "inbound_ack") return [event.ticket.callerId];
        const pending = await tx.approval.findMany({
          where: {
            tenantId: data.tenantId,
            ticketId: event.ticketId,
            version: event.ticket.approvalVersion,
            status: "Pending",
          },
        });
        const approvers = pending.map((a) => a.approverId).filter((id): id is string => !!id);
        const delegates = await tx.approvalDelegation.findMany({
          where: {
            tenantId: data.tenantId,
            approverId: { in: approvers },
            active: true,
            startsAt: { lte: new Date() },
            endsAt: { gt: new Date() },
          },
        });
        const customerVisible =
          payload.audience === "customer" ||
          (payload.audience === undefined &&
            ["incident.created", "request.created", "ticket.category"].includes(event.event));
        const groupUsers = event.ticket.assignedToId
          ? []
          : await tx.user.findMany({
              where: {
                tenantId: data.tenantId,
                active: true,
                role: "agent",
                memberships: {
                  some: { departmentId: event.ticket.departmentId, department: { active: true } },
                },
              },
              select: { id: true },
            });
        const automationAdmins =
          payload.automation === true && payload.kind === "approval_escalation"
            ? await tx.$queryRaw<{ responsible_admin_id: string }[]>`
                SELECT responsible_admin_id FROM automation_settings WHERE tenant_id=${data.tenantId}::uuid
              `
            : [];
        const administratorIds = [
          ...(payload.routingException === true || !!event.ticket.approvalCorrectionReason
            ? (
                await tx.user.findMany({
                  where: { tenantId: data.tenantId, active: true, role: "admin" },
                  select: { id: true },
                })
              ).map((user) => user.id)
            : []),
          ...automationAdmins.map((row) => row.responsible_admin_id),
        ];
        const recipientIds = [
          ...(customerVisible
            ? [
                event.ticket.callerId,
                event.ticket.submittedById,
                event.ticket.requestedForId,
              ].filter((id): id is string => !!id)
            : []),
          ...(event.ticket.assignedToId
            ? [event.ticket.assignedToId]
            : groupUsers.map((u) => u.id)),
          ...approvers,
          ...delegates.map((d) => d.delegateId),
          ...administratorIds,
        ];
        const users = recipientIds.length
          ? await tx.user.findMany({
              where: {
                tenantId: data.tenantId,
                id: { in: [...new Set(recipientIds)] },
                active: true,
              },
              select: { id: true },
            })
          : [];
        return users.map((u) => u.id);
      })
      .catch((error) => {
        // A tenant may be disabled after the committed event was queued.
        if (error instanceof Error && error.message === "Tenant unavailable") return [];
        throw error;
      });
    for (const recipientId of recipients) {
      const failure = await this.db.withTenant(data.tenantId, async (tx) => {
        await lockConfiguration(tx, data.tenantId);
        const event = await tx.outbox.findFirst({
          where: { tenantId: data.tenantId, id: data.eventId },
          include: { ticket: { include: { item: true } } },
        });
        const user = await tx.user.findFirst({
          where: { tenantId: data.tenantId, id: recipientId, active: true },
          include: { memberships: { where: { department: { active: true } } } },
        });
        if (!event || !user) return false;
        const delivery = await tx.notificationDelivery.upsert({
          where: {
            tenantId_eventId_recipientId: {
              tenantId: data.tenantId,
              eventId: data.eventId,
              recipientId,
            },
          },
          create: { tenantId: data.tenantId, eventId: data.eventId, recipientId },
          update: {},
        });
        if (delivery.status !== "pending") return false;
        const actor = {
          tenantId: data.tenantId,
          id: user.id,
          role: user.role as "employee" | "agent" | "admin",
          departmentIds: user.memberships.map((m) => m.departmentId),
        };
        const payload = event.payload as Record<string, unknown>;
        const internal = payload.audience === "internal";
        const slaEvent = payload.kind === "sla";
        const inboundAck = payload.kind === "inbound_ack";
        let slaResponsibleAdminId: string | undefined;
        if (slaEvent && payload.stage === "breach" && user.role === "admin") {
          const [settings] = await tx.$queryRaw<{ responsible_admin_id: string }[]>`
            SELECT responsible_admin_id FROM automation_settings WHERE tenant_id=${data.tenantId}::uuid
          `;
          slaResponsibleAdminId = settings?.responsible_admin_id;
        }
        const approval =
          event.ticket.state === "Pending Approval"
            ? await tx.approval.findFirst({
                where: {
                  tenantId: data.tenantId,
                  ticketId: event.ticketId,
                  version: event.ticket.approvalVersion,
                  status: "Pending",
                },
                include: { approver: true },
                orderBy: { stage: "asc" },
              })
            : null;
        let eligibleApprover = false;
        if (!internal && approval?.approver && !approval.correctionReason && event.ticket.item) {
          const now = new Date();
          const delegation = await tx.approvalDelegation.findFirst({
            where: {
              tenantId: data.tenantId,
              approverId: approval.approverId!,
              delegateId: user.id,
              active: true,
              startsAt: { lte: now },
              endsAt: { gt: now },
            },
          });
          const outgoing =
            user.id !== approval.approverId &&
            (await tx.approvalDelegation.count({
              where: {
                tenantId: data.tenantId,
                approverId: user.id,
                active: true,
                startsAt: { lte: now },
                endsAt: { gt: now },
              },
            }));
          const expected = await this.tickets.approvalRequirements(
            tx,
            actor,
            event.ticket,
            event.ticket.item,
          );
          eligibleApprover =
            !outgoing &&
            expected.some(
              (e) =>
                e.stage === approval.stage &&
                e.approverId === approval.approverId &&
                !e.correctionReason,
            ) &&
            canActApproval(
              user.id,
              approval.approver,
              user,
              event.ticket,
              approval.stage === "vp",
              delegation ?? undefined,
              now,
            );
        }
        const automationAlert =
          payload.automation === true &&
          ["approval_reminder", "approval_escalation"].includes(String(payload.kind));
        let escalationRecipient = false,
          currentAutomation = false;
        if (
          automationAlert &&
          approval &&
          event.ticket.state === "Pending Approval" &&
          !event.ticket.approvalCorrectionReason &&
          event.ticket.item
        ) {
          const [settings] = await tx.$queryRaw<
            { enabled: boolean; revision: number; responsible_admin_id: string }[]
          >`SELECT enabled,revision,responsible_admin_id FROM automation_settings WHERE tenant_id=${data.tenantId}::uuid`;
          const responsible =
            settings &&
            (await tx.user.findFirst({
              where: {
                tenantId: data.tenantId,
                id: settings.responsible_admin_id,
                active: true,
                role: "admin",
              },
            }));
          currentAutomation =
            !!settings?.enabled &&
            !!responsible &&
            settings.revision === payload.calendarRevision &&
            approval.id === payload.approvalId &&
            approval.version === payload.approvalVersion &&
            approval.stage === payload.stage &&
            (await this.tickets.approvalsMatch(tx, actor, event.ticket, event.ticket.item));
          const group = await tx.department.findUnique({
            where: { id: event.ticket.departmentId },
          });
          escalationRecipient =
            currentAutomation &&
            payload.kind === "approval_escalation" &&
            (user.role === "admin" ||
              (isGroupAgent(actor, event.ticket) &&
                !!group &&
                [group.queueOwnerId, group.substituteId].includes(user.id)));
        }
        const administratorAlert =
          !internal &&
          user.role === "admin" &&
          (escalationRecipient ||
            payload.routingException === true ||
            !!event.ticket.approvalCorrectionReason);
        const permitted = automationAlert
          ? currentAutomation &&
            (payload.kind === "approval_reminder" ? eligibleApprover : escalationRecipient)
          : internal
            ? isGroupAgent(actor, event.ticket) || (slaEvent && slaResponsibleAdminId === user.id)
            : inboundAck
              ? user.id === event.ticket.callerId
              : canReadTicket(actor, event.ticket) || eligibleApprover || administratorAlert;
        if (!permitted) {
          await tx.notificationDelivery.update({
            where: { id: delivery.id },
            data: { status: "skipped" },
          });
          return false;
        }
        const preference = await tx.notificationPreference.findUnique({
          where: { tenantId_userId: { tenantId: data.tenantId, userId: user.id } },
        });
        const critical =
          (slaEvent && payload.stage === "breach") ||
          payload.routingException === true ||
          payload.kind === "security";
        if (!critical && preference?.mode === "off") {
          await tx.notificationDelivery.update({
            where: { id: delivery.id },
            data: { status: "skipped" },
          });
          return false;
        }
        if (!critical && preference?.mode === "daily") {
          await tx.notificationDelivery.update({
            where: { id: delivery.id },
            data: { status: "deferred" },
          });
          return false;
        }
        try {
          // Deliberately exclude ticket text and internal notes from email. Open the authenticated UI for details.
          const origin = new URL(process.env.APP_ORIGIN!);
          const token =
            event.ticket.inboundReplyAddress && !slaEvent
              ? createHmac("sha256", encryptionKey())
                  .update(`email-reply:${data.tenantId}:${delivery.id}`)
                  .digest("hex")
              : null;
          const replyHeaders: Record<string, string> = {};
          if (token && event.ticket.inboundReplyAddress) {
            const local = event.ticket.inboundReplyAddress.split("@", 1)[0];
            const domain = event.ticket.inboundReplyAddress.split("@").at(-1);
            replyHeaders["Reply-To"] = `${local}+t.${token}@${domain}`;
            await tx.notificationDelivery.update({
              where: { id: delivery.id },
              data: { replyTokenHash: replyTokenHash(token) },
            });
          }
          const priorMessage = await tx.inboundMessage.findFirst({
            where: { tenantId: data.tenantId, ticketId: event.ticketId, status: "processed" },
            orderBy: { receivedAt: "desc" },
            select: { messageId: true },
          });
          if (priorMessage) {
            replyHeaders["In-Reply-To"] = priorMessage.messageId;
            replyHeaders.References = priorMessage.messageId;
          }
          const path = inboundAck
            ? `/tickets/${event.ticketId}?choose-category=1`
            : administratorAlert
              ? "/organisation"
              : eligibleApprover
                ? "/approvals"
                : `/tickets/${event.ticketId}`;
          await this.mail.sendMail({
            from: process.env.SMTP_FROM,
            to: user.email,
            subject: slaEvent
              ? `SLA ${String(payload.target)} ${String(payload.stage)}: ${event.ticket.number}`
              : administratorAlert
                ? "Service desk configuration needs attention"
                : `${event.ticket.number}: service desk update`,
            text: inboundAck
              ? `Your request ${event.ticket.number} was received. Sign in to choose its category:\n${process.env.APP_ORIGIN}${path}`
              : `There is an update in your organisation's service desk. Sign in to view it:\n${process.env.APP_ORIGIN}${path}`,
            headers: { ...replyHeaders, "Message-ID": `<${delivery.id}@${origin.hostname}>` },
            messageId: `<${delivery.id}@${origin.hostname}>`,
          });
          await tx.notificationDelivery.update({
            where: { id: delivery.id },
            data: {
              status: "sent",
              attempts: { increment: 1 },
              deliveredAt: new Date(),
              lastError: null,
            },
          });
          return false;
        } catch {
          await tx.notificationDelivery.update({
            where: { id: delivery.id },
            data: { attempts: { increment: 1 }, lastError: "SMTP delivery failed" },
          });
          return true;
        }
      });
      // Commit failed-attempt evidence before asking pg-boss to retry. Sent recipients are skipped on retry.
      if (failure) throw new Error("SMTP delivery failed");
    }
  }

  private async dispatchDigests() {
    const groups = await this.db.$queryRaw<{ tenant_id: string; recipient_id: string }[]>`
      SELECT * FROM pending_notification_digests()
    `;
    for (const group of groups) {
      try {
        await this.db.withTenant(group.tenant_id, async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notification-digest:${group.tenant_id}:${group.recipient_id}`},0))`;
          const user = await tx.user.findFirst({
            where: { tenantId: group.tenant_id, id: group.recipient_id, active: true },
          });
          const preference = await tx.notificationPreference.findUnique({
            where: { tenantId_userId: { tenantId: group.tenant_id, userId: group.recipient_id } },
          });
          const deliveries = await tx.notificationDelivery.findMany({
            where: {
              tenantId: group.tenant_id,
              recipientId: group.recipient_id,
              status: "deferred",
              event: { createdAt: { lt: new Date(new Date().setUTCHours(0, 0, 0, 0)) } },
            },
            select: { id: true },
          });
          if (!deliveries.length) return;
          if (!user || preference?.mode === "off") {
            await tx.notificationDelivery.updateMany({
              where: { id: { in: deliveries.map((d) => d.id) } },
              data: { status: "skipped" },
            });
            return;
          }
          const origin = new URL(process.env.APP_ORIGIN!);
          await this.mail.sendMail({
            from: process.env.SMTP_FROM,
            to: user.email,
            subject:
              preference?.mode === "daily" ? "Daily service desk updates" : "Service desk updates",
            text: `You have ${deliveries.length} service desk updates. Sign in to view them:\n${process.env.APP_ORIGIN}/tickets`,
            messageId: `<${randomUUID()}@${origin.hostname}>`,
          });
          await tx.notificationDelivery.updateMany({
            where: { id: { in: deliveries.map((d) => d.id) }, status: "deferred" },
            data: {
              status: "sent",
              attempts: { increment: 1 },
              deliveredAt: new Date(),
              lastError: null,
            },
          });
        });
      } catch (error) {
        if (!(error instanceof Error && error.message === "Tenant unavailable")) throw error;
      }
    }
  }
}
