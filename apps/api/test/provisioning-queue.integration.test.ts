import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { PrismaClient } from "@prisma/client";
import type { INestApplicationContext } from "@nestjs/common";
import { deleteTenant } from "../src/operator-data.js";
import type { NotificationWorker } from "../src/modules/notifications/notifications.service.js";
import { createNotificationWorker } from "./notification-worker.helper.js";

process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "test";

// Real queue worker: needs the full configured hosted stack and must not run
// beside other fixture suites (the dispatcher processes the whole database).
const configured =
  process.env.DATABASE_URL &&
  process.env.MIGRATION_DATABASE_URL &&
  process.env.S3_ENDPOINT &&
  process.env.CLAMAV_HOST &&
  process.env.SMTP_HOST &&
  process.env.RUN_QUEUE_TESTS === "true";

describe.skipIf(!configured)("real provisioning queue delivery", () => {
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const fixture = randomUUID();
  const slug = `queue-${fixture.slice(0, 8)}`;
  const email = `${fixture}@example.invalid`;
  const verificationHash = createHash("sha256").update(fixture).digest("hex");
  let signupId: string,
    tenantId: string,
    workerContext: INestApplicationContext,
    worker: NotificationWorker;
  const previousMode = process.env.PLATFORM_MODE,
    previousBase = process.env.APP_BASE_DOMAIN;
  // A fresh trial fixture is not due lifecycle deletion, so deletion runs as a
  // plain execute/offline operator deletion scoped to this tenant.
  const deletionRequest = () => ({
    tenantId,
    expectedSlug: slug,
    operator: "integration-test",
    reason: "Disposable provisioning-queue fixture",
    evidence: "TEST-AUTHORIZATION-ONLY",
    execute: true,
    offline: true,
  });

  beforeAll(async () => {
    process.env.PLATFORM_MODE = "hosted";
    process.env.APP_BASE_DOMAIN = "astrama.test";
    const [request] = await owner.$queryRaw<{ id: string }[]>`
      SELECT public.begin_public_signup(
        ${slug},${"Queue company"},${"Queue admin"},${email},${"UTC"},
        ${null},${verificationHash},${new Date(Date.now() + 86400000)}::timestamptz
      ) AS id`;
    signupId = request!.id;
    await owner.signupRequest.update({
      where: { id: signupId },
      data: { verifiedAt: new Date() },
    });
    await owner.signupProvisionJob.create({ data: { signupId } });
  }, 30000);

  afterAll(async () => {
    await workerContext?.close();
    if (tenantId) await deleteTenant(owner, deletionRequest());
    if (signupId) {
      await owner.signupProvisionJob.deleteMany({ where: { signupId } });
      await owner.signupRequest.deleteMany({ where: { id: signupId } });
      await owner.$executeRaw`DELETE FROM pgboss.job WHERE name='tenant-provisioning' AND data->>'signupId'=${signupId}`;
    }
    if (previousMode === undefined) delete process.env.PLATFORM_MODE;
    else process.env.PLATFORM_MODE = previousMode;
    if (previousBase === undefined) delete process.env.APP_BASE_DOMAIN;
    else process.env.APP_BASE_DOMAIN = previousBase;
    await owner.$disconnect();
  }, 60000);

  it("provisions exactly one organisation for a committed verified signup through the real queue", async () => {
    ({ context: workerContext, worker } = await createNotificationWorker());
    try {
      await worker.start();
      await expect
        .poll(
          async () =>
            (await owner.signupRequest.findUniqueOrThrow({ where: { id: signupId } }))
              .provisionedTenantId,
          { timeout: 30000, interval: 500 },
        )
        .toBeTruthy();
      const signup = await owner.signupRequest.findUniqueOrThrow({ where: { id: signupId } });
      tenantId = signup.provisionedTenantId!;
      await expect
        .poll(
          async () =>
            (
              await owner.signupProvisionJob.findUniqueOrThrow({
                where: { signupId },
                select: { status: true },
              })
            ).status,
          { timeout: 30000, interval: 100 },
        )
        .toBe("complete");
      expect(await owner.tenant.count({ where: { slug } })).toBe(1);
      expect(await owner.user.count({ where: { tenantId, role: "admin" } })).toBe(1);
      expect(
        await owner.inboundMailAddress.findUniqueOrThrow({
          where: { address: `${slug}@in.astrama.test` },
        }),
      ).toMatchObject({ tenantId, isGeneral: true });

      // Duplicate dispatch (now with generated queue IDs) and a retry must not
      // create a second tenant for the same verified signup.
      const boss = new PgBoss({
        connectionString: process.env.DATABASE_URL,
        schema: "pgboss",
        createSchema: false,
      });
      await boss.start();
      try {
        await boss.send("tenant-provisioning", { signupId });
        await boss.send("tenant-provisioning", { signupId });
        await owner.signupProvisionJob.update({
          where: { signupId },
          data: { status: "queued", nextAttempt: new Date() },
        });
        await expect
          .poll(
            async () =>
              (
                await owner.signupProvisionJob.findUniqueOrThrow({
                  where: { signupId },
                  select: { status: true },
                })
              ).status === "complete",
            { timeout: 30000, interval: 500 },
          )
          .toBe(true);
      } finally {
        await boss.stop();
      }
      expect(
        (await owner.signupRequest.findUniqueOrThrow({ where: { id: signupId } }))
          .provisionedTenantId,
      ).toBe(tenantId);
      expect(await owner.tenant.count({ where: { slug } })).toBe(1);
      expect(await owner.user.count({ where: { tenantId, role: "admin" } })).toBe(1);
    } finally {
      await worker.stop();
    }
  }, 90000);
});
