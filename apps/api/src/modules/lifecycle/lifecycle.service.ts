import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { createPlatformTransport, sendTenantMail } from "../../platform-mail.js";
import { Database, lockConfigurationExclusive } from "../../database.js";
import { tenantOrigin } from "../../platform.js";
import { deleteExpiredTenant } from "../../operator-data.js";
import { processOperatorJobs } from "../../operator-jobs.js";
import { tenantBranding, brandedText } from "../../branding.js";

type LifecycleTenant = {
  tenant_id: string;
  slug: string;
  status: string;
  trial_ends_at: Date | null;
  read_only_since: Date | null;
  delete_after: Date | null;
};

const warningDays = [30, 7, 1] as const;
const elapsed = (date: Date, now: Date) => date.getTime() <= now.getTime();

@Injectable()
export class TenantLifecycleService implements OnModuleDestroy {
  private readonly owner: PrismaClient;
  private readonly mail = createPlatformTransport(() => this.db);

  constructor(private readonly db: Database) {
    if (!process.env.MIGRATION_DATABASE_URL)
      throw new Error("Tenant lifecycle worker configuration is incomplete");
    this.owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL, log: [] });
  }

  async run(now = new Date()) {
    await this.owner
      .$executeRaw`DELETE FROM tenant_budgets WHERE window_start<${new Date(now.getTime() - 2 * 86400000)}`;
    await processOperatorJobs(this.owner);
    const tenants = await this.db.$queryRaw<LifecycleTenant[]>`
      SELECT * FROM pending_tenant_lifecycle()
    `;
    for (const item of tenants) {
      try {
        let current = item;
        if (item.status === "deleted") {
          if (item.delete_after && elapsed(item.delete_after, now))
            await deleteExpiredTenant(this.owner, item.tenant_id, now);
          continue;
        }
        if (item.status === "trial" && item.trial_ends_at && elapsed(item.trial_ends_at, now)) {
          current = await this.db.withTenant(item.tenant_id, async (tx) => {
            await lockConfigurationExclusive(tx, item.tenant_id);
            const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: item.tenant_id } });
            if (tenant.status !== "trial" || !tenant.trialEndsAt || tenant.trialEndsAt > now)
              return {
                ...item,
                status: tenant.status,
                trial_ends_at: tenant.trialEndsAt,
                read_only_since: tenant.readOnlySince,
                delete_after: tenant.deleteAfter,
              };
            const readOnlySince = tenant.trialEndsAt;
            const deleteAfter = new Date(readOnlySince.getTime() + 45 * 86400000);
            const updated = await tx.tenant.update({
              where: { id: tenant.id },
              data: {
                status: "read_only",
                readOnlyReason: "trial_ended",
                readOnlySince,
                deleteAfter,
              },
            });
            await tx.inboundMessage.updateMany({
              where: {
                tenantId: tenant.id,
                status: { in: ["queued", "processing", "failed"] },
              },
              data: {
                status: "ignored",
                textBody: "",
                htmlBody: null,
                headers: {},
                attachments: [],
                replyTokenHash: null,
                processedAt: now,
                lastError: "Tenant is read-only",
              },
            });
            return {
              ...item,
              status: updated.status,
              read_only_since: updated.readOnlySince,
              delete_after: updated.deleteAfter,
            };
          });
        }
        if (current.status !== "read_only" || !current.read_only_since || !current.delete_after)
          continue;
        await this.ensureWarnings(current, now);
        await this.sendDueWarnings(current, now);
        if (elapsed(current.delete_after, now))
          await deleteExpiredTenant(this.owner, current.tenant_id, now);
      } catch {
        console.error(JSON.stringify({ event: "tenant.lifecycle.failed", tenantSlug: item.slug }));
      }
    }
  }

  private async ensureWarnings(tenant: LifecycleTenant, now: Date) {
    for (const days of warningDays) {
      const kind = `deletion_${days}d` as const;
      const dueAt = new Date(tenant.delete_after!.getTime() - days * 86400000);
      if (dueAt > now) continue;
      await this.db.withTenant(tenant.tenant_id, (tx) =>
        tx.tenantLifecycleNotice.upsert({
          where: {
            tenantId_periodStart_kind: {
              tenantId: tenant.tenant_id,
              periodStart: tenant.read_only_since!,
              kind,
            },
          },
          create: {
            tenantId: tenant.tenant_id,
            periodStart: tenant.read_only_since!,
            kind,
            dueAt,
          },
          update: { dueAt },
        }),
      );
    }
  }

  private async sendDueWarnings(tenant: LifecycleTenant, now: Date) {
    const notices = await this.db.withTenant(tenant.tenant_id, (tx) =>
      tx.tenantLifecycleNotice.findMany({
        where: { tenantId: tenant.tenant_id, sentAt: null, dueAt: { lte: now } },
        orderBy: { dueAt: "asc" },
      }),
    );
    for (const notice of notices) {
      const message = await this.db.withTenant(tenant.tenant_id, async (tx) => {
        const claimed = await tx.tenantLifecycleNotice.updateMany({
          where: {
            id: notice.id,
            sentAt: null,
            OR: [
              { lastAttempt: null },
              { lastAttempt: { lt: new Date(now.getTime() - 5 * 60000) } },
            ],
          },
          data: { attempts: { increment: 1 }, lastAttempt: now },
        });
        if (claimed.count !== 1) return null;
        const [current, admins] = await Promise.all([
          tx.tenant.findUniqueOrThrow({ where: { id: tenant.tenant_id } }),
          tx.user.findMany({
            where: { tenantId: tenant.tenant_id, role: "admin", active: true },
            select: { email: true },
          }),
        ]);
        return {
          to: admins.map((admin) => admin.email),
          slug: current.slug,
          name: current.name,
          deleteAfter: current.deleteAfter,
          branding: await tenantBranding(tx, current.id),
        };
      });
      if (!message?.to.length) continue;
      const days = Number(notice.kind.replace("deletion_", "").replace("d", ""));
      const failure = await this.db.withTenant(tenant.tenant_id, async (tx) => {
        try {
          await sendTenantMail(this.mail, tx, tenant.tenant_id, {
            to: message.to,
            subject: `Astrama: ${message.name} data deletion in ${days} day${days === 1 ? "" : "s"}`,
            text: brandedText(
              `Your organisation ${message.name} (${message.slug}) is read-only. Its data is scheduled for deletion on ${message.deleteAfter?.toISOString() ?? "the scheduled date"}. Export your data or contact billing before that date.\n\n${tenantOrigin(message.slug)}/billing`,
              message.branding,
            ),
          });
        } catch {
          return true;
        }
        await tx.tenantLifecycleNotice.updateMany({
          where: { id: notice.id, sentAt: null },
          data: { sentAt: now },
        });
        return false;
      });
      if (failure) throw new Error("SMTP delivery failed");
    }
  }

  async onModuleDestroy() {
    this.mail.close();
    await this.owner.$disconnect();
  }
}
