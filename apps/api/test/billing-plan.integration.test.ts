import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const rollback = new Error("rollback billing plan integration fixture");

interface Fixture {
  planId: string;
  subscribedTenantId: string;
  otherTenantId: string;
}

describe.skipIf(!enabled)("retired billing plan renewals", () => {
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });

  afterAll(async () => owner.$disconnect());

  async function withRetiredPlan(
    run: (tx: Prisma.TransactionClient, fixture: Fixture) => Promise<void>,
  ) {
    try {
      await owner.$transaction(async (tx) => {
        const id = randomUUID();
        const planId = `retired-${id.slice(0, 8)}`;
        await tx.billingPlan.create({
          data: {
            id: planId,
            name: "Retired plan",
            stripePriceId: `price_${id.replaceAll("-", "")}`,
            seatLimit: 40,
            billingInterval: "month",
          },
        });
        const subscribed = await tx.tenant.create({
          data: {
            slug: `retired-sub-${id.slice(0, 8)}`,
            name: "Retired subscriber",
            brandName: "Retired subscriber",
            status: "trial",
            trialEndsAt: new Date(Date.now() + 15 * 24 * 3600000),
            seatLimit: 55,
            planId,
            stripeSubscriptionId: "sub_existing",
          },
        });
        const other = await tx.tenant.create({
          data: {
            slug: `retired-other-${id.slice(0, 8)}`,
            name: "Other tenant",
            brandName: "Other tenant",
            status: "trial",
            trialEndsAt: new Date(Date.now() + 15 * 24 * 3600000),
            stripeSubscriptionId: "sub_shared",
          },
        });
        await tx.billingPlan.update({ where: { id: planId }, data: { active: false } });
        await run(tx, {
          planId,
          subscribedTenantId: subscribed.id,
          otherTenantId: other.id,
        });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  const apply = (
    tx: Prisma.TransactionClient,
    eventId: string,
    tenantId: string,
    planId: string,
    subscriptionId: string,
  ) =>
    tx.$queryRaw<{ applied: boolean }[]>`
      SELECT public.apply_billing_event(${eventId},${"customer.subscription.updated"},${tenantId}::uuid,
        ${planId},${"cus_retired"},${subscriptionId},${"activate"}) AS applied`;

  const eventCount = async (tx: Prisma.TransactionClient, eventId: string) =>
    (
      await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM public.billing_provider_events
        WHERE provider='stripe' AND event_id=${eventId}`
    )[0]?.count;

  it("renews an existing inactive-plan subscription idempotently and keeps the current seat limit", async () => {
    await withRetiredPlan(async (tx, fixture) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE astrama_app");
      const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
      expect(
        (await apply(tx, eventId, fixture.subscribedTenantId, fixture.planId, "sub_existing"))[0]
          ?.applied,
      ).toBe(true);
      expect(
        (await apply(tx, eventId, fixture.subscribedTenantId, fixture.planId, "sub_existing"))[0]
          ?.applied,
      ).toBe(false);
      await tx.$executeRawUnsafe("RESET ROLE");
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: fixture.subscribedTenantId },
      });
      expect(tenant.status).toBe("active");
      expect(tenant.planId).toBe(fixture.planId);
      expect(tenant.seatLimit).toBe(55);
      expect(tenant.stripeSubscriptionId).toBe("sub_existing");
    });
  });

  it("rejects an inactive-plan new subscription without persisting the event", async () => {
    await withRetiredPlan(async (tx, fixture) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE astrama_app");
      const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
      await tx.$executeRawUnsafe("SAVEPOINT billing_reject");
      await expect(
        apply(tx, eventId, fixture.subscribedTenantId, fixture.planId, "sub_new"),
      ).rejects.toThrow(/billing plan is unavailable/);
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT billing_reject");
      await tx.$executeRawUnsafe("RESET ROLE");
      expect(await eventCount(tx, eventId)).toBe(0n);
    });
  });

  it("rejects another tenant using the inactive plan without persisting the event", async () => {
    await withRetiredPlan(async (tx, fixture) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE astrama_app");
      const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
      await tx.$executeRawUnsafe("SAVEPOINT billing_reject");
      await expect(
        apply(tx, eventId, fixture.otherTenantId, fixture.planId, "sub_shared"),
      ).rejects.toThrow(/billing plan is unavailable/);
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT billing_reject");
      await tx.$executeRawUnsafe("RESET ROLE");
      expect(await eventCount(tx, eventId)).toBe(0n);
    });
  });
});
