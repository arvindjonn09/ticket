import { createTransport } from "nodemailer";
import { Database, lockConfiguration } from "./database.js";
import { decryptSecret } from "./mfa.js";
import { RecoveryService } from "./recovery.js";

type RecoveryMail = {
  id: string;
  user_id: string;
  encrypted_url: string | null;
  expires_at: Date;
  used_at: Date | null;
  attempts: number;
  email: string;
  password_hash: string;
};
/** A committed encrypted outbox. Sending and status update are serialized with account changes. */
export class RecoveryMailer {
  private dispatching = false;
  private readonly mail = createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: process.env.SMTP_SECURE === "true",
    requireTLS: process.env.NODE_ENV === "production",
    ...(process.env.SMTP_USER
      ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } }
      : {}),
    connectionTimeout: 3000,
    greetingTimeout: 3000,
    socketTimeout: 5000,
  });
  constructor(private readonly db: Database) {}
  async dispatch() {
    if (this.dispatching) return;
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM || !process.env.APP_ORIGIN)
      throw new Error("Recovery mail configuration is incomplete");
    this.dispatching = true;
    try {
      await new RecoveryService(this.db).dispatchRequests();
      const rows = await this.db.$queryRaw<
        { id: string; tenant_id: string }[]
      >`SELECT * FROM pending_recovery_mail()`;
      for (const row of rows) await this.deliver(row.tenant_id, row.id);
    } finally {
      this.dispatching = false;
    }
  }
  async deliver(tenantId: string, id: string) {
    try {
      await this.db.withTenant(tenantId, async (tx) => {
        await lockConfiguration(tx, tenantId);
        const [item] = await tx.$queryRaw<
          RecoveryMail[]
        >`SELECT * FROM password_recoveries WHERE tenant_id=${tenantId}::uuid AND id=${id}::uuid AND status='pending' AND next_attempt_at<=now()`;
        if (!item) return;
        const user = await tx.user.findFirst({
          where: { tenantId, id: item.user_id, active: true },
        });
        if (
          !user ||
          item.used_at ||
          item.expires_at <= new Date() ||
          !item.encrypted_url ||
          item.password_hash !== user.passwordHash ||
          item.email !== user.email
        ) {
          await tx.$executeRaw`UPDATE password_recoveries SET status='skipped',encrypted_url=NULL,last_error='Recovery no longer valid' WHERE tenant_id=${tenantId}::uuid AND id=${id}::uuid AND status='pending'`;
          return;
        }
        try {
          const url = decryptSecret(item.encrypted_url, `recovery:${tenantId}:${user.id}:${id}`),
            parsed = new URL(url);
          if (
            parsed.origin !== process.env.APP_ORIGIN ||
            parsed.pathname !== "/" ||
            !parsed.hash.startsWith("#reset-password?")
          )
            throw new Error("Invalid recovery destination");
          await this.mail.sendMail({
            from: process.env.SMTP_FROM,
            to: user.email,
            subject: "Reset your service desk password",
            text: `A password reset was requested for your service desk account. This single-use link expires at ${item.expires_at.toISOString()}:\n${url}\n\nYour authenticator remains required. If you did not request this, ignore this email.`,
            messageId: `<recovery-${id}@astrama.local>`,
          });
          await tx.$executeRaw`UPDATE password_recoveries SET status='sent',encrypted_url=NULL,sent_at=now(),attempts=attempts+1,last_error=NULL WHERE tenant_id=${tenantId}::uuid AND id=${id}::uuid AND status='pending'`;
        } catch {
          const attempts = item.attempts + 1,
            exhausted = attempts >= 10;
          await tx.$executeRaw`UPDATE password_recoveries SET attempts=${attempts},status=${exhausted ? "skipped" : "pending"},encrypted_url=${exhausted ? null : item.encrypted_url},next_attempt_at=${new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7)))},last_error=${exhausted ? "Recovery delivery retry limit reached" : "Recovery delivery failed"} WHERE tenant_id=${tenantId}::uuid AND id=${id}::uuid AND status='pending'`;
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Tenant unavailable") return;
      throw error;
    }
  }
}
