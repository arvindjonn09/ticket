import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { encryptSecret } from "../src/mfa.js";
import { tokenHash } from "../src/modules/auth/auth.service.js";
import { TestPaymentProvider } from "../dist/modules/billing/payment-provider.js";
import { lockBillingReconciliation } from "../src/database.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
type Identity = { id: string; cookie: string; csrf: string };
describe.skipIf(!enabled)("audited operator actions and trusted jobs — real PostgreSQL", () => {
  let owner: PrismaClient, runtime: PrismaClient, app: NestFastifyApplication;
  let tenantId: string, adminId: string, invitedId: string, exportRoot: string;
  let support: Identity, operator: Identity;
  const fixture = randomUUID(),
    slug = `actions-${fixture}`;
  const planA = `ops-a-${fixture}`,
    planB = `ops-b-${fixture}`;
  const previous = new Map<string, string | undefined>();
  const request = (
    method: "GET" | "POST",
    path: string,
    identity: Identity,
    payload?: unknown,
    key = randomUUID(),
  ) =>
    app.inject({
      method,
      url: `/api/operator${path}`,
      headers: {
        host: "ops.astrama.test",
        origin: "https://ops.astrama.test",
        cookie: identity.cookie,
        "x-csrf-token": identity.csrf,
        "idempotency-key": key,
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const reason = "Customer-approved maintenance for integration fixture";
  const organisation = () => owner.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const action = async (identity: Identity, payload: Record<string, unknown>, key?: string) =>
    request(
      "POST",
      `/organisations/${tenantId}/actions`,
      identity,
      { reason, revision: (await organisation()).revision, ...payload },
      key,
    );
  async function identity(role: "owner" | "support"): Promise<Identity> {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    await owner.operator.create({
      data: {
        id,
        role,
        name: role,
        email: `${role}-${fixture}@test.invalid`,
        passwordHash: "not-a-login-hash",
        mfaEnrolled: true,
        encryptedMfaSecret: encryptSecret("JBSWY3DPEHPK3PXP", `operator:${id}`),
      },
    });
    await owner.operatorSession.create({
      data: {
        operatorId: id,
        tokenHash: tokenHash(token),
        csrfToken: csrf,
        mfaVerified: true,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return { id, cookie: `astrama_operator_session=${token}`, csrf };
  }
  beforeAll(async () => {
    for (const [key, value] of Object.entries({
      NODE_ENV: "test",
      PLATFORM_MODE: "hosted",
      APP_BASE_DOMAIN: "astrama.test",
      PUBLIC_SITE_ORIGIN: "https://astrama.test",
      OPERATOR_ORIGIN: "https://ops.astrama.test",
      OPERATOR_IP_ALLOWLIST: "",
    })) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    exportRoot = await mkdtemp(join(tmpdir(), "astrama-operator-jobs-"));
    operator = await identity("owner");
    support = await identity("support");
    const tenant = await owner.tenant.create({
      data: {
        slug,
        name: "Action fixture",
        brandName: "Fixture",
        status: "trial",
        trialEndsAt: new Date(Date.now() + 15 * 86400000),
        seatLimit: 10,
      },
    });
    tenantId = tenant.id;
    adminId = randomUUID();
    await owner.user.create({
      data: {
        id: adminId,
        tenantId,
        name: "Verified administrator",
        email: `${fixture}@admin.invalid`,
        role: "admin",
        passwordHash: "!",
        mfaEnrolled: true,
        mfaSecret: encryptSecret("JBSWY3DPEHPK3PXP", `${tenantId}:${adminId}`),
      },
    });
    invitedId = (
      await owner.user.create({
        data: {
          tenantId,
          name: "Invited administrator",
          email: `invited-${fixture}@admin.invalid`,
          role: "admin",
          active: false,
          passwordHash: "!",
          invitationHash: `initial-${fixture}`,
          invitationExpiresAt: new Date(Date.now() + 3600000),
        },
      })
    ).id;
    for (const actor of [operator, support])
      await owner.operatorSupportGrant.create({
        data: {
          tenantId,
          operatorId: actor.id,
          grantedById: adminId,
          reason,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
    const { createApp } = await import("../dist/main.js");
    app = await createApp();
    await app.getHttpAdapter().getInstance().ready();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    if (owner && tenantId) {
      for (const table of [
        "operator_jobs",
        "operator_support_grants",
        "password_recoveries",
        "invitation_mails",
        "config_audits",
        "tenant_lifecycle_notices",
        "sessions",
        "users",
        "tenants",
      ])
        await owner.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "${table === "tenants" ? "id" : "tenant_id"}"=$1::uuid`,
          tenantId,
        );
      for (const actor of [operator, support]) {
        await owner.operatorSession.deleteMany({ where: { operatorId: actor.id } });
        await owner.operator.update({ where: { id: actor.id }, data: { active: false } });
      }
      await owner.billingPlan.deleteMany({ where: { id: { in: [planA, planB] } } });
    }
    await owner?.$disconnect();
    await runtime?.$disconnect();
    if (exportRoot) await rm(exportRoot, { recursive: true });
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  it("denies owner actions to support while auditing invitation and explicit trial extension", async () => {
    for (const payload of [
      { action: "suspend" },
      { action: "reactivate" },
      {
        action: "schedule-deletion",
        expectedSlug: slug,
        confirmed: true,
        deleteAfter: new Date(Date.now() + 45 * 86400000).toISOString(),
      },
      { action: "set-plan", planId: planA, seatLimit: 4, prorationBehavior: "none" },
    ])
      expect((await action(support, payload)).statusCode).toBe(403);
    const invited = await action(support, { action: "resend-invite", userId: invitedId });
    expect(invited.statusCode, invited.body).toBe(201);
    expect(invited.body).not.toContain("token=");
    expect(
      await owner.invitationMail.count({
        where: { tenantId, userId: invitedId, status: "pending" },
      }),
    ).toBe(1);
    const later = new Date(Date.now() + 20 * 86400000);
    const extended = await action(support, {
      action: "extend-trial",
      trialEndsAt: later.toISOString(),
    });
    expect(extended.statusCode, extended.body).toBe(201);
    expect((await organisation()).trialEndsAt?.toISOString()).toBe(later.toISOString());
    expect(
      await owner.operatorAudit.count({
        where: {
          tenantId,
          operatorId: support.id,
          action: { in: ["operator.resend-invite", "operator.extend-trial"] },
        },
      }),
    ).toBe(2);
    const metadata = await request("GET", `/organisations/${tenantId}`, support);
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(metadata.json().adminContacts).toHaveLength(2);
  });
  it("edits plans as owner, runs idempotent/retriable plan jobs and preserves seat overrides on renewal", async () => {
    for (const [id, suffix] of [
      [planA, "a"],
      [planB, "b"],
    ]) {
      const plan = {
        id,
        name: `Plan ${suffix}`,
        stripePriceId: `price_${suffix}${fixture.replaceAll("-", "")}`,
        seatLimit: 4,
        billingInterval: "month",
        active: true,
        reason,
        revision: 0,
      };
      expect((await request("POST", "/plans", support, plan)).statusCode).toBe(403);
      const saved = await request("POST", "/plans", operator, plan);
      expect(saved.statusCode, saved.body).toBe(201);
    }
    const key = randomUUID(),
      body = { action: "set-plan", planId: planA, seatLimit: 7, prorationBehavior: "none" };
    const queued = await action(operator, body, key);
    expect(queued.statusCode, queued.body).toBe(201);
    expect((await action(operator, body, key)).json().jobId).toBe(key);
    const { processOperatorJobs } = await import("../dist/operator-jobs.js");
    await Promise.all([processOperatorJobs(owner), processOperatorJobs(owner)]);
    expect(await organisation()).toMatchObject({ planId: planA, seatLimit: 7, status: "trial" });
    expect((await owner.operatorJob.findUniqueOrThrow({ where: { id: key } })).status).toBe(
      "complete",
    );
    await owner.tenant.update({
      where: { id: tenantId },
      data: { stripeSubscriptionId: `sub_${fixture}`, stripeCustomerId: `cus_${fixture}` },
    });
    const second = await action(operator, {
      action: "set-plan",
      planId: planB,
      seatLimit: 9,
      prorationBehavior: "create_prorations",
    });
    expect(second.statusCode, second.body).toBe(201);
    class RetryingProvider extends TestPaymentProvider {
      calls = 0;
      async changePlan() {
        if (++this.calls === 1) throw new Error("Fixture network outage");
      }
    }
    const provider = new RetryingProvider();
    await processOperatorJobs(owner, { provider });
    expect((await organisation()).planId).toBe(planA);
    await owner.operatorJob.update({
      where: { id: second.json().jobId },
      data: { nextAttemptAt: new Date(0) },
    });
    await Promise.all([
      processOperatorJobs(owner, { provider }),
      processOperatorJobs(owner, { provider }),
    ]);
    expect(provider.calls).toBe(2);
    expect(await organisation()).toMatchObject({ planId: planB, seatLimit: 9 });
    await runtime.$queryRaw`SELECT apply_billing_event(${`evt_${fixture}`},'invoice.paid',${tenantId}::uuid,
      ${planB},${`cus_${fixture}`},${`sub_${fixture}`},'activate')`;
    expect((await organisation()).seatLimit).toBe(9);
    const changedCommercialTerms = await request("POST", "/plans", operator, {
      id: planB,
      name: "Unsafe edit",
      stripePriceId: "price_changed",
      seatLimit: 100,
      billingInterval: "month",
      active: true,
      reason,
      revision: 0,
    });
    expect(changedCommercialTerms.statusCode, changedCommercialTerms.body).toBe(409);
  });
  it("serializes live webhook reads against operator plan updates per organisation", async () => {
    const { processOperatorJobs } = await import("../dist/operator-jobs.js");
    const queued = await action(operator, {
      action: "set-plan",
      planId: planA,
      seatLimit: 11,
      prorationBehavior: "none",
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const signal = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const acquired = signal(),
      unlock = signal(),
      liveRead = signal();
    let livePlan = planB,
      lookups = 0,
      changes = 0;
    const event = {
      id: `evt_race_${fixture}`,
      type: "invoice.paid",
      tenantId,
      planId: planB,
      customerId: `cus_${fixture}`,
      subscriptionId: `sub_${fixture}`,
      transition: "activate" as const,
    };
    const spy = vi.spyOn(TestPaymentProvider.prototype, "webhook").mockImplementation(async () => {
      lookups++;
      const captured = livePlan;
      await liveRead.promise;
      return { ...event, planId: captured };
    });
    class ChangingProvider extends TestPaymentProvider {
      async changePlan() {
        changes++;
        livePlan = planA;
      }
    }
    const held = owner.$transaction(
      async (tx) => {
        await lockBillingReconciliation(tx, tenantId);
        acquired.resolve();
        await unlock.promise;
      },
      { timeout: 30000 },
    );
    await acquired.promise;
    const raw = JSON.stringify(event);
    const signature = createHmac(
      "sha256",
      process.env.TEST_PAYMENT_WEBHOOK_SECRET ?? "ci-payment-secret",
    )
      .update(raw)
      .digest("hex");
    const hook = Promise.resolve(
      app.inject({
        method: "POST",
        url: "/api/billing/webhook",
        headers: {
          host: "astrama.test",
          "content-type": "application/json",
          "x-test-signature": `sha256=${signature}`,
        },
        payload: raw,
      }),
    );
    const jobs = processOperatorJobs(owner, { provider: new ChangingProvider() });
    try {
      let blocked = 0;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [row] = await owner.$queryRaw<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
        blocked = row!.count;
        if (blocked >= 2) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      expect(blocked).toBeGreaterThanOrEqual(2);
      expect(lookups).toBe(0);
      expect(changes).toBe(0);
    } finally {
      unlock.resolve();
      liveRead.resolve();
      await held;
      await Promise.all([jobs, hook]);
      spy.mockRestore();
    }
    const response = await hook;
    expect(response.statusCode, response.body).toBe(201);
    expect(await organisation()).toMatchObject({ planId: planA, seatLimit: 11 });
    expect(lookups).toBe(1);
    expect(changes).toBe(1);
  });
  it("wraps private export and verified MFA recovery; revocation blocks queued content access and recovery retries do not reset twice", async () => {
    const { processOperatorJobs } = await import("../dist/operator-jobs.js");
    const exported = await action(operator, { action: "export" });
    expect(exported.statusCode, exported.body).toBe(201);
    await processOperatorJobs(owner, { exportDirectory: exportRoot });
    const job = await owner.operatorJob.findUniqueOrThrow({ where: { id: exported.json().jobId } });
    expect(job.status).toBe("complete");
    expect(
      JSON.parse(await readFile(join(job.outputDirectory!, "manifest.json"), "utf8")).tenantId,
    ).toBe(tenantId);
    const deniedExport = await action(operator, { action: "export" });
    await owner.operatorSupportGrant.updateMany({
      where: { tenantId, operatorId: operator.id },
      data: { revokedAt: new Date() },
    });
    await processOperatorJobs(owner, { exportDirectory: exportRoot });
    const denied = await owner.operatorJob.findUniqueOrThrow({
      where: { id: deniedExport.json().jobId },
    });
    expect(denied.outputDirectory).toBeNull();
    expect(denied.status).toBe("queued");
    await owner.operatorJob.update({ where: { id: denied.id }, data: { status: "failed" } });
    const recovered = await action(support, {
      action: "mfa-recovery",
      userId: adminId,
      verificationEvidence: "Offline identity proof confirmed with authorised contact",
      verified: true,
    });
    expect(recovered.statusCode, recovered.body).toBe(201);
    await processOperatorJobs(owner);
    expect((await owner.user.findUniqueOrThrow({ where: { id: adminId } })).mfaEnrolled).toBe(
      false,
    );
    await owner.user.update({
      where: { id: adminId },
      data: {
        mfaEnrolled: true,
        mfaSecret: encryptSecret("JBSWY3DPEHPK3PXP", `${tenantId}:${adminId}`),
        revision: { increment: 1 },
      },
    });
    await owner.operatorJob.update({
      where: { id: recovered.json().jobId },
      data: { status: "queued", nextAttemptAt: new Date(0) },
    });
    await processOperatorJobs(owner);
    expect((await owner.user.findUniqueOrThrow({ where: { id: adminId } })).mfaEnrolled).toBe(true);
    const visibleJobs = await request("GET", `/organisations/${tenantId}/jobs`, support);
    expect(visibleJobs.statusCode, visibleJobs.body).toBe(200);
    expect(visibleJobs.body).not.toContain(exportRoot);
    expect(visibleJobs.body).not.toContain("Offline identity proof");
  });
  it("requires explicit deletion confirmation and records owner suspension, reactivation and retention changes", async () => {
    const bad = await action(operator, {
      action: "schedule-deletion",
      expectedSlug: "wrong-slug",
      confirmed: true,
      deleteAfter: new Date(Date.now() + 45 * 86400000).toISOString(),
    });
    expect(bad.statusCode).toBe(400);
    expect((await action(operator, { action: "suspend" })).statusCode).toBe(201);
    expect((await organisation()).active).toBe(false);
    expect((await action(operator, { action: "reactivate" })).statusCode).toBe(201);
    const scheduled = await action(operator, {
      action: "schedule-deletion",
      expectedSlug: slug,
      confirmed: true,
      deleteAfter: new Date(Date.now() + 45 * 86400000).toISOString(),
    });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    expect((await organisation()).readOnlyReason).toBe("operator");
    expect(
      (
        await action(operator, {
          action: "extend-retention",
          deleteAfter: new Date(Date.now() + 60 * 86400000).toISOString(),
        })
      ).statusCode,
    ).toBe(201);
    expect((await action(operator, { action: "reactivate" })).statusCode).toBe(201);
    expect(await organisation()).toMatchObject({
      active: true,
      status: "active",
      readOnlyReason: null,
      deleteAfter: null,
    });
    await owner.tenant.update({
      where: { id: tenantId },
      data: {
        active: false,
        status: "read_only",
        readOnlyReason: "payment_failed",
        readOnlySince: new Date(),
        deleteAfter: new Date(Date.now() + 86400000),
      },
    });
    expect((await action(operator, { action: "reactivate" })).statusCode).toBe(201);
    expect(await organisation()).toMatchObject({
      active: true,
      status: "read_only",
      readOnlyReason: "payment_failed",
    });
  });
});
