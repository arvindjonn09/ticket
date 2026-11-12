import { createTransport } from 'nodemailer';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { canActApproval, canReadTicket, isGroupAgent } from '@astrama/domain';
import { Database, lockConfiguration } from './database.js';
import { InvitationMailer } from './invitation-mail.js';
import { TicketsService } from './tickets.js';
import { RecoveryMailer } from './recovery-mail.js';
import { AutomationService } from './automation.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const jobSchema = z.object({ tenantId: z.string().uuid(), eventId: z.string().uuid() }).strict();
const queue = 'ticket-notification';
export class NotificationWorker {
  private readonly boss: PgBoss;
  private readonly mail = createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 1025), secure: process.env.SMTP_SECURE === 'true', requireTLS: process.env.NODE_ENV === 'production' && process.env.SMTP_SECURE !== 'true',
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {}), connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000 });
  private timer?: NodeJS.Timeout;
  private dispatching = false;
  private readonly invitations: InvitationMailer;
  private readonly recovery: RecoveryMailer;
  private readonly automation: AutomationService;
  private lastAutomationAt = 0;
  constructor(private readonly db: Database) {
    this.invitations = new InvitationMailer(db);
    this.recovery = new RecoveryMailer(db);
    this.automation = new AutomationService(db, new TicketsService(db));
    if (!process.env.DATABASE_URL || !process.env.SMTP_HOST || !process.env.SMTP_FROM || !process.env.APP_ORIGIN) throw new Error('Notification worker configuration is incomplete');
    // Bootstrap owns schema creation; the worker has no database-wide CREATE privilege.
    this.boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: 'pgboss', createSchema: false });
    this.boss.on('error', () => console.error(JSON.stringify({ event: 'notification.queue.error' })));
  }
  async start() {
    await this.db.assertRuntimeRole();
    await this.boss.start();
    await this.boss.createQueue(queue, { retryLimit: 10, retryDelay: 30, retryBackoff: true, expireInSeconds: 600, retentionSeconds: 30 * 86400 });
    await this.boss.work<{ tenantId: string; eventId: string }>(queue, { batchSize: 10 }, async jobs => {
      for (const job of jobs) await this.deliver(jobSchema.parse(job.data));
    });
    await this.dispatch();
    this.timer = setInterval(() => { void this.dispatch().catch(() => console.error(JSON.stringify({ event: 'notification.dispatch.error' }))); }, 5000);
  }
  async stop() { if (this.timer) clearInterval(this.timer); await this.boss.stop(); await this.db.$disconnect(); }
  async dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    let successful = false;
    try {
      if (Date.now() - this.lastAutomationAt > 60000) { await this.automation.dispatch(); this.lastAutomationAt = Date.now(); }
      await this.recovery.dispatch();
      await this.invitations.dispatch();
      // This narrowly privileged function exposes only tenant/event IDs, never ticket content.
      const events = await this.db.$queryRaw<{ tenant_id: string; id: string }[]>`SELECT * FROM pending_outbox_events()`;
      for (const row of events) {
        const data = jobSchema.parse({ tenantId: row.tenant_id, eventId: row.id });
        // A stable job ID deduplicates a crash after enqueue but before marking published.
        await this.boss.send(queue, data, { id: row.id });
        await this.db.withTenant(row.tenant_id, tx => tx.outbox.updateMany({ where: { tenantId: row.tenant_id, id: row.id, publishedAt: null }, data: { publishedAt: new Date(), attempts: { increment: 1 } } }));
      }
      successful = true;
    } finally {
      this.dispatching = false;
      await writeFile(join(tmpdir(), 'astrama-worker-health.json'), JSON.stringify({ checkedAt: Date.now(), successful }), { mode: 0o600 });
      await this.db.$executeRaw`INSERT INTO operation_heartbeats(component,checked_at,successful) VALUES('worker',now(),${successful}) ON CONFLICT(component) DO UPDATE SET checked_at=now(),successful=EXCLUDED.successful`;
    }
  }
  async deliver(input: { tenantId: string; eventId: string }) {
    const data = jobSchema.parse(input);
    const recipients = await this.db.withTenant(data.tenantId, async tx => {
      const event = await tx.outbox.findFirst({ where: { tenantId: data.tenantId, id: data.eventId }, include: { ticket: true } });
      if (!event || event.event.endsWith('.seeded')) return [];
      const pending = await tx.approval.findMany({ where: { tenantId: data.tenantId, ticketId: event.ticketId, version: event.ticket.approvalVersion, status: 'Pending' } });
      const approvers = pending.map(a => a.approverId).filter((id): id is string => !!id);
      const delegates = await tx.approvalDelegation.findMany({ where: { tenantId: data.tenantId, approverId: { in: approvers }, active: true, startsAt: { lte: new Date() }, endsAt: { gt: new Date() } } });
      const users = await tx.user.findMany({ where: { tenantId: data.tenantId, active: true, OR: [{ id: { in: [event.ticket.callerId, event.ticket.submittedById, event.ticket.requestedForId, ...approvers, ...delegates.map(d => d.delegateId)].filter((id): id is string => !!id) } }, { role: 'agent', memberships: { some: { departmentId: event.ticket.departmentId, department: { active: true } } } }, { role: 'admin' }] }, select: { id: true } });
      return users.map(u => u.id);
    }).catch(error => {
      // A tenant may be disabled after the committed event was queued.
      if (error instanceof Error && error.message === 'Tenant unavailable') return [];
      throw error;
    });
    for (const recipientId of recipients) {
      const failure = await this.db.withTenant(data.tenantId, async tx => {
        await lockConfiguration(tx, data.tenantId);
        const event = await tx.outbox.findFirst({ where: { tenantId: data.tenantId, id: data.eventId }, include: { ticket: { include: { item: true } } } });
        const user = await tx.user.findFirst({ where: { tenantId: data.tenantId, id: recipientId, active: true }, include: { memberships: { where: { department: { active: true } } } } });
        if (!event || !user) return false;
        const delivery = await tx.notificationDelivery.upsert({ where: { tenantId_eventId_recipientId: { tenantId: data.tenantId, eventId: data.eventId, recipientId } }, create: { tenantId: data.tenantId, eventId: data.eventId, recipientId }, update: {} });
        if (delivery.status !== 'pending') return false;
        const actor = { tenantId: data.tenantId, id: user.id, role: user.role as 'employee' | 'agent' | 'admin', departmentIds: user.memberships.map(m => m.departmentId) };
        const payload = event.payload as Record<string, unknown>;
        const internal = payload.audience === 'internal';
        const approval = event.ticket.state === 'Pending Approval' ? await tx.approval.findFirst({ where: { tenantId: data.tenantId, ticketId: event.ticketId, version: event.ticket.approvalVersion, status: 'Pending' }, include: { approver: true }, orderBy: { stage: 'asc' } }) : null;
        let eligibleApprover = false;
        if (!internal && approval?.approver && !approval.correctionReason && event.ticket.item) {
          const now = new Date();
          const delegation = await tx.approvalDelegation.findFirst({ where: { tenantId: data.tenantId, approverId: approval.approverId!, delegateId: user.id, active: true, startsAt: { lte: now }, endsAt: { gt: now } } });
          const outgoing = user.id !== approval.approverId && await tx.approvalDelegation.count({ where: { tenantId: data.tenantId, approverId: user.id, active: true, startsAt: { lte: now }, endsAt: { gt: now } } });
          const expected = await new TicketsService(this.db).approvalRequirements(tx, actor, event.ticket, event.ticket.item);
          eligibleApprover = !outgoing && expected.some(e => e.stage === approval.stage && e.approverId === approval.approverId && !e.correctionReason) && canActApproval(user.id, approval.approver, user, event.ticket, approval.stage === 'vp', delegation ?? undefined, now);
        }
        const automationAlert = payload.automation === true && ['approval_reminder', 'approval_escalation'].includes(String(payload.kind));
        let escalationRecipient = false, currentAutomation = false;
        if (automationAlert && approval && event.ticket.state === 'Pending Approval' && !event.ticket.approvalCorrectionReason && event.ticket.item) {
          const [settings] = await tx.$queryRaw<{ enabled: boolean; revision: number; responsible_admin_id: string }[]>`SELECT enabled,revision,responsible_admin_id FROM automation_settings WHERE tenant_id=${data.tenantId}::uuid`;
          const responsible = settings && await tx.user.findFirst({ where: { tenantId: data.tenantId, id: settings.responsible_admin_id, active: true, role: 'admin' } });
          currentAutomation = !!settings?.enabled && !!responsible && settings.revision === payload.calendarRevision && approval.id === payload.approvalId && approval.version === payload.approvalVersion && approval.stage === payload.stage && await new TicketsService(this.db).approvalsMatch(tx, actor, event.ticket, event.ticket.item);
          const group = await tx.department.findUnique({ where: { id: event.ticket.departmentId } });
          escalationRecipient = currentAutomation && payload.kind === 'approval_escalation' && (user.role === 'admin' || (isGroupAgent(actor, event.ticket) && !!group && [group.queueOwnerId, group.substituteId].includes(user.id)));
        }
        const administratorAlert = !internal && user.role === 'admin' && (escalationRecipient || payload.routingException === true || !!event.ticket.approvalCorrectionReason);
        const permitted = automationAlert ? (currentAutomation && (payload.kind === 'approval_reminder' ? eligibleApprover : escalationRecipient)) : internal ? isGroupAgent(actor, event.ticket) : canReadTicket(actor, event.ticket) || eligibleApprover || administratorAlert;
        if (!permitted) {
          await tx.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'skipped' } });
          return false;
        }
        try {
          // Deliberately exclude ticket text and internal notes from email. Open the authenticated UI for details.
          const path = administratorAlert ? '/organisation' : eligibleApprover ? '/approvals' : `/tickets/${event.ticketId}`;
          await this.mail.sendMail({ from: process.env.SMTP_FROM, to: user.email, subject: administratorAlert ? 'Service desk configuration needs attention' : `${event.ticket.number}: service desk update`,
            text: `There is an update in your organisation's service desk. Sign in to view it:\n${process.env.APP_ORIGIN}${path}\n\nThis mailbox is not monitored for replies.`,
            messageId: `<${delivery.id}@astrama.local>` });
          await tx.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'sent', attempts: { increment: 1 }, deliveredAt: new Date(), lastError: null } });
          return false;
        } catch {
          await tx.notificationDelivery.update({ where: { id: delivery.id }, data: { attempts: { increment: 1 }, lastError: 'SMTP delivery failed' } });
          return true;
        }
      });
      // Commit failed-attempt evidence before asking pg-boss to retry. Sent recipients are skipped on retry.
      if (failure) throw new Error('SMTP delivery failed');
    }
  }
}
