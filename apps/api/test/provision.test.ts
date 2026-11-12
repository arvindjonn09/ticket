import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

describe.skipIf(!process.env.MIGRATION_DATABASE_URL)(
  "new organisation provisioning — real PostgreSQL",
  () => {
    let owner: PrismaClient;
    const slugs: string[] = [];
    const input = () => {
      const slug = `provision-${randomUUID()}`;
      slugs.push(slug);
      return {
        slug,
        name: "Provision test",
        brandName: "Provision desk",
        admin: { name: "First Administrator", email: "ADMIN@test.invalid" },
      };
    };
    beforeAll(() => {
      process.env.APP_ORIGIN = "http://localhost:4310";
      process.env.MFA_ENCRYPTION_KEY ??= "df".repeat(32);
      owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    });
    afterAll(async () => {
      for (const slug of slugs) {
        const tenant = await owner.tenant.findUnique({ where: { slug } });
        if (!tenant) continue;
        await owner.invitationMail.deleteMany({ where: { tenantId: tenant.id } });
        await owner.configAudit.deleteMany({ where: { tenantId: tenant.id } });
        await owner.department.deleteMany({ where: { tenantId: tenant.id } });
        await owner.user.deleteMany({ where: { tenantId: tenant.id } });
        await owner.tenant.delete({ where: { id: tenant.id } });
      }
      await owner.$disconnect();
    });
    it("atomically creates one inactive administrator and encrypted invitation and refuses any existing organisation reset", async () => {
      const { provisionOrganisation } = await import("../dist/provision.js");
      const { decryptSecret } = await import("../dist/mfa.js");
      const body = input(),
        result = await provisionOrganisation(body);
      const tenant = await owner.tenant.findUniqueOrThrow({
        where: { slug: body.slug },
        include: { users: true, departments: true },
      });
      expect(tenant.users).toHaveLength(1);
      expect(tenant.departments).toHaveLength(1);
      expect(tenant.departments[0]!.isTriage).toBe(true);
      const user = tenant.users[0]!;
      expect(user.email).toBe("admin@test.invalid");
      expect(user.active).toBe(false);
      expect(user.role).toBe("admin");
      expect(user.mfaEnrolled).toBe(false);
      expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
      const mail = await owner.invitationMail.findFirstOrThrow({
        where: { tenantId: tenant.id, userId: user.id },
      });
      expect(mail.status).toBe("pending");
      expect(mail.invitationHash === user.invitationHash).toBe(true);
      expect(
        decryptSecret(mail.encryptedUrl!, `invitation:${tenant.id}:${user.id}`) ===
          result.invitation.url,
      ).toBe(true);
      expect(
        JSON.stringify(
          await owner.configAudit.findMany({ where: { tenantId: tenant.id } }),
        ).includes("token="),
      ).toBe(false);
      await expect(
        provisionOrganisation({
          ...body,
          name: "Do not replace",
          admin: { name: "Do not replace", email: "other@test.invalid" },
        }),
      ).rejects.toThrow();
      const unchanged = await owner.tenant.findUniqueOrThrow({
        where: { slug: body.slug },
        include: { users: true },
      });
      expect(unchanged.name).toBe(body.name);
      expect(unchanged.users).toHaveLength(1);
      expect(unchanged.users[0]!.passwordHash === user.passwordHash).toBe(true);
      expect(unchanged.users[0]!.invitationHash === user.invitationHash).toBe(true);
      expect(await owner.invitationMail.count({ where: { tenantId: tenant.id } })).toBe(1);
      expect(await owner.configAudit.count({ where: { tenantId: tenant.id } })).toBe(1);
    }, 30000);
    it("rejects invalid input before creating records and requires the explicit owner connection", async () => {
      const { provisionOrganisation } = await import("../dist/provision.js");
      const body = input();
      await expect(provisionOrganisation({ ...body, slug: "INVALID SLUG" })).rejects.toThrow();
      expect(await owner.tenant.count({ where: { slug: body.slug } })).toBe(0);
      const ownerUrl = process.env.MIGRATION_DATABASE_URL;
      try {
        delete process.env.MIGRATION_DATABASE_URL;
        await expect(provisionOrganisation(body)).rejects.toThrow("MIGRATION_DATABASE_URL");
      } finally {
        process.env.MIGRATION_DATABASE_URL = ownerUrl;
      }
      expect(await owner.tenant.count({ where: { slug: body.slug } })).toBe(0);
    });
    it("keeps invitation tokens out of default CLI output and reveals them only with an explicit flag", () => {
      const directory = mkdtempSync(join(tmpdir(), "astrama-provision-")),
        path = join(directory, "organisation.json");
      const cli = fileURLToPath(new URL("../dist/provision.js", import.meta.url));
      try {
        writeFileSync(path, JSON.stringify(input()), "utf8");
        const normal = execFileSync(process.execPath, [cli, path], { encoding: "utf8" });
        const result = JSON.parse(normal) as Record<string, unknown>;
        expect(result.emailQueued).toBe(true);
        expect("invitation" in result).toBe(false);
        expect(normal.includes("token=")).toBe(false);
        writeFileSync(path, JSON.stringify(input()), "utf8");
        const shown = JSON.parse(
          execFileSync(process.execPath, [cli, path, "--show-invitation"], { encoding: "utf8" }),
        ) as { invitation: { url: string } };
        expect(new URL(shown.invitation.url).hash.startsWith("#activate?token=")).toBe(true);
      } finally {
        unlinkSync(path);
        rmdirSync(directory);
      }
    }, 30000);
  },
);
