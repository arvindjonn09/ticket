import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Opt-in only: never bootstrap a shared/live cluster from the ordinary test command.
describe.skipIf(!process.env.BOOTSTRAP_TEST_DATABASE_URL)(
  "fresh isolated PostgreSQL bootstrap without demo seed",
  () => {
    let owner: PrismaClient;
    const saved = {
      owner: process.env.MIGRATION_DATABASE_URL,
      runtime: process.env.DATABASE_URL,
      password: process.env.APP_DB_PASSWORD,
    };
    beforeAll(async () => {
      const url = new URL(process.env.BOOTSTRAP_TEST_DATABASE_URL!);
      if (
        !["localhost", "127.0.0.1"].includes(url.hostname) ||
        !/^\/astrama_bootstrap_[a-f0-9]{12}$/.test(url.pathname)
      )
        throw new Error("Use a uniquely named disposable local PostgreSQL cluster/database");
      owner = new PrismaClient({ datasourceUrl: url.toString() });
      const [row] = await owner.$queryRaw<
        { exists: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='astrama_app')`;
      if (row?.exists)
        throw new Error(
          "Refusing role changes: the opt-in test requires a fresh cluster with no runtime role",
        );
      process.env.MIGRATION_DATABASE_URL = url.toString();
      process.env.APP_DB_PASSWORD = `bootstrap-${randomUUID()}-'\\end`;
      url.username = "astrama_app";
      url.password = process.env.APP_DB_PASSWORD;
      process.env.DATABASE_URL = url.toString();
      process.env.APP_ORIGIN = "http://localhost:4310";
      process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    }, 30000);
    afterAll(async () => {
      await owner?.$disconnect();
      for (const [key, value] of Object.entries({
        MIGRATION_DATABASE_URL: saved.owner,
        DATABASE_URL: saved.runtime,
        APP_DB_PASSWORD: saved.password,
      }))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    it("bootstraps twice, migrates, provisions and performs runtime business writes/RLS and auth/worker lookups without seeding", async () => {
      const { bootstrapDatabase } = await import("../dist/database-bootstrap.js");
      await bootstrapDatabase();
      await bootstrapDatabase();
      const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
      execFileSync(
        process.execPath,
        [
          prismaCli,
          "migrate",
          "deploy",
          "--schema",
          fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
        ],
        { stdio: "pipe", env: process.env },
      );
      expect(await owner.tenant.count()).toBe(0);
      const { provisionOrganisation } = await import("../dist/provision.js");
      const provision = await provisionOrganisation({
        slug: "fresh-company",
        name: "Fresh company",
        brandName: "Fresh desk",
        admin: { name: "Administrator", email: "admin@test.invalid" },
      });
      const { Database } = await import("../dist/database.js");
      const { TicketsService } = await import("../dist/tickets.js");
      const { UsersService } = await import("../dist/users.js");
      const runtime = new Database();
      try {
        await runtime.assertRuntimeRole();
        expect(await runtime.user.findMany()).toEqual([]);
        await expect(
          runtime.user.create({
            data: {
              tenantId: randomUUID(),
              name: "Denied",
              email: "denied@test.invalid",
              passwordHash: "!",
              role: "employee",
            },
          }),
        ).rejects.toThrow();
        const parameters = new URLSearchParams(
          new URL(provision.invitation.url).hash.slice("#activate?".length),
        );
        await new UsersService(runtime, new TicketsService(runtime)).activate({
          organisation: provision.slug,
          token: parameters.get("token"),
          password: "Fresh-setup-password-2026!",
        });
        const [identity] = await runtime.$queryRaw<
          { id: string; tenant_id: string }[]
        >`SELECT * FROM auth_login_lookup(${provision.slug}, ${provision.adminEmail})`;
        expect(!!identity).toBe(true);
        await runtime.withTenant(identity!.tenant_id, async (tx) => {
          const tenantId = identity!.tenant_id,
            userId = identity!.id;
          const group = await tx.department.findFirstOrThrow({
            where: { tenantId, isTriage: true },
          });
          const agent = await tx.user.create({
            data: {
              tenantId,
              name: "Fixture agent",
              email: "agent@test.invalid",
              role: "agent",
              passwordHash: "!",
            },
          });
          await tx.membership.create({
            data: { tenantId, userId: agent.id, departmentId: group.id },
          });
          await tx.department.update({ where: { id: group.id }, data: { queueOwnerId: agent.id } });
          const category = await tx.category.create({
            data: { tenantId, departmentId: group.id, name: "Fresh category" },
          });
          await tx.counter.create({ data: { tenantId, type: "incident", sequence: 1 } });
          const ticket = await tx.ticket.create({
            data: {
              tenantId,
              categoryId: category.id,
              departmentId: group.id,
              callerId: userId,
              submittedById: userId,
              sequence: 1,
              number: "INC0001",
              summary: "Fresh permissions check",
              description: "Fixture only",
              priority: "P3",
              severity: "S3",
            },
          });
          await tx.activity.create({
            data: {
              tenantId,
              ticketId: ticket.id,
              authorId: userId,
              audience: "customer",
              body: "Fixture activity",
            },
          });
          const audit = await tx.audit.create({
            data: {
              tenantId,
              ticketId: ticket.id,
              actorId: userId,
              action: "incident.created",
              detail: {},
            },
          });
          await tx.outbox.create({
            data: {
              tenantId,
              ticketId: ticket.id,
              event: "incident.created",
              payload: { auditId: audit.id },
            },
          });
          await tx.idempotency.create({
            data: {
              tenantId,
              actorId: userId,
              operation: "fixture",
              key: "fixture",
              fingerprint: "fixture",
              ticketId: ticket.id,
            },
          });
          const session = await tx.session.create({
            data: {
              tenantId,
              userId,
              tokenHash: randomUUID(),
              csrfToken: randomUUID(),
              expiresAt: new Date(Date.now() + 60000),
            },
          });
          await tx.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
          await tx.session.delete({ where: { id: session.id } });
        });
        expect(
          (await runtime.$queryRaw<unknown[]>`SELECT * FROM pending_outbox_events()`).length,
        ).toBe(1);
        const [privileges] = await runtime.$queryRaw<
          { denied: boolean }[]
        >`SELECT NOT has_table_privilege(current_user,'public.config_audits','DELETE') AND NOT has_table_privilege(current_user,'public.users','DELETE') AND NOT has_column_privilege(current_user,'public.users','tenant_id','UPDATE') AS denied`;
        expect(privileges?.denied).toBe(true);
      } finally {
        await runtime.$disconnect();
      }
    }, 90000);
  },
);
