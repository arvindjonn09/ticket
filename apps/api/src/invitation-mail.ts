import { createTransport } from 'nodemailer';
import { Database, lockConfiguration } from './database.js';
import { decryptSecret } from './mfa.js';

/** Durable invitation outbox; construction does not connect or send anything. */
export class InvitationMailer {
  private dispatching = false;
  private readonly mail = createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 1025), secure: process.env.SMTP_SECURE === 'true', requireTLS: process.env.NODE_ENV === 'production' && process.env.SMTP_SECURE !== 'true',
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {}), connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 5000 });
  constructor(private readonly db: Database) {}
  async dispatch() {
    if (this.dispatching) return;
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM || !process.env.APP_ORIGIN) throw new Error('Invitation mail configuration is incomplete');
    this.dispatching = true;
    try {
      const rows = await this.db.$queryRaw<{ id: string; tenant_id: string }[]>`SELECT * FROM pending_invitation_mail()`;
      for (const row of rows) await this.deliver(row.tenant_id, row.id);
    } finally { this.dispatching = false; }
  }
  async deliver(tenantId: string, id: string) {
    try { await this.db.withTenant(tenantId, async tx => {
      await lockConfiguration(tx, tenantId);
      const item = await tx.invitationMail.findFirst({ where: { tenantId, id, status: 'pending', nextAttemptAt: { lte: new Date() } }, include: { user: true } });
      if (!item) return;
      const user = item.user;
      if (user.active || user.invitationHash !== item.invitationHash || !user.invitationExpiresAt || user.invitationExpiresAt <= new Date() || !item.encryptedUrl) {
        await tx.invitationMail.updateMany({ where: { tenantId, id, status: 'pending' }, data: { status: 'skipped', encryptedUrl: null, lastError: 'Invitation no longer valid' } });
        return;
      }
      try {
        const url = decryptSecret(item.encryptedUrl, `invitation:${tenantId}:${user.id}`), parsed = new URL(url);
        if (parsed.origin !== process.env.APP_ORIGIN || parsed.pathname !== '/' || !parsed.hash.startsWith('#activate?')) throw new Error('Invalid invitation destination');
        await this.mail.sendMail({ from: process.env.SMTP_FROM, to: user.email, subject: 'Set up your service desk account',
          text: `Your organisation invited you to its service desk. Set your password using this single-use link:\n${url}\n\nThis invitation expires at ${user.invitationExpiresAt.toISOString()}. If you were not expecting it, contact your organisation administrator.`,
          messageId: `<invitation-${item.id}@astrama.local>` });
        await tx.invitationMail.updateMany({ where: { tenantId, id, status: 'pending' }, data: { status: 'sent', encryptedUrl: null, sentAt: new Date(), attempts: { increment: 1 }, lastError: null } });
      } catch {
        const attempts = item.attempts + 1, exhausted = attempts >= 10;
        await tx.invitationMail.updateMany({ where: { tenantId, id, status: 'pending' }, data: { attempts, status: exhausted ? 'skipped' : 'pending', ...(exhausted ? { encryptedUrl: null } : {}), nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7))), lastError: exhausted ? 'Invitation delivery retry limit reached. Reinvite the user.' : 'Invitation delivery failed' } });
      }
    }); } catch (error) {
      // Tenant removal/deactivation after enumeration is a cancelled delivery, not a worker failure.
      if (error instanceof Error && error.message === 'Tenant unavailable') return;
      throw error;
    }
  }
}
