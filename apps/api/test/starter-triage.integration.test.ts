import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const rollback = new Error("rollback starter triage fixture");
type Starter = { departments: { name: string; isTriage: boolean }[] };

describe.skipIf(!enabled)("starter triage staffing for new organisations", () => {
  let owner: PrismaClient;
  let starter: Starter;
  const slugs: string[] = [];

  beforeAll(async () => {
    process.env.APP_ORIGIN = "http://localhost:4310";
    process.env.MFA_ENCRYPTION_KEY ??= "df".repeat(32);
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    starter = JSON.parse(
      await readFile(new URL("../prisma/starter-v1.json", import.meta.url), "utf8"),
    ) as Starter;
  });

  afterAll(async () => {
    for (const slug of slugs) {
      const tenant = await owner.tenant.findUnique({ where: { slug } });
      if (!tenant) continue;
      await owner.membership.deleteMany({ where: { tenantId: tenant.id } });
      await owner.invitationMail.deleteMany({ where: { tenantId: tenant.id } });
      await owner.configAudit.deleteMany({ where: { tenantId: tenant.id } });
      await owner.slaSettings.deleteMany({ where: { tenantId: tenant.id } });
      await owner.tenantLifecycleNotice.deleteMany({ where: { tenantId: tenant.id } });
      await owner.category.deleteMany({ where: { tenantId: tenant.id } });
      await owner.department.deleteMany({ where: { tenantId: tenant.id } });
      await owner.user.deleteMany({ where: { tenantId: tenant.id } });
      await owner.tenant.delete({ where: { id: tenant.id } });
    }
    await owner.$disconnect();
  });

  it("SQL provisioning staffs only the triage group and stays idempotent", async () => {
    const fixture = randomUUID(),
      slug = `starter-sql-${fixture.slice(0, 8)}`,
      tenantId = randomUUID(),
      adminId = randomUUID(),
      retryTenantId = randomUUID(),
      retryAdminId = randomUUID(),
      expiry = new Date(Date.now() + 48 * 3600000);

    try {
      await owner.$transaction(async (tx) => {
        const otherTenant = await tx.tenant.create({
          data: { slug: `starter-other-${fixture.slice(0, 8)}`, name: "Other", brandName: "Other" },
        });
        const otherAdmin = await tx.user.create({
          data: {
            tenantId: otherTenant.id,
            name: "Other admin",
            email: `other-${fixture}@example.invalid`,
            passwordHash: "not-a-login-hash",
            role: "admin",
            active: true,
          },
        });
        const otherTriage = await tx.department.create({
          data: {
            tenantId: otherTenant.id,
            name: "Other triage",
            isTriage: true,
            queueOwnerId: otherAdmin.id,
          },
        });
        await tx.membership.create({
          data: { tenantId: otherTenant.id, userId: otherAdmin.id, departmentId: otherTriage.id },
        });

        await tx.$executeRawUnsafe("SET LOCAL ROLE astrama_app");
        const [request] = await tx.$queryRaw<{ id: string }[]>`
          SELECT public.begin_public_signup(
            ${slug},${"Starter company"},${"Starter admin"},${`${fixture}@example.invalid`},${"Australia/Sydney"},
            ${null},${createHash("sha256").update(fixture).digest("hex")},${expiry}::timestamptz
          ) AS id`;
        await tx.signupRequest.update({
          where: { id: request!.id },
          data: { verifiedAt: new Date() },
        });
        const provision = (id: string, userId: string) =>
          tx.$queryRaw<{ tenant_id: string }[]>`
            SELECT * FROM public.provision_verified_signup(
              ${request!.id}::uuid,${id}::uuid,${userId}::uuid,${"test-password-hash"},
              ${createHash("sha256").update(`${fixture}${userId}`).digest("hex")},
              ${"test-encrypted-invitation"},${expiry}::timestamptz,15,25,${JSON.stringify(starter)}::jsonb
            )`;
        expect((await provision(tenantId, adminId))[0]?.tenant_id).toBe(tenantId);
        expect((await provision(retryTenantId, retryAdminId))[0]?.tenant_id).toBe(tenantId);

        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        const triageTemplate = starter.departments.find((department) => department.isTriage)!;
        const triage = await tx.department.findFirstOrThrow({
          where: { tenantId, isTriage: true },
        });
        expect(triage.name).toBe(triageTemplate.name);
        expect(triage.queueOwnerId).toBe(adminId);
        expect(await tx.user.count({ where: { tenantId } })).toBe(1);
        expect(await tx.user.count({ where: { tenantId, id: retryAdminId } })).toBe(0);
        expect(await tx.department.count({ where: { tenantId } })).toBe(5);
        const memberships = await tx.membership.findMany({ where: { tenantId } });
        expect(memberships).toHaveLength(1);
        expect(memberships[0]).toMatchObject({ userId: adminId, departmentId: triage.id });
        expect(
          await tx.membership.count({ where: { tenantId, departmentId: { not: triage.id } } }),
        ).toBe(0);
        const admin = await tx.user.findUniqueOrThrow({ where: { id: adminId } });
        expect(admin.active).toBe(false);
        const audit = await tx.configAudit.findFirstOrThrow({
          where: { tenantId, action: "organisation.provisioned" },
        });
        expect(audit.detail).toMatchObject({
          triageDepartmentId: triage.id,
          triageQueueOwnerId: adminId,
        });

        await tx.$executeRawUnsafe("RESET ROLE");
        expect(await tx.membership.count({ where: { tenantId: otherTenant.id } })).toBe(1);
        expect(
          (await tx.department.findUniqueOrThrow({ where: { id: otherTriage.id } })).queueOwnerId,
        ).toBe(otherAdmin.id);
        expect(await tx.user.count({ where: { tenantId: otherTenant.id } })).toBe(1);
        throw rollback;
      });
      throw new Error("fixture transaction should have rolled back");
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }, 30000);

  it("CLI provisioning staffs triage for a new organisation without touching another", async () => {
    const { provisionOrganisation } = await import("../dist/provision.js");
    const body = () => {
      const slug = `starter-cli-${randomUUID()}`;
      slugs.push(slug);
      return {
        slug,
        name: "Starter CLI",
        brandName: "Starter CLI",
        admin: { name: "First Administrator", email: `${randomUUID()}@example.invalid` },
      };
    };
    const first = body();
    await provisionOrganisation(first);
    const firstTenant = await owner.tenant.findUniqueOrThrow({
      where: { slug: first.slug },
      include: { users: true, departments: true },
    });
    const firstTriage = firstTenant.departments.find((department) => department.isTriage)!;
    expect(firstTriage.name).toBe(starter.departments.find((item) => item.isTriage)!.name);
    expect(firstTriage.queueOwnerId).toBe(firstTenant.users[0]!.id);
    expect(firstTenant.users[0]!.active).toBe(false);
    expect(await owner.membership.count({ where: { tenantId: firstTenant.id } })).toBe(1);
    const firstAudit = await owner.configAudit.findFirstOrThrow({
      where: { tenantId: firstTenant.id, action: "organisation.provisioned" },
    });
    expect(firstAudit.detail).toMatchObject({
      triageDepartmentId: firstTriage.id,
      triageQueueOwnerId: firstTenant.users[0]!.id,
    });
    const before = {
      memberships: await owner.membership.count({ where: { tenantId: firstTenant.id } }),
      queueOwnerId: firstTriage.queueOwnerId,
      audits: await owner.configAudit.count({ where: { tenantId: firstTenant.id } }),
    };

    const second = body();
    await provisionOrganisation(second);
    const secondTenant = await owner.tenant.findUniqueOrThrow({
      where: { slug: second.slug },
      include: { users: true, departments: true },
    });
    const secondTriage = secondTenant.departments.find((department) => department.isTriage)!;
    const secondMemberships = await owner.membership.findMany({
      where: { tenantId: secondTenant.id },
    });
    expect(secondMemberships).toHaveLength(1);
    expect(secondMemberships[0]).toMatchObject({
      userId: secondTenant.users[0]!.id,
      departmentId: secondTriage.id,
    });
    expect(secondTriage.queueOwnerId).toBe(secondTenant.users[0]!.id);
    expect(secondTenant.users[0]!.active).toBe(false);
    expect(
      await owner.membership.count({
        where: { tenantId: secondTenant.id, departmentId: { not: secondTriage.id } },
      }),
    ).toBe(0);

    expect(await owner.membership.count({ where: { tenantId: firstTenant.id } })).toBe(
      before.memberships,
    );
    expect(
      (await owner.department.findUniqueOrThrow({ where: { id: firstTriage.id } })).queueOwnerId,
    ).toBe(before.queueOwnerId);
    expect(await owner.configAudit.count({ where: { tenantId: firstTenant.id } })).toBe(
      before.audits,
    );
  }, 60000);
});
