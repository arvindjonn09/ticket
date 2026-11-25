import { Controller, ForbiddenException, Get, Req, UseGuards } from "@nestjs/common";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createConnection } from "node:net";
import { canConfigureOrganisation } from "@astrama/domain";
import type { EmailHealthView } from "@astrama/contracts";
import { SessionGuard, type AuthRequest } from "./modules/auth/auth.service.js";
import { Database } from "./database.js";
import { TicketsService } from "./modules/tickets/tickets.service.js";

export async function operationalHealth(db: Database) {
  const checks: Record<string, boolean> = {
    database: false,
    worker: false,
    storage: false,
    scanner: false,
    queue: false,
    backup: false,
  };
  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = true;
    const rows = await db.$queryRaw<
      { component: string; checked_at: Date; successful: boolean }[]
    >`SELECT * FROM operation_heartbeats`;
    checks.worker = rows.some(
      (r) =>
        r.component === "worker" && r.successful && Date.now() - r.checked_at.getTime() < 120000,
    );
    checks.backup = rows.some(
      (r) =>
        r.component === "backup" &&
        r.successful &&
        Date.now() - r.checked_at.getTime() < 26 * 3600000,
    );
    const [queue] = await db.$queryRaw<
      { failed: bigint; overdue: bigint }[]
    >`SELECT count(*) FILTER(WHERE state='failed') AS failed, count(*) FILTER(WHERE state IN ('created','retry') AND created_on<now()-interval '30 minutes') AS overdue FROM pgboss.job`;
    checks.queue = !!queue && Number(queue.failed) === 0 && Number(queue.overdue) === 0;
  } catch {
    /* Expose only component status, never connection strings or database errors. */
  }
  if (process.env.MONITOR_HOST_CHECKS === "1") {
    Object.assign(
      checks,
      productionHostChecks(
        process.env.HOST_DISK_USAGE_PERCENT ?? "",
        process.env.TLS_CERTIFICATE_DAYS_REMAINING ?? "",
      ),
    );
    if (process.env.FORCE_BACKUP_FAILURE === "1") checks.backup = false;
  }
  const storage = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.S3_SECRET_KEY ?? "",
    },
  });
  try {
    await storage.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }), {
      abortSignal: AbortSignal.timeout(3000),
    });
    checks.storage = true;
  } catch {
    /* Unavailable. */
  } finally {
    storage.destroy();
  }
  checks.scanner = await new Promise<boolean>((resolve) => {
    const socket = createConnection({
      host: process.env.CLAMAV_HOST ?? "localhost",
      port: Number(process.env.CLAMAV_PORT ?? 3310),
    });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3000, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write("zPING\0"));
    socket.once("data", (value) => finish(value.toString().includes("PONG")));
  });
  return {
    healthy: Object.values(checks).every(Boolean),
    checks,
    checkedAt: new Date().toISOString(),
  };
}

export function productionHostChecks(diskPercentText: string, certificateDaysText: string) {
  const disk = Number(diskPercentText);
  const certificateDays = Number(certificateDaysText);
  return {
    disk: !!diskPercentText && Number.isFinite(disk) && disk < 80,
    certificate: !!certificateDaysText && Number.isFinite(certificateDays) && certificateDays >= 14,
  };
}

@Controller("admin/operations")
@UseGuards(SessionGuard)
export class OperationsController {
  constructor(
    private readonly db: Database,
    private readonly tickets: TicketsService,
  ) {}
  @Get("email") email(@Req() req: AuthRequest): Promise<EmailHealthView> {
    return this.tickets.scoped(req.auth, async (tx, actor) => {
      if (!canConfigureOrganisation({ ...actor, mfaVerified: req.auth.view.mfaVerified }))
        throw new ForbiddenException("MFA-verified administrator required");
      const [row] = await tx.$queryRaw<
        { sent: bigint; failed: bigint; queued: bigint; used: bigint }[]
      >`
        SELECT
          (SELECT count(*) FROM tenant_mail_deliveries WHERE tenant_id=${actor.tenantId}::uuid AND status='sent' AND created_at>=now()-interval '24 hours') AS sent,
          (SELECT count(*) FROM tenant_mail_deliveries WHERE tenant_id=${actor.tenantId}::uuid AND status='failed' AND created_at>=now()-interval '24 hours') AS failed,
          (SELECT count(*) FROM notification_deliveries WHERE tenant_id=${actor.tenantId}::uuid AND status IN ('pending','deferred')) +
          (SELECT count(*) FROM invitation_mails WHERE tenant_id=${actor.tenantId}::uuid AND status='pending') +
          (SELECT count(*) FROM password_recoveries WHERE tenant_id=${actor.tenantId}::uuid AND status='pending') AS queued,
          COALESCE((SELECT used FROM tenant_budgets WHERE tenant_id=${actor.tenantId}::uuid AND kind='outbound'
            AND window_start=to_timestamp(floor(extract(epoch FROM now())/3600)*3600)),0) AS used`;
      return {
        sent: Number(row!.sent),
        failed: Number(row!.failed),
        queued: Number(row!.queued),
        outboundUsed: Number(row!.used),
        outboundLimit: process.env.TENANT_OUTBOUND_PER_HOUR
          ? Number(process.env.TENANT_OUTBOUND_PER_HOUR)
          : null,
      };
    });
  }
  @Get() async status(@Req() req: AuthRequest) {
    await this.tickets.scoped(req.auth, async (_tx, actor) => {
      if (!canConfigureOrganisation({ ...actor, mfaVerified: req.auth.view.mfaVerified }))
        throw new ForbiddenException("MFA-verified administrator required");
    });
    return operationalHealth(this.db);
  }
}
