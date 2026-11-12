import {
  BadRequestException,
  Controller,
  HttpException,
  Injectable,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { argon2id, hash } from "argon2";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { forgotPasswordSchema, resetPasswordSchema } from "@astrama/contracts";
import { AuthService, reserveAuthAttempt, tokenHash } from "./modules/auth/auth.service.js";
import { Database, lockConfiguration } from "./database.js";
import { decryptSecret, encryptSecret } from "./mfa.js";

@Injectable()
export class RecoveryService {
  constructor(private readonly db: Database) {}
  async forgot(request: FastifyRequest) {
    const input = forgotPasswordSchema.parse(request.body);
    await reserveAuthAttempt(this.db, `forgot:ip:${request.ip}`, 30);
    // Account throttling is deliberately indistinguishable from unknown/inactive accounts.
    try {
      await reserveAuthAttempt(this.db, `forgot:${input.organisation}:${input.email}`, 3);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 429) return { ok: true };
      throw error;
    }
    // Every address follows the same durable enqueue path. Account lookup and tenant-lock work happen only in the worker.
    const id = randomUUID(),
      encrypted = encryptSecret(JSON.stringify(input), `recovery-request:${id}`);
    await this.db.$executeRaw`SELECT enqueue_password_recovery(${id}::uuid,${encrypted})`;
    return { ok: true };
  }
  async dispatchRequests() {
    await this.db.$executeRaw`SELECT purge_expired_recovery_requests()`;
    const rows = await this.db.$queryRaw<
      { id: string }[]
    >`SELECT * FROM pending_password_recovery_requests()`;
    let failed = false;
    for (const row of rows) if (!(await this.processRequest(row.id))) failed = true;
    if (failed) throw new Error("Recovery request processing failed");
  }
  async processRequest(requestId: string) {
    try {
      await this.db.$transaction(
        async (tx) => {
          const [request] = await tx.$queryRaw<
            { encrypted_request: string }[]
          >`SELECT * FROM lock_password_recovery_request(${requestId}::uuid)`;
          if (!request) return;
          const input = forgotPasswordSchema.parse(
            JSON.parse(decryptSecret(request.encrypted_request, `recovery-request:${requestId}`)),
          );
          const [found] = await tx.$queryRaw<
            { id: string; tenant_id: string }[]
          >`SELECT id,tenant_id FROM auth_login_lookup(${input.organisation},${input.email})`;
          if (found) {
            await tx.$executeRaw`SELECT set_config('app.tenant_id',${found.tenant_id},true)`;
            await lockConfiguration(tx, found.tenant_id);
            const active = await tx.tenant.findFirst({
              where: { id: found.tenant_id, active: true },
            });
            const user =
              active &&
              (await tx.user.findFirst({
                where: {
                  tenantId: found.tenant_id,
                  id: found.id,
                  active: true,
                  email: input.email,
                },
              }));
            if (user) {
              const token = randomBytes(32).toString("base64url"),
                id = randomUUID();
              const url = `${process.env.APP_ORIGIN}/#reset-password?organisation=${encodeURIComponent(input.organisation)}&token=${token}`;
              await tx.$executeRaw`UPDATE password_recoveries SET used_at=now(),status='skipped',encrypted_url=NULL,last_error='Superseded' WHERE tenant_id=${found.tenant_id}::uuid AND user_id=${user.id}::uuid AND used_at IS NULL`;
              await tx.$executeRaw`INSERT INTO password_recoveries(id,tenant_id,user_id,token_hash,password_hash,email,expires_at,encrypted_url) VALUES(${id}::uuid,${found.tenant_id}::uuid,${user.id}::uuid,${tokenHash(token)},${user.passwordHash},${user.email},${new Date(Date.now() + 30 * 60000)},${encryptSecret(url, `recovery:${found.tenant_id}:${user.id}:${id}`)})`;
              await tx.configAudit.create({
                data: {
                  tenantId: found.tenant_id,
                  actorId: user.id,
                  entityId: user.id,
                  action: "user.password_recovery_requested",
                  detail: {},
                },
              });
            }
          }
          await tx.$executeRaw`SELECT finish_password_recovery_request(${requestId}::uuid)`;
        },
        { maxWait: 10000, timeout: 15000 },
      );
      return true;
    } catch {
      await this.db.$executeRaw`SELECT fail_password_recovery_request(${requestId}::uuid)`;
      return false;
    }
  }
  async reset(request: FastifyRequest) {
    const input = resetPasswordSchema.parse(request.body);
    await reserveAuthAttempt(this.db, `reset:ip:${request.ip}`, 30);
    const [found] = await this.db.$queryRaw<
      { id: string; tenant_id: string; user_id: string }[]
    >`SELECT * FROM auth_recovery_lookup(${tokenHash(input.token)},${input.organisation})`;
    if (!found) throw new BadRequestException("Recovery link is invalid or expired");
    const passwordHash = await hash(input.password, { type: argon2id });
    return this.db.withTenant(found.tenant_id, async (tx) => {
      await lockConfiguration(tx, found.tenant_id);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mfa:${found.user_id}`},0))`;
      const [used] = await tx.$queryRaw<
        { user_id: string }[]
      >`UPDATE password_recoveries r SET used_at=now(),encrypted_url=NULL,status='skipped',last_error='Recovery used' FROM users u WHERE r.id=${found.id}::uuid AND r.tenant_id=${found.tenant_id}::uuid AND r.token_hash=${tokenHash(input.token)} AND r.used_at IS NULL AND r.expires_at>clock_timestamp() AND u.id=r.user_id AND u.tenant_id=r.tenant_id AND u.active AND u.email=r.email AND u.password_hash=r.password_hash RETURNING r.user_id`;
      if (!used) throw new BadRequestException("Recovery link is invalid or expired");
      // Password recovery never clears enrolled MFA or its replay/lockout state.
      await tx.user.update({
        where: { id: used.user_id },
        data: { passwordHash, revision: { increment: 1 }, updatedAt: new Date() },
      });
      await tx.session.deleteMany({ where: { tenantId: found.tenant_id, userId: used.user_id } });
      await tx.$executeRaw`UPDATE password_recoveries SET used_at=COALESCE(used_at,now()),encrypted_url=NULL,status='skipped' WHERE tenant_id=${found.tenant_id}::uuid AND user_id=${used.user_id}::uuid`;
      await tx.configAudit.create({
        data: {
          tenantId: found.tenant_id,
          actorId: used.user_id,
          entityId: used.user_id,
          action: "user.password_recovered",
          detail: {},
        },
      });
      return { ok: true };
    });
  }
}
@Controller("auth")
export class RecoveryController {
  constructor(
    private readonly recovery: RecoveryService,
    private readonly auth: AuthService,
  ) {}
  @Post("forgot-password") forgot(@Req() request: FastifyRequest) {
    this.auth.checkOrigin(request);
    return this.recovery.forgot(request);
  }
  @Post("reset-password") reset(@Req() request: FastifyRequest) {
    this.auth.checkOrigin(request);
    return this.recovery.reset(request);
  }
}

