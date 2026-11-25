import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { PrismaClient, OperatorJob } from "@prisma/client";
import { z } from "zod";
import { operatorActionSchema } from "@astrama/contracts";
import { lockBillingReconciliation, lockConfigurationExclusive, type Tx } from "./database.js";
import { assertDatabaseOwner, recoverLostMfa } from "./recovery.js";
import { exportTenant, operatorStorage } from "./operator-data.js";
import { operatorAudit, operatorSupportAccess } from "./operator-access.js";
import { occupiedSeats } from "./modules/users/users.service.js";
import { paymentProvider, type PaymentProvider } from "./modules/billing/payment-provider.js";

const payloadSchema = z
  .object({
    input: operatorActionSchema,
    expectedPlanId: z.string().nullable(),
    expectedSubscriptionId: z.string().nullable(),
    expectedUserRevision: z.number().int().optional(),
    expectedUserEmail: z.string().email().optional(),
  })
  .strict();
type JobRow = OperatorJob;

async function authorizeOperator(tx: Tx, job: JobRow, ownerOnly = false) {
  const [operator] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM operators WHERE id=${job.operatorId}::uuid AND active AND mfa_enrolled
      AND (${ownerOnly}=false OR role='owner') FOR SHARE`;
  if (!operator) throw new Error("Operator authority is no longer available");
}

async function performJob(
  db: PrismaClient,
  tx: Tx,
  job: JobRow,
  options: { provider?: PaymentProvider; exportDirectory?: string },
) {
  const payload = payloadSchema.parse(job.payload),
    input = payload.input;
  if (input.action !== job.kind || input.reason !== job.reason)
    throw new Error("Job identity mismatch");
  await tx.$executeRaw`SELECT set_config('app.tenant_id',${job.tenantId},true)`;
  if (input.action === "export") {
    const root = options.exportDirectory ?? process.env.OPERATOR_EXPORT_DIRECTORY;
    if (!root || !isAbsolute(root)) throw new Error("Private export directory must be configured");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, `${job.id}-${randomUUID()}`);
    const result = await exportTenant(
      db,
      {
        tenantId: job.tenantId,
        expectedSlug: job.tenantSlug,
        operator: job.operatorId,
        reason: job.reason,
        evidence: `Console job ${job.id}`,
      },
      path,
      operatorStorage(),
      async (scope) => {
        await authorizeOperator(scope, job);
        const tenant = await scope.tenant.findFirst({
          where: { id: job.tenantId, slug: job.tenantSlug, active: true },
        });
        if (!tenant) throw new Error("Organisation is unavailable");
        await operatorSupportAccess(scope, job.operatorId, job.tenantId);
      },
    );
    return result.output;
  }
  if (input.action === "mfa-recovery") {
    const identity = `operator:${job.operatorId};job:${job.id}`;
    // Recovery commits its own transaction. A retry after process loss must never reset a newly enrolled authenticator again.
    const completed = await tx.configAudit.findFirst({
      where: {
        tenantId: job.tenantId,
        action: "mfa.operator_recovery",
        detail: { path: ["operator"], equals: identity },
      },
    });
    if (completed) return null;
    await recoverLostMfa(
      db,
      {
        organisation: job.tenantSlug,
        userId: input.userId,
        operator: identity,
        reason: job.reason,
        verificationEvidence: input.verificationEvidence,
      },
      true,
      async (scope) => {
        await authorizeOperator(scope, job);
        const user = await scope.user.findFirst({
          where: {
            tenantId: job.tenantId,
            id: input.userId,
            email: payload.expectedUserEmail,
            revision: payload.expectedUserRevision,
          },
        });
        if (payload.expectedUserRevision === undefined || !payload.expectedUserEmail || !user)
          throw new Error("Verified administrator identity changed");
      },
    );
    return null;
  }
  if (input.action !== "set-plan") throw new Error("Unknown privileged operator job");
  await lockBillingReconciliation(tx, job.tenantId);
  await lockConfigurationExclusive(tx, job.tenantId);
  await authorizeOperator(tx, job, true);
  await tx.$queryRaw`SELECT id FROM tenants WHERE id=${job.tenantId}::uuid FOR UPDATE`;
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: job.tenantId } });
  if (
    tenant.slug !== job.tenantSlug ||
    tenant.status === "deleted" ||
    tenant.revision !== input.revision ||
    (tenant.planId !== payload.expectedPlanId && tenant.planId !== input.planId) ||
    tenant.stripeSubscriptionId !== payload.expectedSubscriptionId
  )
    throw new Error("Organisation changed since the action was queued");
  await tx.$queryRaw`SELECT id FROM billing_plans WHERE id=${input.planId} FOR SHARE`;
  const plan = await tx.billingPlan.findFirst({ where: { id: input.planId, active: true } });
  if (!plan || input.seatLimit < (await occupiedSeats(tx, tenant.id)))
    throw new Error("Plan or seat limit is no longer available");
  if (tenant.stripeSubscriptionId) {
    if (!tenant.stripeCustomerId) throw new Error("Subscription customer is unavailable");
    await (options.provider ?? paymentProvider()).changePlan({
      tenantId: tenant.id,
      subscriptionId: tenant.stripeSubscriptionId,
      customerId: tenant.stripeCustomerId,
      planId: plan.id,
      priceId: plan.stripePriceId,
      interval: plan.billingInterval as "month" | "year",
      prorationBehavior: input.prorationBehavior,
      requestId: job.id,
    });
  }
  await tx.tenant.update({
    where: { id: tenant.id },
    data: {
      planId: plan.id,
      seatLimit: input.seatLimit,
      revision: { increment: 1 },
    },
  });
  return null;
}

/** Runs only in the existing trusted maintenance worker, never the HTTP API. */
export async function processOperatorJobs(
  db: PrismaClient,
  options: { provider?: PaymentProvider; exportDirectory?: string } = {},
) {
  await assertDatabaseOwner(db);
  const due = await db.operatorJob.findMany({
    where: { status: "queued", nextAttemptAt: { lte: new Date() } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 20,
    select: { id: true },
  });
  for (const candidate of due) {
    await db.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM operator_jobs WHERE id=${candidate.id}::uuid AND status='queued' AND next_attempt_at<=now()
        FOR UPDATE SKIP LOCKED`;
        if (!locked) return;
        const job = await tx.operatorJob.update({
          where: { id: locked.id },
          data: { status: "processing", attempts: { increment: 1 } },
        });
        await tx.$executeRawUnsafe("SAVEPOINT operator_work");
        try {
          const output = await performJob(db, tx, job, options);
          await operatorAudit(
            tx,
            job.operatorId,
            { id: job.tenantId, slug: job.tenantSlug },
            `operator.${job.kind}.completed`,
            job.reason,
            { jobId: job.id },
          );
          await tx.operatorJob.update({
            where: { id: job.id },
            data: {
              status: "complete",
              completedAt: new Date(),
              lastError: null,
              outputDirectory: output,
            },
          });
          await tx.$executeRawUnsafe("RELEASE SAVEPOINT operator_work");
        } catch (error) {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT operator_work");
          await tx.operatorJob.update({
            where: { id: job.id },
            data: {
              status: job.attempts >= 3 ? "failed" : "queued",
              nextAttemptAt: new Date(Date.now() + 60000),
              lastError:
                "Action failed. Check current permissions, organisation state and worker configuration.",
            },
          });
          await operatorAudit(
            tx,
            job.operatorId,
            { id: job.tenantId, slug: job.tenantSlug },
            `operator.${job.kind}.failed`,
            job.reason,
            { jobId: job.id, attempt: job.attempts },
          );
          console.error(
            JSON.stringify({
              event: "operator.job.failed",
              tenantSlug: job.tenantSlug,
              jobId: job.id,
              kind: job.kind,
              errorType: error instanceof Error ? error.name : "UnknownError",
            }),
          );
        }
      },
      { maxWait: 30000, timeout: 300000 },
    );
  }
}
