import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
const testIp = "fd00:" + randomUUID().replaceAll("-", "").match(/.{4}/g)!.slice(0, 7).join(":");
import { hash } from "argon2";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { INestApplicationContext } from "@nestjs/common";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Database } from "../src/database.js";
import { encryptSecret, totp } from "../src/mfa.js";
import type { NotificationWorker } from "../src/modules/notifications/notifications.service.js";
import { createNotificationWorker } from "./notification-worker.helper.js";
import { scanFile } from "../src/modules/attachments/attachments.service.js";
import { csvCell } from "../src/modules/reports/reports.service.js";

type Identity = { cookie: string; csrf: string; id: string };
const configured =
  process.env.DATABASE_URL &&
  process.env.MIGRATION_DATABASE_URL &&
  process.env.S3_ENDPOINT &&
  process.env.CLAMAV_HOST &&
  process.env.SMTP_HOST;
describe.skipIf(!configured)("scanned attachments and durable notification delivery", () => {
  let app: NestFastifyApplication,
    owner: PrismaClient,
    db: Database,
    worker: NotificationWorker,
    workerContext: INestApplicationContext;
  let employee: Identity, agent: Identity, outsider: Identity, foreign: Identity;
  let ticketId: string, tenantId: string, otherId: string;
  const origin = "http://localhost:4310",
    password = "Delivery-tests-password-2026!";
  const objects: string[] = [];
  const call = (method: "GET" | "POST", path: string, who: Identity, payload?: unknown) =>
    app.inject({
      remoteAddress: testIp,
      method,
      url: `/api${path}`,
      headers: {
        origin,
        cookie: who.cookie,
        "x-csrf-token": who.csrf,
        "idempotency-key": randomUUID(),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  async function login(slug: string, email: string) {
    const user = await owner.user.findFirstOrThrow({ where: { tenant: { slug }, email } });
    const response = await app.inject({
      remoteAddress: testIp,
      method: "POST",
      url: "/api/auth/login",
      headers: { origin },
      payload: {
        organisation: slug,
        email,
        password,
        ...(user.mfaEnrolled
          ? { totpCode: totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", Math.floor(Date.now() / 30000)) }
          : {}),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const cookies = response.headers["set-cookie"];
    return {
      cookie: (Array.isArray(cookies) ? cookies[0]! : cookies!).split(";")[0]!,
      csrf: response.json().csrfToken,
      id: response.json().user.id,
    };
  }
  async function upload(who: Identity, audience: string, contents: string) {
    const revision = (await call("GET", `/tickets/${ticketId}`, who)).json().revision;
    const boundary = "astrama-" + randomUUID();
    const body = [
      `--${boundary}\r\nContent-Disposition: form-data; name="audience"\r\n\r\n${audience}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="revision"\r\n\r\n${revision}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="support.txt"\r\nContent-Type: text/plain\r\n\r\n${contents}`,
      `--${boundary}--\r\n`,
    ].join("\r\n");
    return app.inject({
      remoteAddress: testIp,
      method: "POST",
      url: `/api/tickets/${ticketId}/attachments`,
      headers: {
        origin,
        cookie: who.cookie,
        "x-csrf-token": who.csrf,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
  }
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.APP_ORIGIN = origin;
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    db = new Database();
    const tenant = await owner.tenant.create({
      data: { slug: `delivery-${randomUUID()}`, name: "Delivery test", brandName: "Astrama" },
    });
    tenantId = tenant.id;
    const other = await owner.tenant.create({
      data: { slug: `foreign-delivery-${randomUUID()}`, name: "Other", brandName: "Astrama" },
    });
    otherId = other.id;
    const passwordHash = await hash(password);
    for (const [email, role] of [
      ["employee@delivery.test", "employee"],
      ["agent@delivery.test", "agent"],
      ["outsider@delivery.test", "employee"],
      ["queue-owner@delivery.test", "agent"],
      ["substitute@delivery.test", "agent"],
      ["admin@delivery.test", "admin"],
      ["other-agent@delivery.test", "agent"],
    ]) {
      const id = randomUUID();
      const supportUser = role === "agent" || role === "admin";
      await owner.user.create({
        data: {
          id,
          tenantId,
          email: email!,
          name: role!,
          role: role!,
          passwordHash,
          mfaEnrolled: supportUser,
          mfaSecret: supportUser
            ? encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", `${tenantId}:${id}`)
            : null,
        },
      });
    }
    await owner.user.create({
      data: {
        tenantId: otherId,
        email: "foreign@delivery.test",
        name: "Foreign",
        role: "employee",
        passwordHash,
      },
    });
    const group = await owner.department.create({
      data: { tenantId, name: "Support", isTriage: true },
    });
    const queueOwner = await owner.user.findFirstOrThrow({
      where: { tenantId, email: "queue-owner@delivery.test" },
    });
    const substitute = await owner.user.findFirstOrThrow({
      where: { tenantId, email: "substitute@delivery.test" },
    });
    await owner.department.update({
      where: { id: group.id },
      data: { queueOwnerId: queueOwner.id, substituteId: substitute.id },
    });
    for (const email of [
      "agent@delivery.test",
      "queue-owner@delivery.test",
      "substitute@delivery.test",
    ])
      await owner.membership.create({
        data: {
          tenantId,
          departmentId: group.id,
          userId: (await owner.user.findFirstOrThrow({ where: { tenantId, email } })).id,
        },
      });
    const otherGroup = await owner.department.create({ data: { tenantId, name: "Other group" } });
    const otherAgent = await owner.user.findFirstOrThrow({
      where: { tenantId, email: "other-agent@delivery.test" },
    });
    await owner.membership.create({
      data: { tenantId, departmentId: otherGroup.id, userId: otherAgent.id },
    });
    const category = await owner.category.create({
      data: { tenantId, departmentId: group.id, name: "Help" },
    });
    const { createApp } = await import("../dist/main.js");
    app = await createApp();
    await app.getHttpAdapter().getInstance().ready();
    employee = await login(tenant.slug, "employee@delivery.test");
    agent = await login(tenant.slug, "agent@delivery.test");
    outsider = await login(tenant.slug, "outsider@delivery.test");
    foreign = await login(other.slug, "foreign@delivery.test");
    const response = await call("POST", "/tickets", employee, {
      categoryId: category.id,
      summary: "Attachment integration test",
      description: "Test protected files and delivery without disclosure.",
    });
    expect(response.statusCode, response.body).toBe(201);
    ticketId = response.json().id;
    ({ context: workerContext, worker } = await createNotificationWorker());
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await workerContext?.close();
    await db?.$disconnect();
    if (!owner) return;
    if (tenantId)
      objects.push(
        ...(await owner.attachment.findMany({ where: { tenantId } })).map((a) => a.storageKey),
      );
    const storage = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
      },
    });
    for (const Key of new Set(objects))
      await storage.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key }));
    storage.destroy();
    for (const id of [tenantId, otherId].filter(Boolean))
      for (const table of [
        "notification_deliveries",
        "automation_settings",
        "attachments",
        "approvals",
        "approval_delegations",
        "idempotency",
        "outbox",
        "audits",
        "activities",
        "tickets",
        "catalog_items",
        "config_audits",
        "sessions",
        "memberships",
        "subcategories",
        "categories",
        "counters",
        "departments",
        "users",
        "tenants",
      ])
        await owner.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "${table === "tenants" ? "id" : "tenant_id"}"=$1::uuid`,
          id,
        );
    await owner.$disconnect();
  });
  it("scans real bytes, protects downloads, rejects malware and enforces terminal state", async () => {
    const clean = await upload(employee, "customer", "A clean attachment with useful diagnostics.");
    expect(clean.statusCode, clean.body).toBe(201);
    const publicFile = (await call("GET", `/tickets/${ticketId}/attachments`, employee)).json()
      .attachments[0];
    const download = await call(
      "GET",
      `/tickets/${ticketId}/attachments/${publicFile.id}/download`,
      employee,
    );
    expect(download.statusCode, download.body).toBe(200);
    expect(download.body).toContain("clean attachment");
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["cache-control"]).toContain("no-store");
    expect(
      (await call("GET", `/tickets/${ticketId}/attachments/${publicFile.id}/download`, outsider))
        .statusCode,
    ).toBe(404);
    expect(
      (await call("GET", `/tickets/${ticketId}/attachments/${publicFile.id}/download`, foreign))
        .statusCode,
    ).toBe(404);
    expect((await upload(employee, "internal", "Not permitted")).statusCode).toBe(403);
    expect((await upload(agent, "internal", "Internal diagnosis")).statusCode).toBe(201);
    expect(
      (await call("GET", `/tickets/${ticketId}/attachments`, employee)).json().attachments,
    ).toHaveLength(1);
    const files = (await call("GET", `/tickets/${ticketId}/attachments`, agent)).json().attachments;
    const internal = files.find((f: { audience: string }) => f.audience === "internal");
    expect(
      (await call("GET", `/tickets/${ticketId}/attachments/${internal.id}/download`, employee))
        .statusCode,
    ).toBe(404);
    const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    expect((await upload(employee, "customer", eicar)).statusCode).toBe(400);
    await expect(scanFile(Buffer.from("safe"), "127.0.0.1", 1)).rejects.toThrow("unavailable");
    await owner.ticket.update({ where: { id: ticketId }, data: { state: "Complete" } });
    expect((await upload(employee, "customer", "Too late")).statusCode).toBe(403);
  }, 60000);
  it("sends committed events once per delivery record and suppresses internal/unauthorized recipients", async () => {
    const event = await owner.outbox.findFirstOrThrow({
      where: { tenantId, ticketId, event: "incident.created" },
    });
    const previousMode = process.env.PLATFORM_MODE,
      previousBase = process.env.APP_BASE_DOMAIN;
    process.env.PLATFORM_MODE = "hosted";
    process.env.APP_BASE_DOMAIN = "astrama.test";
    try {
      await worker.deliver({ tenantId, eventId: event.id });
      if (process.env.MAILPIT_URL) {
        const mailbox = (await fetch(
          `${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent("to:agent@delivery.test")}`,
        ).then((response) => response.json())) as { messages: { ID: string }[] };
        const message = (await fetch(
          `${process.env.MAILPIT_URL}/api/v1/message/${mailbox.messages[0]!.ID}`,
        ).then((response) => response.json())) as { Text: string };
        expect(message.Text).toContain(
          `https://${(await owner.tenant.findUniqueOrThrow({ where: { id: tenantId } })).slug}.astrama.test/tickets/${ticketId}`,
        );
      }
    } finally {
      if (previousMode === undefined) delete process.env.PLATFORM_MODE;
      else process.env.PLATFORM_MODE = previousMode;
      if (previousBase === undefined) delete process.env.APP_BASE_DOMAIN;
      else process.env.APP_BASE_DOMAIN = previousBase;
    }
    const sent = await owner.notificationDelivery.findMany({
      where: { tenantId, eventId: event.id, status: "sent" },
    });
    const queueRecipients = await owner.user.findMany({
      where: { tenantId, email: { in: ["queue-owner@delivery.test", "substitute@delivery.test"] } },
      select: { id: true },
    });
    expect(new Set(sent.map((d) => d.recipientId))).toEqual(
      new Set([employee.id, agent.id, ...queueRecipients.map((user) => user.id)]),
    );
    await worker.deliver({ tenantId, eventId: event.id });
    expect(
      (await owner.notificationDelivery.findMany({ where: { tenantId, eventId: event.id } })).map(
        (d) => d.attempts,
      ),
    ).toEqual(sent.map(() => 1));
    const privateEvent = await owner.outbox.findFirstOrThrow({
      where: {
        tenantId,
        ticketId,
        event: "ticket.attachment",
        payload: { path: ["audience"], equals: "internal" },
      },
    });
    await worker.deliver({ tenantId, eventId: privateEvent.id });
    expect(
      (
        await owner.notificationDelivery.findMany({
          where: { tenantId, eventId: privateEvent.id, status: "sent" },
        })
      )
        .map((d) => d.recipientId)
        .sort(),
    ).toEqual([agent.id, ...queueRecipients.map((user) => user.id)].sort());
    await expect(worker.deliver({ tenantId: otherId, eventId: event.id })).resolves.toBeUndefined();
    await expect(
      worker.deliver({ tenantId: randomUUID(), eventId: event.id }),
    ).resolves.toBeUndefined();
    const fresh = await owner.outbox.create({
      data: { tenantId, ticketId, event: "ticket.message", payload: { audience: "customer" } },
    });
    await owner.user.update({ where: { id: employee.id }, data: { active: false } });
    await worker.deliver({ tenantId, eventId: fresh.id });
    expect(
      await owner.notificationDelivery.count({
        where: { tenantId, eventId: fresh.id, recipientId: employee.id },
      }),
    ).toBe(0);
  }, 30000);
  it("routes SLA warnings internally to the queue and breaches to the assignee plus responsible admin", async () => {
    const queueOwner = await owner.user.findFirstOrThrow({
      where: { tenantId, email: "queue-owner@delivery.test" },
    });
    const substitute = await owner.user.findFirstOrThrow({
      where: { tenantId, email: "substitute@delivery.test" },
    });
    const responsibleAdmin = await owner.user.findFirstOrThrow({
      where: { tenantId, email: "admin@delivery.test" },
    });
    const otherAgent = await owner.user.findFirstOrThrow({
      where: { tenantId, email: "other-agent@delivery.test" },
    });
    await owner.$executeRaw`INSERT INTO automation_settings(tenant_id,responsible_admin_id) VALUES (${tenantId}::uuid,${responsibleAdmin.id}::uuid)`;

    const warning = await owner.outbox.create({
      data: {
        tenantId,
        ticketId,
        event: "sla.warning",
        payload: { kind: "sla", audience: "internal", target: "first_response", stage: "warning" },
      },
    });
    await worker.deliver({ tenantId, eventId: warning.id });
    expect(
      (
        await owner.notificationDelivery.findMany({
          where: { tenantId, eventId: warning.id, status: "sent" },
        })
      )
        .map((delivery) => delivery.recipientId)
        .sort(),
    ).toEqual([queueOwner.id, substitute.id].sort());

    await owner.ticket.update({ where: { id: ticketId }, data: { assignedToId: agent.id } });
    const breach = await owner.outbox.create({
      data: {
        tenantId,
        ticketId,
        event: "sla.breach",
        payload: { kind: "sla", audience: "internal", target: "resolution", stage: "breach" },
      },
    });
    await worker.deliver({ tenantId, eventId: breach.id });
    expect(
      (
        await owner.notificationDelivery.findMany({
          where: { tenantId, eventId: breach.id, status: "sent" },
        })
      )
        .map((delivery) => delivery.recipientId)
        .sort(),
    ).toEqual([agent.id, responsibleAdmin.id].sort());
    expect(
      await owner.notificationDelivery.count({
        where: {
          tenantId,
          eventId: { in: [warning.id, breach.id] },
          recipientId: { in: [employee.id, otherAgent.id] },
          status: "sent",
        },
      }),
    ).toBe(0);
  }, 30000);
  it("exports only permitted tickets with CSV formula escaping and audited access", async () => {
    const ticket = await owner.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    await owner.ticket.update({
      where: { id: ticketId },
      data: { slaFirstRespondedAt: new Date(ticket.createdAt.getTime() + 3600000) },
    });
    await owner.activity.create({
      data: {
        tenantId,
        ticketId,
        authorId: agent.id,
        audience: "customer",
        body: "Response timing fixture",
        createdAt: new Date(ticket.createdAt.getTime() + 3600000),
      },
    });
    await owner.audit.create({
      data: {
        tenantId,
        ticketId,
        actorId: agent.id,
        action: "incident.state",
        detail: { from: "In Progress", to: "Resolved" },
        createdAt: new Date(ticket.createdAt.getTime() + 4 * 3600000),
      },
    });
    const summary = (await call("GET", "/reports/summary", agent)).json();
    expect(summary.medianFirstResponseHours).toBe(1);
    expect(summary.medianResolutionHours).toBe(4);
    expect(summary.openCount).toBe(0);
    expect(csvCell('=HYPERLINK("evil")')).toBe('"\'=HYPERLINK(""evil"")"');
    expect((await call("GET", "/reports/export", outsider)).statusCode).toBe(403);
    const result = await call("GET", "/reports/export", agent);
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("Attachment integration test");
    expect(await owner.configAudit.count({ where: { tenantId, action: "tickets.exported" } })).toBe(
      1,
    );
    expect((await call("GET", "/reports/summary", foreign)).json().total).toBe(0);
  });
  it("honours immediate/off/daily preferences, sends one private digest across workers and preserves critical alerts", async () => {
    const preference = (userId: string, mode: string) =>
      owner.notificationPreference.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        create: { tenantId, userId, mode },
        update: { mode },
      });
    const mailbox = async () => {
      if (!process.env.MAILPIT_URL) return [] as { ID: string }[];
      const result = (await fetch(
        `${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent('to:agent@delivery.test subject:"Daily service desk updates"')}`,
      ).then((r) => r.json())) as { messages: { ID: string }[] };
      return result.messages;
    };
    await owner.user.update({ where: { id: employee.id }, data: { active: true } });
    const second = await createNotificationWorker();
    try {
      await preference(employee.id, "off");
      await preference(agent.id, "daily");
      const prior = new Set((await mailbox()).map((m) => m.ID));
      const old = await owner.outbox.create({
        data: {
          tenantId,
          ticketId,
          event: "ticket.message",
          payload: { audience: "customer" },
          createdAt: new Date(Date.now() - 2 * 86400000),
        },
      });
      const today = await owner.outbox.create({
        data: { tenantId, ticketId, event: "ticket.message", payload: { audience: "customer" } },
      });
      for (const event of [old, today]) await worker.deliver({ tenantId, eventId: event.id });
      expect(
        await owner.notificationDelivery.findUniqueOrThrow({
          where: {
            tenantId_eventId_recipientId: { tenantId, eventId: old.id, recipientId: employee.id },
          },
        }),
      ).toMatchObject({ status: "skipped", attempts: 0 });
      expect(
        await owner.notificationDelivery.findUniqueOrThrow({
          where: {
            tenantId_eventId_recipientId: { tenantId, eventId: old.id, recipientId: agent.id },
          },
        }),
      ).toMatchObject({ status: "deferred", attempts: 0 });
      // Exercise the existing private dispatcher directly without starting global queue timers.
      const digest = worker as unknown as { dispatchDigests(): Promise<void> };
      await Promise.all([
        digest.dispatchDigests(),
        (second.worker as unknown as typeof digest).dispatchDigests(),
      ]);
      expect(
        await owner.notificationDelivery.findUniqueOrThrow({
          where: {
            tenantId_eventId_recipientId: { tenantId, eventId: old.id, recipientId: agent.id },
          },
        }),
      ).toMatchObject({ status: "sent", attempts: 1 });
      expect(
        await owner.notificationDelivery.findUniqueOrThrow({
          where: {
            tenantId_eventId_recipientId: { tenantId, eventId: today.id, recipientId: agent.id },
          },
        }),
      ).toMatchObject({ status: "deferred", attempts: 0 });
      if (process.env.MAILPIT_URL) {
        const messages = (await mailbox()).filter((m) => !prior.has(m.ID));
        expect(messages).toHaveLength(1);
        const message = (await fetch(
          `${process.env.MAILPIT_URL}/api/v1/message/${messages[0]!.ID}`,
        ).then((r) => r.json())) as { Text: string };
        expect(message.Text).toContain("You have 1 service desk updates");
        expect(message.Text).not.toContain("Attachment integration test");
        expect(message.Text).not.toContain("Response timing fixture");
      }
      await preference(agent.id, "off");
      const critical = await owner.outbox.create({
        data: {
          tenantId,
          ticketId,
          event: "sla.breach",
          payload: { kind: "sla", audience: "internal", target: "resolution", stage: "breach" },
        },
      });
      await worker.deliver({ tenantId, eventId: critical.id });
      expect(
        await owner.notificationDelivery.findUniqueOrThrow({
          where: {
            tenantId_eventId_recipientId: { tenantId, eventId: critical.id, recipientId: agent.id },
          },
        }),
      ).toMatchObject({ status: "sent", attempts: 1 });
      await digest.dispatchDigests();
      expect(
        await owner.notificationDelivery.findUniqueOrThrow({
          where: {
            tenantId_eventId_recipientId: { tenantId, eventId: today.id, recipientId: agent.id },
          },
        }),
      ).toMatchObject({ status: "deferred" });
      await owner.outbox.update({
        where: { id: today.id },
        data: { createdAt: new Date(Date.now() - 2 * 86400000) },
      });
      await digest.dispatchDigests();
      expect(
        await owner.notificationDelivery.findUniqueOrThrow({
          where: {
            tenantId_eventId_recipientId: { tenantId, eventId: today.id, recipientId: agent.id },
          },
        }),
      ).toMatchObject({ status: "skipped" });
    } finally {
      await second.context.close();
      await owner.notificationPreference.deleteMany({
        where: { tenantId, userId: { in: [employee.id, agent.id] } },
      });
      await owner.user.update({ where: { id: employee.id }, data: { active: false } });
    }
  }, 30000);
  it.skipIf(process.env.RUN_QUEUE_TESTS !== "true")(
    "dispatches through PostgreSQL jobs and preserves delivery deduplication after restart",
    async () => {
      // Run separately from other fixture suites: the real dispatcher processes the whole database.
      const event = await owner.outbox.create({
        data: { tenantId, ticketId, event: "ticket.message", payload: { audience: "customer" } },
      });
      // The dispatcher scans every tenant. Keep prior suites' pending rows out
      // of this queue test so this event does not wait behind unrelated jobs.
      await owner.outbox.updateMany({
        where: { id: { not: event.id }, publishedAt: null },
        data: { publishedAt: new Date() },
      });
      expect(await db.outbox.count()).toBe(0);
      const pending = await db.$queryRaw<
        { tenant_id: string; id: string }[]
      >`SELECT * FROM pending_outbox_events()`;
      expect(pending.length).toBeGreaterThan(0);
      // Earlier integration fixtures may leave unrelated jobs in this disposable test database.
      const [queue] = await owner.$queryRaw<{ exists: boolean }[]>`
        SELECT to_regclass('pgboss.job') IS NOT NULL AS exists
      `;
      if (queue.exists)
        await owner.$executeRaw`DELETE FROM pgboss.job WHERE name='ticket-notification'`;
      try {
        await worker.start();
        await expect
          .poll(
            async () =>
              owner.notificationDelivery.count({
                where: { tenantId, eventId: event.id, status: "sent" },
              }),
            { timeout: 30000 },
          )
          .toBe(1);
      } finally {
        await worker.stop();
      }
      const first = await owner.notificationDelivery.findMany({
        where: { tenantId, eventId: event.id },
      });
      // Simulate the enqueue/mark-published crash window; the event/job identity stays unchanged.
      await owner.outbox.update({ where: { id: event.id }, data: { publishedAt: null } });
      await workerContext.close();
      ({ context: workerContext, worker } = await createNotificationWorker());
      try {
        await worker.start();
        await expect
          .poll(
            async () =>
              (await owner.outbox.findUniqueOrThrow({ where: { id: event.id } })).publishedAt,
            { timeout: 15000 },
          )
          .not.toBeNull();
        expect(
          await owner.notificationDelivery.findMany({ where: { tenantId, eventId: event.id } }),
        ).toEqual(first);
      } finally {
        await worker.stop();
      }
    },
    60000,
  );
});