export const lostMfaSchema = z
  .object({
    organisation: z.string().min(1).max(80),
    userId: z.string().uuid(),
    operator: z.string().trim().min(3).max(120),
    reason: z.string().trim().min(10).max(1000),
    verificationEvidence: z.string().trim().min(10).max(1000),
  })
  .strict();
export async function assertDatabaseOwner(db: PrismaClient) {
  const [role] = await db.$queryRaw<
    { allowed: boolean }[]
  >`SELECT pg_has_role(current_user,(SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='users'),'USAGE') AS allowed`;
  if (!role?.allowed) throw new Error("Database owner connection required");
}
/** Offline, operator-verified action. Email possession alone is never sufficient. */
export async function recoverLostMfa(db: PrismaClient, body: unknown, apply = false) {
  const input = lostMfaSchema.parse(body);
  await assertDatabaseOwner(db);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL row_security=off`;
    const tenant = await tx.tenant.findFirst({ where: { slug: input.organisation, active: true } });
    if (!tenant) throw new Error("Active organisation not found");
    await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenant.id},true)`;
    await lockConfiguration(tx, tenant.id);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mfa:${input.userId}`},0))`;
    const user = await tx.user.findFirst({
      where: {
        tenantId: tenant.id,
        id: input.userId,
        active: true,
        role: "admin",
        mfaEnrolled: true,
      },
    });
    if (!user) throw new Error("Enrolled active administrator not found in organisation");
    if (apply) {
      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaSecret: null,
          mfaEnrolled: false,
          mfaLastStep: -1,
          mfaFailures: 0,
          mfaLockedUntil: null,
          mfaPendingSessionId: null,
          mfaPendingExpiresAt: null,
          revision: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      await tx.session.deleteMany({ where: { tenantId: tenant.id, userId: user.id } });
      await tx.$executeRaw`UPDATE password_recoveries SET used_at=COALESCE(used_at,now()),status='skipped',encrypted_url=NULL,last_error='Operator recovery' WHERE tenant_id=${tenant.id}::uuid AND user_id=${user.id}::uuid`;
      await tx.configAudit.create({
        data: {
          tenantId: tenant.id,
          actorId: user.id,
          entityId: user.id,
          action: "mfa.operator_recovery",
          detail: {
            operator: input.operator,
            reason: input.reason,
            verificationEvidence: input.verificationEvidence,
          },
        },
      });
    }
    return {
      organisation: tenant.slug,
      userId: user.id,
      applied: apply,
      nextStep: "Sign in with the existing password and enrol a new authenticator",
    };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    files = args.filter((arg) => arg !== "--apply");
  try {
    if (files.length !== 1 || files[0]!.startsWith("-") || !process.env.MIGRATION_DATABASE_URL)
      throw new Error("Usage: node dist/recovery.js verified-recovery.json [--apply]");
    const contents = await readFile(resolve(files[0]!), "utf8");
    if (Buffer.byteLength(contents) > 10000) throw new Error("Input too large");
    const db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL, log: [] });
    try {
      console.info(
        JSON.stringify(
          await recoverLostMfa(
            db,
            JSON.parse(contents.replace(/^\uFEFF/, "")),
            args.includes("--apply"),
          ),
        ),
      );
    } finally {
      await db.$disconnect();
    }
  } catch {
    console.error(
      "Recovery failed. Validate the explicit organisation, administrator UUID, operator verification evidence and owner connection. No credentials are printed.",
    );
    process.exitCode = 1;
  }
}
