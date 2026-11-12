import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

const configured =
  process.env.DATABASE_URL &&
  process.env.MIGRATION_DATABASE_URL &&
  process.env.S3_ENDPOINT &&
  process.env.CLAMAV_HOST;
describe.skipIf(!configured)(
  "operational health — real infrastructure and HTTP permissions",
  () => {
    let owner: PrismaClient, app: NestFastifyApplication, tenantId: string, adminId: string;
    const cookies: Record<string, string> = {};
    const get = (cookie?: string) =>
      app.inject({
        method: "GET",
        url: "/api/admin/operations",
        headers: cookie ? { cookie } : {},
      });
    beforeAll(async () => {
      process.env.NODE_ENV = "test";
      process.env.APP_ORIGIN = "http://localhost:4310";
      owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
      const { tokenHash } = await import("../dist/auth.js"),
        { encryptSecret, encryptionKey } = await import("../dist/mfa.js");
      tenantId = (
        await owner.tenant.create({
          data: {
            slug: `operations-${randomUUID()}`,
            name: "Health fixture",
            brandName: "Fixture",
          },
        })
      ).id;
      for (const role of ["employee", "agent", "admin"]) {
        const id = randomUUID();
        await owner.user.create({
          data: {
            id,
            tenantId,
            name: role,
            email: `${role}@test.invalid`,
            role,
            passwordHash: "!",
            mfaEnrolled: role === "admin",
            mfaSecret:
              role === "admin"
                ? encryptSecret(
                    "JBSWY3DPEHPK3PXP",
                    `${tenantId}:${id}`,
                    encryptionKey("ac".repeat(32)),
                  )
                : null,
          },
        });
        if (role === "admin") adminId = id;
        const token = randomBytes(32).toString("base64url");
        cookies[role] = `astrama_session=${token}`;
        await owner.session.create({
          data: {
            tenantId,
            userId: id,
            tokenHash: tokenHash(token),
            csrfToken: randomUUID(),
            mfaVerified: role === "admin",
            expiresAt: new Date(Date.now() + 60000),
          },
        });
      }
      for (const [name, verified, expired] of [
        ["unverified", false, false],
        ["expired", true, true],
      ] as const) {
        const token = randomBytes(32).toString("base64url");
        cookies[name] = `astrama_session=${token}`;
        await owner.session.create({
          data: {
            tenantId,
            userId: adminId,
            tokenHash: tokenHash(token),
            csrfToken: randomUUID(),
            mfaVerified: verified,
            expiresAt: new Date(Date.now() + (expired ? -60000 : 60000)),
          },
        });
      }
      const { createApp } = await import("../dist/main.js");
      app = await createApp();
      await app.getHttpAdapter().getInstance().ready();
    }, 30000);
    afterAll(async () => {
      await app?.close();
      if (owner) {
        if (tenantId) {
          await owner.session.deleteMany({ where: { tenantId } });
          await owner.user.deleteMany({ where: { tenantId } });
          await owner.tenant.delete({ where: { id: tenantId } });
        }
        await owner.$disconnect();
      }
    });
    it("denies anonymous, employee, agent, unverified and expired administrator sessions", async () => {
      expect((await get()).statusCode).toBe(401);
      for (const role of ["employee", "agent", "unverified"])
        expect((await get(cookies[role])).statusCode).toBe(403);
      expect((await get(cookies.expired)).statusCode).toBe(401);
    });
    it("returns component booleans only to a current MFA administrator and probes actual database/storage/scanner", async () => {
      const response = await get(cookies.admin);
      expect(response.statusCode).toBe(200);
      const result = response.json() as {
        healthy: boolean;
        checks: Record<string, boolean>;
        checkedAt: string;
      };
      expect(Object.keys(result).sort()).toEqual(["checkedAt", "checks", "healthy"]);
      expect(Object.keys(result.checks).sort()).toEqual([
        "backup",
        "database",
        "queue",
        "scanner",
        "storage",
        "worker",
      ]);
      expect(Object.values(result.checks).every((value) => typeof value === "boolean")).toBe(true);
      expect(result.checks.database).toBe(true);
      expect(result.checks.storage).toBe(true);
      expect(result.checks.scanner).toBe(true);
      expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
      expect(result.healthy).toBe(Object.values(result.checks).every(Boolean));
      await owner.user.update({ where: { id: adminId }, data: { role: "employee" } });
      expect((await get(cookies.admin)).statusCode).toBe(403);
      await owner.user.update({ where: { id: adminId }, data: { active: false } });
      expect((await get(cookies.admin)).statusCode).toBe(401);
    }, 15000);
  },
);
