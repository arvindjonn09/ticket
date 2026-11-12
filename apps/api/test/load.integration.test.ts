import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

describe.skipIf(!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)(
  "100-account company HTTP smoke — not a capacity or SLA benchmark",
  () => {
    const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    const origin = "http://localhost:4310",
      concurrency = 20;
    let app: NestFastifyApplication, tenantId: string, categoryId: string;
    const identities: { id: string; cookie: string; csrf: string }[] = [],
      ticketIds: string[] = [],
      numbers: string[] = [];
    beforeAll(async () => {
      process.env.NODE_ENV = "test";
      process.env.APP_ORIGIN = origin;
      process.env.MFA_ENCRYPTION_KEY ??= "ab".repeat(32);
      const tenant = await owner.tenant.create({
        data: {
          slug: `load-${randomUUID()}`,
          name: "Isolated account smoke",
          brandName: "Astrama",
        },
      });
      tenantId = tenant.id;
      const agent = await owner.user.create({
        data: {
          tenantId,
          name: "Smoke agent",
          email: "agent@load.invalid",
          role: "agent",
          passwordHash: "disabled",
        },
      });
      const group = await owner.department.create({
        data: { tenantId, name: "Smoke triage", isTriage: true, queueOwnerId: agent.id },
      });
      await owner.membership.create({
        data: { tenantId, userId: agent.id, departmentId: group.id },
      });
      categoryId = (
        await owner.category.create({
          data: { tenantId, name: "Smoke category", departmentId: group.id },
        })
      ).id;
      const users = [],
        sessions = [];
      for (let index = 0; index < 100; index++) {
        const id = randomUUID(),
          token = randomBytes(32).toString("base64url"),
          csrf = randomBytes(32).toString("base64url");
        users.push({
          id,
          tenantId,
          name: `Smoke employee ${index}`,
          email: `employee-${index}@load.invalid`,
          role: "employee",
          passwordHash: "disabled",
        });
        sessions.push({
          tenantId,
          userId: id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          csrfToken: csrf,
          expiresAt: new Date(Date.now() + 3600000),
        });
        identities.push({ id, cookie: `astrama_session=${token}`, csrf });
      }
      await owner.user.createMany({ data: users });
      await owner.session.createMany({ data: sessions });
      const { createApp } = await import("../dist/main.js");
      app = await createApp();
      await app.getHttpAdapter().getInstance().ready();
    }, 30000);
    afterAll(async () => {
      await app?.close();
      if (tenantId) {
        // Serialize exact-fixture cleanup with business workers; never touch another tenant.
        await owner.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`configuration:${tenantId}`},0))`;
            await tx.tenant.update({ where: { id: tenantId }, data: { active: false } });
            await tx.department.updateMany({
              where: { tenantId },
              data: { queueOwnerId: null, substituteId: null },
            });
            for (const table of [
              "notification_deliveries",
              "invitation_mails",
              "attachments",
              "approval_delegations",
              "approvals",
              "idempotency",
              "outbox",
              "audits",
              "config_audits",
              "activities",
              "tickets",
              "catalog_items",
              "sessions",
              "memberships",
              "subcategories",
              "categories",
              "counters",
              "departments",
              "users",
              "tenants",
            ])
              await tx.$executeRawUnsafe(
                `DELETE FROM "${table}" WHERE "${table === "tenants" ? "id" : "tenant_id"}"=$1::uuid`,
                tenantId,
              );
          },
          { timeout: 30000 },
        );
      }
      await owner.$disconnect();
    }, 30000);
    it("submits and lists tickets for 100 authenticated employees with bounded concurrency and isolated public reads", async () => {
      const started = performance.now(),
        submitMs: number[] = [],
        listMs: number[] = [];
      for (let offset = 0; offset < identities.length; offset += concurrency)
        await Promise.all(
          identities.slice(offset, offset + concurrency).map(async (identity, index) => {
            const start = performance.now();
            const response = await app.inject({
              method: "POST",
              url: "/api/tickets",
              headers: {
                origin,
                cookie: identity.cookie,
                "x-csrf-token": identity.csrf,
                "idempotency-key": randomUUID(),
              },
              payload: {
                categoryId,
                summary: `Account smoke incident ${offset + index}`,
                description:
                  "An isolated synthetic incident for the 100-account company smoke check",
              },
            });
            submitMs.push(performance.now() - start);
            expect(response.statusCode).toBe(201);
            const ticket = response.json<{ id: string; number: string; callerId: string }>();
            expect(ticket.callerId).toBe(identity.id);
            ticketIds[offset + index] = ticket.id;
            numbers.push(ticket.number);
          }),
        );
      expect(new Set(ticketIds).size).toBe(100);
      expect(new Set(numbers).size).toBe(100);
      for (let offset = 0; offset < identities.length; offset += concurrency)
        await Promise.all(
          identities.slice(offset, offset + concurrency).map(async (identity, index) => {
            const start = performance.now(),
              response = await app.inject({
                method: "GET",
                url: "/api/tickets",
                headers: { cookie: identity.cookie },
              });
            listMs.push(performance.now() - start);
            expect(response.statusCode).toBe(200);
            const list = response.json<{
              tickets: { id: string; callerId: string }[];
              limitReached: boolean;
            }>();
            expect(list.tickets).toEqual([
              expect.objectContaining({ id: ticketIds[offset + index], callerId: identity.id }),
            ]);
            expect(list.limitReached).toBe(false);
          }),
        );
      const forbidden = await app.inject({
        method: "GET",
        url: `/api/tickets/${ticketIds[1]}`,
        headers: { cookie: identities[0]!.cookie },
      });
      expect(forbidden.statusCode).toBe(404);
      const stats = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          count: values.length,
          p50Ms: Math.round(sorted[Math.ceil(sorted.length * 0.5) - 1]!),
          p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
        };
      };
      console.info(
        JSON.stringify({
          smoke: "100-account company",
          accounts: 100,
          concurrency,
          uniqueTickets: new Set(ticketIds).size,
          crossEmployeeDenials: 1,
          submit: stats(submitMs),
          list: stats(listMs),
          totalMs: Math.round(performance.now() - started),
        }),
      );
    }, 120000);
  },
);
