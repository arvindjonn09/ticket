import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Transporter } from "nodemailer";
import { createHash, randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Database } from "../src/database.js";
import { createPlatformTransport, sendTenantMail } from "../src/platform-mail.js";

describe.skipIf(
  !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL || !process.env.SMTP_HOST,
)("platform sender and tenant email health — real PostgreSQL/SMTP", () => {
  let owner: PrismaClient, runtime: Database, app: NestFastifyApplication;
  const tenants: string[] = [],
    cookies: string[] = [];
  const recipient = `sender-${randomUUID()}@mail.test`;
  const mail = createPlatformTransport();
  beforeAll(async () => {
    vi.stubEnv("PLATFORM_MODE", "single");
    vi.stubEnv("PLATFORM_MAIL_DOMAIN", "mail.astrama.test");
    vi.stubEnv("INBOUND_MAIL_DOMAIN", "in.astrama.test");
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    runtime = new Database();
    for (let index = 0; index < 2; index++) {
      const tenant = await owner.tenant.create({
        data: { slug: `mail-${randomUUID()}`, name: "Mail fixture", brandName: `Brand ${index}` },
      });
      tenants.push(tenant.id);
    }
    for (const [tenantId, role] of [
      [tenants[0]!, "admin"],
      [tenants[1]!, "admin"],
      [tenants[0]!, "employee"],
    ] as const) {
      const user = await owner.user.create({
        data: {
          tenantId,
          role,
          name: role,
          email: `${randomUUID()}@test.invalid`,
          passwordHash: "!",
          mfaEnrolled: true,
          mfaSecret: "fixture-not-used-for-login",
        },
      });
      const token = randomUUID();
      await owner.session.create({
        data: {
          tenantId,
          userId: user.id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          csrfToken: randomUUID(),
          mfaVerified: true,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      cookies.push(`astrama_session=${token}`);
    }
    const { createApp } = await import("../dist/main.js");
    app = await createApp();
    await app.getHttpAdapter().getInstance().ready();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    mail.close();
    await runtime?.$disconnect();
    if (owner) {
      await owner.session.deleteMany({ where: { tenantId: { in: tenants } } });
      await owner.user.deleteMany({ where: { tenantId: { in: tenants } } });
      for (const tenantId of tenants)
        await owner.$executeRaw`DELETE FROM tenant_budgets WHERE tenant_id=${tenantId}::uuid`;
      await owner.tenant.deleteMany({ where: { id: { in: tenants } } });
      await owner.$disconnect();
    }
    vi.unstubAllEnvs();
  });
  const health = (index: number) =>
    app.inject({
      method: "GET",
      url: `/api/admin/operations/email?tenantId=${tenants[0]}`,
      headers: { cookie: cookies[index]! },
    });
  it("sends the tenant's brand through the platform domain and records sanitised delivery evidence", async () => {
    await runtime.withTenant(tenants[0]!, (tx) =>
      sendTenantMail(mail, tx, tenants[0]!, {
        to: recipient,
        subject: "Platform sender fixture",
        text: "Fixture",
        messageId: "<stable-fixture@ignored.test>",
        replyTo: "tenant+t.fixture@in.astrama.test",
      }),
    );
    const failing = {
      sendMail: async () => {
        throw new Error("Sensitive SMTP reply must not be stored");
      },
    } as unknown as Transporter;
    await runtime.withTenant(tenants[0]!, async (tx) => {
      try {
        await sendTenantMail(failing, tx, tenants[0]!, { to: recipient, text: "Failure fixture" });
      } catch {
        /* Commit the durable failed-attempt evidence, as outbox callers do. */
      }
    });
    const rows = await runtime.withTenant(
      tenants[0]!,
      (tx) =>
        tx.$queryRaw<
          { status: string; last_error: string | null }[]
        >`SELECT status,last_error FROM tenant_mail_deliveries ORDER BY created_at`,
    );
    expect(rows).toEqual([
      { status: "sent", last_error: null },
      { status: "failed", last_error: "SMTP delivery failed" },
    ]);
    expect((await health(0)).json()).toMatchObject({ sent: 1, failed: 1, queued: 0 });
    if (process.env.MAILPIT_URL) {
      const results = (await fetch(
        `${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
      ).then((r) => r.json())) as { messages: { ID: string }[] };
      const message = (await fetch(
        `${process.env.MAILPIT_URL}/api/v1/message/${results.messages[0]!.ID}`,
      ).then((r) => r.json())) as { From: { Name: string; Address: string }; MessageID: string };
      expect(message.From).toMatchObject({
        Name: "Brand 0 Support",
        Address: "notifications@mail.astrama.test",
      });
      expect(message.MessageID).toContain("stable-fixture@mail.astrama.test");
    }
  });
  it("requires an MFA administrator and never exposes another tenant's sending history", async () => {
    expect((await health(2)).statusCode).toBe(403);
    expect((await health(1)).json()).toMatchObject({ sent: 0, failed: 0, queued: 0 });
    expect(
      await runtime.withTenant(
        tenants[1]!,
        (tx) =>
          tx.$queryRaw`SELECT * FROM tenant_mail_deliveries WHERE tenant_id=${tenants[0]}::uuid`,
      ),
    ).toEqual([]);
    await expect(
      runtime.withTenant(
        tenants[1]!,
        (tx) =>
          tx.$executeRaw`INSERT INTO tenant_mail_deliveries(tenant_id,kind,status) VALUES(${tenants[0]}::uuid,'transactional','sent')`,
      ),
    ).rejects.toThrow();
  });
  it("admits outbound SMTP attempts atomically and keeps another tenant's allowance independent", async () => {
    vi.stubEnv("PLATFORM_MODE", "hosted");
    vi.stubEnv("TENANT_OUTBOUND_PER_HOUR", "1");
    let sends = 0;
    const transport = {
      sendMail: async () => {
        sends++;
        return {};
      },
    } as unknown as Transporter;
    const send = (tenantId: string) =>
      runtime.withTenant(tenantId, (tx) =>
        sendTenantMail(transport, tx, tenantId, { to: recipient, text: "Allowance fixture" }),
      );
    try {
      const outcomes = await Promise.allSettled([send(tenants[0]!), send(tenants[0]!)]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(sends).toBe(1);
      await send(tenants[1]!);
      expect(sends).toBe(2);
    } finally {
      vi.stubEnv("PLATFORM_MODE", "single");
    }
  });
});
