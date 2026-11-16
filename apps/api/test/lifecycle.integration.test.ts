import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/database.js";
import type { TenantLifecycleService } from "../src/modules/lifecycle/lifecycle.service.js";

describe.skipIf(!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)(
  "tenant lifecycle on PostgreSQL",
  () => {
    let owner: PrismaClient;
    let db: Database;
    let lifecycle: TenantLifecycleService;
    const id = randomUUID();
    const slug = `lifecycle-${randomUUID()}`;

    beforeAll(async () => {
      owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
      const { Database } = await import("../dist/database.js");
      const { TenantLifecycleService } =
        await import("../dist/modules/lifecycle/lifecycle.service.js");
      db = new Database();
      const now = new Date("2026-11-17T00:00:00.000Z");
      await owner.tenant.create({
        data: {
          id,
          slug,
          name: "Lifecycle test",
          brandName: "Lifecycle test",
          status: "trial",
          trialEndsAt: new Date(now.getTime() - 1000),
        },
      });
      lifecycle = new TenantLifecycleService(db);
    });

    afterAll(async () => {
      await lifecycle?.onModuleDestroy();
      await db?.$disconnect();
      if (!owner) return;
      await owner.tenantLifecycleNotice.deleteMany({ where: { tenantId: id } });
      await owner.tenant.deleteMany({ where: { id } });
      await owner.$disconnect();
    });

    it("moves expired trials to read-only for 45 days and appends a status audit", async () => {
      const now = new Date("2026-11-17T00:00:00.000Z");
      await lifecycle.run(now);
      const tenant = await owner.tenant.findUniqueOrThrow({ where: { id } });
      expect(tenant.status).toBe("read_only");
      expect(tenant.readOnlyReason).toBe("trial_ended");
      expect(tenant.readOnlySince?.toISOString()).toBe("2026-11-16T23:59:59.000Z");
      expect(tenant.deleteAfter?.toISOString()).toBe("2026-12-31T23:59:59.000Z");
      const audits = await owner.$queryRaw<{ old_status: string; new_status: string }[]>`
        SELECT old_status,new_status FROM tenant_status_audits WHERE tenant_id=${id}::uuid
      `;
      expect(audits).toEqual([
        { old_status: "none", new_status: "trial" },
        { old_status: "trial", new_status: "read_only" },
      ]);
    });
  },
);
