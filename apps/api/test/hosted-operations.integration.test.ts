import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { Database } from "../src/database.js";
import { reserveTenantBudget } from "../src/tenant-budgets.js";
import { deleteTenant, exportTenant, operatorStorage } from "../src/operator-data.js";
import { restoreTenant } from "../src/tenant-restore.js";

describe.skipIf(!process.env.MIGRATION_DATABASE_URL || !process.env.S3_ENDPOINT)(
  "hosted isolation, budgets and tenant restore — real PostgreSQL/S3",
  () => {
    const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL }),
      runtime = new Database(),
      storage = operatorStorage();
    const ids = [randomUUID(), randomUUID()],
      slug = `restore-${ids[0]}`;
    let directory: string, userId: string, ticketId: string, key: string, attachmentId: string;
    const request = {
      tenantId: ids[0]!,
      expectedSlug: slug,
      operator: "integration fixture",
      reason: "Authorised disposable restore drill",
      evidence: "local fixture",
      offline: true,
    };
    const restoreRequest = { ...request, deleteAfter: new Date(Date.now() + 86400000) };
    beforeAll(async () => {
      directory = join(await mkdtemp(join(tmpdir(), "astrama-restore-")), "export");
      for (const [index, id] of ids.entries())
        await owner.tenant.create({
          data: {
            id,
            slug: index ? `foreign-${id}` : slug,
            name: "Restore fixture",
            brandName: "Fixture",
          },
        });
      const user = await owner.user.create({
        data: {
          tenantId: ids[0]!,
          name: "Admin",
          email: "restore@test.invalid",
          role: "admin",
          passwordHash: "old-secret",
          mfaEnrolled: true,
          mfaSecret: "old-mfa",
        },
      });
      userId = user.id;
      const department = await owner.department.create({
        data: { tenantId: ids[0]!, name: "Triage", isTriage: true, queueOwnerId: userId },
      });
      await owner.membership.create({
        data: { tenantId: ids[0]!, userId, departmentId: department.id },
      });
      const category = await owner.category.create({
        data: { tenantId: ids[0]!, name: "General", departmentId: department.id },
      });
      const ticket = await owner.ticket.create({
        data: {
          tenantId: ids[0]!,
          type: "incident",
          sequence: 1,
          number: "INC0001",
          summary: "Restored incident",
          description: "Private fixture",
          priority: "P3",
          severity: "S3",
          categoryId: category.id,
          departmentId: department.id,
          callerId: userId,
          submittedById: userId,
        },
      });
      ticketId = ticket.id;
      await owner.counter.create({ data: { tenantId: ids[0]!, type: "incident", sequence: 1 } });
      const attachment = await owner.attachment.create({
        data: {
          tenantId: ids[0]!,
          ticketId,
          authorId: userId,
          filename: "fixture.txt",
          size: 7,
          audience: "internal",
          contentType: "application/octet-stream",
          status: "clean",
          storageKey: `${ids[0]}/${ticketId}/${randomUUID()}`,
        },
      });
      key = attachment.storageKey;
      attachmentId = attachment.id;
      await storage.send(
        new PutObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key, Body: "fixture" }),
      );
      await exportTenant(owner, request, directory, storage);
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      if (await owner.tenant.findUnique({ where: { id: ids[0] } }))
        await deleteTenant(owner, { ...request, execute: true }, storage);
      await owner.$executeRaw`DELETE FROM tenant_budgets WHERE tenant_id=${ids[1]}::uuid`;
      await owner.tenant.deleteMany({ where: { id: ids[1] } });
      for (const id of ids)
        await owner.$executeRaw`DELETE FROM data_operation_audits WHERE tenant_id=${id}::uuid`;
      if (key)
        await storage.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
      await owner.$disconnect();
      await runtime.$disconnect();
      storage.destroy();
      await rm(join(directory, ".."), { recursive: true, force: true });
    });
    it("atomically enforces every allowance and keeps another tenant independent", async () => {
      vi.stubEnv("PLATFORM_MODE", "hosted");
      for (const [kind, variable] of [
        ["requests", "TENANT_REQUESTS_PER_MINUTE"],
        ["uploads", "TENANT_UPLOAD_BYTES_PER_DAY"],
        ["inbound", "TENANT_INBOUND_PER_HOUR"],
        ["outbound", "TENANT_OUTBOUND_PER_HOUR"],
        ["exports", "TENANT_EXPORTS_PER_DAY"],
      ] as const) {
        vi.stubEnv(variable, "2");
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, () =>
            runtime.withTenant(ids[0]!, (tx) => reserveTenantBudget(tx, ids[0]!, kind)),
          ),
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
        await runtime.withTenant(ids[1]!, (tx) => reserveTenantBudget(tx, ids[1]!, kind));
      }
      const hidden = await runtime.withTenant(
        ids[1]!,
        (tx) => tx.$queryRaw`SELECT * FROM tenant_budgets WHERE tenant_id=${ids[0]}::uuid`,
      );
      expect(hidden).toEqual([]);
      const later = new Date(Date.now() + 2 * 86400000);
      await runtime.withTenant(ids[0]!, (tx) =>
        reserveTenantBudget(tx, ids[0]!, "exports", 2, later),
      );
      vi.unstubAllEnvs();
    });
    it("rejects an existing target and corrupt or foreign records; previews and restores without changing another tenant", async () => {
      await expect(restoreTenant(owner, restoreRequest, directory, storage)).rejects.toThrow(
        "already exists",
      );
      await deleteTenant(owner, { ...request, execute: true }, storage);
      const recordsPath = join(directory, "records.json"),
        manifestPath = join(directory, "manifest.json");
      const records = await readFile(recordsPath),
        manifest = await readFile(manifestPath);
      await writeFile(recordsPath, Buffer.concat([records, Buffer.from(" ")]));
      await expect(restoreTenant(owner, restoreRequest, directory, storage)).rejects.toThrow(
        "checksum",
      );
      const foreign = JSON.parse(records.toString());
      foreign.users[0].tenantId = ids[1];
      const foreignBytes = Buffer.from(JSON.stringify(foreign)),
        changed = JSON.parse(manifest.toString());
      const file = changed.files.find((f: { path: string }) => f.path === "records.json");
      file.bytes = foreignBytes.length;
      file.sha256 = createHash("sha256").update(foreignBytes).digest("hex");
      await writeFile(recordsPath, foreignBytes);
      await writeFile(manifestPath, JSON.stringify(changed));
      await expect(restoreTenant(owner, restoreRequest, directory, storage)).rejects.toThrow(
        "Foreign tenant",
      );
      await writeFile(recordsPath, records);
      await writeFile(manifestPath, manifest);
      expect(await restoreTenant(owner, restoreRequest, directory, storage)).toMatchObject({
        execute: false,
        tickets: 1,
      });
      expect(await owner.tenant.findUnique({ where: { id: ids[0] } })).toBeNull();
      const send = vi.spyOn(storage, "send");
      send
        .mockImplementationOnce(async () => ({ Contents: [] }))
        .mockRejectedValueOnce(new Error("Storage write failure"));
      await expect(
        restoreTenant(owner, { ...restoreRequest, execute: true }, directory, storage),
      ).rejects.toThrow("Storage write failure");
      send.mockRestore();
      expect(await owner.tenant.findUnique({ where: { id: ids[0] } })).toBeNull();
      expect(
        await restoreTenant(owner, { ...restoreRequest, execute: true }, directory, storage),
      ).toMatchObject({ execute: true, quarantined: true });
      expect(await owner.tenant.findUniqueOrThrow({ where: { id: ids[0] } })).toMatchObject({
        active: false,
        status: "read_only",
        readOnlyReason: "operator",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        deleteAfter: restoreRequest.deleteAfter,
      });
      expect(await owner.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({
        active: false,
        passwordHash: "!",
        mfaSecret: null,
        mfaEnrolled: false,
        invitationHash: null,
      });
      expect(await owner.ticket.findUniqueOrThrow({ where: { id: ticketId } })).toMatchObject({
        summary: "Restored incident",
      });
      expect(
        await owner.attachment.findUniqueOrThrow({ where: { id: attachmentId } }),
      ).toMatchObject({ storageKey: key, audience: "internal" });
      const object = await storage.send(
        new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }),
      );
      expect(await object.Body!.transformToString()).toBe("fixture");
      expect(await owner.tenant.findUniqueOrThrow({ where: { id: ids[1] } })).toMatchObject({
        active: true,
        name: "Restore fixture",
      });
      expect(await owner.session.count({ where: { tenantId: ids[0] } })).toBe(0);
    });
  },
);
