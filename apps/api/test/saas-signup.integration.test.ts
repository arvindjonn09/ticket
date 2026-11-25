import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const rollback = new Error("rollback signup integration fixture");

describe.skipIf(!enabled)("SaaS signup database functions", () => {
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });

  afterAll(async () => owner.$disconnect());

  it("returns organisation slugs only for a matching active member email", async () => {
    await owner
      .$transaction(async (tx) => {
        const fixture = randomUUID(),
          slug = `lookup-${fixture.slice(0, 8)}`;
        const tenant = await tx.tenant.create({
          data: {
            slug,
            name: "Lookup fixture",
            brandName: "Lookup fixture",
            status: "trial",
            trialEndsAt: new Date(Date.now() + 15 * 24 * 3600000),
          },
        });
        await tx.user.create({
          data: {
            tenantId: tenant.id,
            name: "Lookup admin",
            email: `${fixture}@example.invalid`,
            passwordHash: "not-a-login-hash",
            role: "admin",
            active: true,
          },
        });
        await tx.$executeRawUnsafe("SET LOCAL ROLE astrama_app");
        expect(
          await tx.$queryRaw<
            { slug: string }[]
          >`SELECT * FROM public.public_organisation_links(${`${fixture}@example.invalid`})`,
        ).toEqual([{ slug }]);
        expect(
          await tx.$queryRaw<
            { slug: string }[]
          >`SELECT * FROM public.public_organisation_links(${"absent@example.invalid"})`,
        ).toEqual([]);
        await tx.$executeRawUnsafe("RESET ROLE");
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  it("serializes concurrent slug reservations so only one request wins", async () => {
    const slug = `race-${randomUUID().slice(0, 8)}`;
    const reservations = await Promise.allSettled(
      [0, 1].map(
        (index) =>
          owner.$queryRaw<{ id: string }[]>`
          SELECT public.begin_public_signup(
            ${slug},${"Race company"},${"Race admin"},${`race-${index}@example.invalid`},${"UTC"},
            ${null},${createHash("sha256").update(randomUUID()).digest("hex")},${new Date(Date.now() + 86400000)}::timestamptz
          ) AS id`,
      ),
    );
    expect(reservations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(reservations.filter((result) => result.status === "rejected")).toHaveLength(1);
    await owner.signupRequest.deleteMany({ where: { slug } });
  });

  it("provisions an idempotent trial tenant and applies one billing event", async () => {
    const fixture = randomUUID(),
      planId = `test-${fixture.slice(0, 8)}`,
      slug = `trial-${fixture.slice(0, 8)}`,
      tenantId = randomUUID(),
      adminId = randomUUID(),
      secondTenantId = randomUUID(),
      secondAdminId = randomUUID(),
      invitationHash = createHash("sha256").update(fixture).digest("hex"),
      expiry = new Date(Date.now() + 48 * 3600000),
      eventId = `evt_${fixture.replaceAll("-", "")}`;
    const starter = JSON.parse(
      await readFile(new URL("../prisma/starter-v1.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    try {
      await owner.$transaction(async (tx) => {
        await tx.billingPlan.create({
          data: {
            id: planId,
            name: "Integration plan",
            stripePriceId: `price_${fixture.replaceAll("-", "")}`,
            seatLimit: 40,
            billingInterval: "month",
          },
        });
        await tx.$executeRawUnsafe("SET LOCAL ROLE astrama_app");
        const [request] = await tx.$queryRaw<{ id: string }[]>`
          SELECT public.begin_public_signup(
            ${slug},${"Integration company"},${"Integration admin"},${`${fixture}@example.invalid`},${"Australia/Sydney"},
            ${planId},${createHash("sha256").update(fixture).digest("hex")},${expiry}::timestamptz
          ) AS id`;
        expect(request?.id).toBeTruthy();
        await tx.signupRequest.update({
          where: { id: request!.id },
          data: { verifiedAt: new Date() },
        });
        const provision = (id: string, userId: string) =>
          tx.$queryRaw<{ tenant_id: string; tenant_slug: string }[]>`
            SELECT * FROM public.provision_verified_signup(
              ${request!.id}::uuid,${id}::uuid,${userId}::uuid,${"test-password-hash"},${invitationHash},
              ${"test-encrypted-invitation"},${expiry}::timestamptz,15,25,${JSON.stringify(starter)}::jsonb
            )`;
        const [created] = await provision(tenantId, adminId);
        const [retried] = await provision(secondTenantId, secondAdminId);
        expect(created?.tenant_id).toBe(tenantId);
        expect(retried?.tenant_id).toBe(tenantId);
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        expect(await tx.user.count({ where: { tenantId } })).toBe(1);
        expect(await tx.department.count({ where: { tenantId } })).toBe(5);
        expect(await tx.category.count({ where: { tenantId } })).toBe(5);
        expect(await tx.invitationMail.count({ where: { tenantId } })).toBe(1);

        const apply = () =>
          tx.$queryRaw<{ applied: boolean }[]>`
            SELECT public.apply_billing_event(${eventId},${"checkout.session.completed"},${tenantId}::uuid,
              ${planId},${"cus_integration"},${"sub_integration"},${"activate"}) AS applied`;
        expect((await apply())[0]?.applied).toBe(true);
        expect((await apply())[0]?.applied).toBe(false);
        await tx.$executeRawUnsafe("RESET ROLE");
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
        expect(tenant.status).toBe("active");
        expect(tenant.planId).toBe(planId);
        expect(tenant.seatLimit).toBe(40);
        expect(tenant.stripeCustomerId).toBe("cus_integration");
        throw rollback;
      });
      throw new Error("fixture transaction should have rolled back");
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
