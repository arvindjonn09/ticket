import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { deleteTenant, operatorStorage } from "../src/operator-data.js";
import { TestPaymentProvider } from "../src/modules/billing/payment-provider.js";
import { defaultDataPolicy } from "@astrama/contracts";

process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "test";

const enabled = Boolean(
  process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL && process.env.S3_ENDPOINT,
);

interface Fixture {
  tenantId: string;
  slug: string;
  subscriptionId: string;
}

const hold = { ...defaultDataPolicy, legalHold: true };

describe.skipIf(!enabled)("BL-03: Stripe cancellation guards tenant deletion", () => {
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const cancelSpy = vi.spyOn(TestPaymentProvider.prototype, "cancel");
  const fixtures: Fixture[] = [];
  const storageKeys: string[] = [];
  let storage: S3Client;

  beforeAll(async () => {
    storage = operatorStorage();
    for (const [name, hold_] of [
      ["ok", false],
      ["fail", false],
      ["reactivated", false],
      ["hold", true],
    ] as const) {
      const id = randomUUID();
      const tenant = await owner.tenant.create({
        data: {
          slug: `bl03-${name}-${id.slice(0, 8)}`,
          name: `BL03 ${name} fixture`,
          brandName: "BL03 fixture",
          status: name === "reactivated" ? "active" : "read_only",
          readOnlySince: name === "reactivated" ? null : new Date(Date.now() - 46 * 86400000),
          deleteAfter: name === "reactivated" ? null : new Date(Date.now() - 3600000),
          stripeSubscriptionId: `sub_${id.replaceAll("-", "").slice(0, 12)}`,
        },
      });
      fixtures.push({
        tenantId: tenant.id,
        slug: tenant.slug,
        subscriptionId: tenant.stripeSubscriptionId!,
      });
      const key = `${tenant.id}/fixture/${randomUUID()}`;
      storageKeys.push(key);
      await storage.send(
        new PutObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key, Body: "BL03 fixture" }),
      );
      if (hold_)
        await owner.$executeRaw`INSERT INTO tenant_data_policies(tenant_id,revision,policy) VALUES(${tenant.id}::uuid,0,${JSON.stringify({ ...hold, revision: 0 })}::jsonb)`;
    }
  }, 30000);

  afterAll(async () => {
    for (const fixture of fixtures) {
      await owner.$executeRaw`DELETE FROM tenant_data_policies WHERE tenant_id=${fixture.tenantId}::uuid`;
      await owner.$executeRaw`DELETE FROM tenant_deletion_jobs WHERE tenant_id=${fixture.tenantId}::uuid`;
      await owner.$executeRaw`DELETE FROM data_operation_audits WHERE tenant_id=${fixture.tenantId}::uuid`;
      await owner.tenant.deleteMany({ where: { id: fixture.tenantId } });
    }
    for (const Key of storageKeys)
      await storage
        ?.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET!, Key }))
        .catch(() => {});
    await owner.$disconnect();
    storage?.destroy();
  }, 30000);

  afterEach(() => {
    cancelSpy.mockClear();
    cancelSpy.mockImplementation(async () => {});
  });

  const lifecycleRequest = (fixture: Fixture, execute = false) => ({
    tenantId: fixture.tenantId,
    expectedSlug: fixture.slug,
    operator: "integration-test",
    reason: "Disposable BL-03 deletion fixture",
    evidence: "TEST-AUTHORIZATION-ONLY",
    execute,
    offline: true,
    lifecycle: true,
  });

  it("cancels the subscription before deletion and keeps the reference in the durable audit", async () => {
    const fixture = fixtures[0]!;
    await deleteTenant(owner, lifecycleRequest(fixture, true), storage);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith(fixture.subscriptionId, {
      tenantId: fixture.tenantId,
      customerId: "",
    });
    expect(await owner.tenant.findUnique({ where: { id: fixture.tenantId } })).toBeNull();
    await expect(
      storage.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: storageKeys[0]! })),
    ).rejects.toThrow();
    // The audit table has no tenant FK: the reference survives tenant removal.
    const audits = await owner.$queryRaw<{ outcome: string; evidence: string }[]>`
      SELECT outcome,evidence FROM data_operation_audits
      WHERE tenant_id=${fixture.tenantId}::uuid AND operation='delete' ORDER BY created_at`;
    expect(audits.map((row) => row.outcome)).toEqual(["requested", "completed"]);
    for (const row of audits)
      expect(row.evidence).toContain(`cancelled billing subscription ${fixture.subscriptionId}`);
  }, 60000);

  it("cancellation failure leaves tenant, data and status intact and a retry completes", async () => {
    const fixture = fixtures[1]!;
    const preview = await deleteTenant(owner, lifecycleRequest(fixture), storage);
    expect(preview.execute).toBe(false);
    expect(cancelSpy).not.toHaveBeenCalled();
    cancelSpy.mockImplementationOnce(async () => {
      throw new Error("Stripe outage");
    });
    await expect(deleteTenant(owner, lifecycleRequest(fixture, true), storage)).rejects.toThrow(
      "Stripe outage",
    );
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    const tenant = await owner.tenant.findUniqueOrThrow({ where: { id: fixture.tenantId } });
    expect(tenant.status).toBe("read_only");
    expect(tenant.stripeSubscriptionId).toBe(fixture.subscriptionId);
    expect(
      await owner.$queryRaw`SELECT tenant_id FROM tenant_deletion_jobs WHERE tenant_id=${fixture.tenantId}::uuid`,
    ).toEqual([]);
    expect(
      await owner.$queryRaw<{ outcome: string }[]>`
        SELECT outcome FROM data_operation_audits
        WHERE tenant_id=${fixture.tenantId}::uuid AND operation='delete'`,
    ).toEqual([{ outcome: "failed_retry_required" }]);
    expect(
      (
        await storage.send(
          new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: storageKeys[1]! }),
        )
      ).Body,
    ).toBeTruthy();
    await deleteTenant(owner, lifecycleRequest(fixture, true), storage);
    expect(cancelSpy).toHaveBeenCalledTimes(2);
    expect(await owner.tenant.findUnique({ where: { id: fixture.tenantId } })).toBeNull();
  }, 60000);

  it("a reactivated tenant is not due for deletion, so the subscription is never cancelled", async () => {
    const fixture = fixtures[2]!;
    await expect(deleteTenant(owner, lifecycleRequest(fixture, true), storage)).rejects.toThrow();
    expect(cancelSpy).not.toHaveBeenCalled();
    const tenant = await owner.tenant.findUniqueOrThrow({ where: { id: fixture.tenantId } });
    expect(tenant.status).toBe("active");
    expect(tenant.stripeSubscriptionId).toBe(fixture.subscriptionId);
  }, 60000);

  it("previews and legal holds never touch the provider", async () => {
    const held = fixtures[3]!;
    await expect(deleteTenant(owner, lifecycleRequest(held), storage)).rejects.toThrow(
      "Legal hold",
    );
    await expect(deleteTenant(owner, lifecycleRequest(held, true), storage)).rejects.toThrow(
      "Legal hold",
    );
    expect(cancelSpy).not.toHaveBeenCalled();
    const tenant = await owner.tenant.findUniqueOrThrow({ where: { id: held.tenantId } });
    expect(tenant.status).toBe("read_only");
    expect(tenant.stripeSubscriptionId).toBe(held.subscriptionId);
  }, 60000);
});
