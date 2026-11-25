import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { createMailIntakeServer } from "../src/mail-intake.server.js";
import { Database } from "../dist/database.js";
import { consumeForwardingProbe } from "../src/platform-inbox.js";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { argon2id, hash } from "argon2";
import { vi } from "vitest";
import { encryptSecret } from "../src/mfa.js";
import {
  replyTokenHash,
  webhookSignature,
} from "../src/modules/inbound-mail/inbound-mail.adapter.js";

const configured = process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL;
const authPass = { spf: "pass", dkim: "pass", dmarc: "pass" } as const;

describe.skipIf(!configured)("inbound mail PostgreSQL acceptance", () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let service: InboundMailService;
  let tenantId: string;
  let otherTenantId: string;
  let departmentId: string;
  let categoryId: string;
  const address = "help@inbound.test";
  let secretA: string;
  let secretB: string;
  let employeeId: string;
  let agentId: string;
  let otherAgentId: string;
  let tenantSlug: string;
  let summarizeCaller: (ticketId: string) => Promise<string>;
  let sequence = 100000;

  const message = (overrides: Record<string, unknown> = {}) => ({
    messageId: `<inbound-${randomUUID()}@sender.test>`,
    recipient: address,
    sender: "employee@inbound.test",
    subject: "Email support request",
    text: "Please help with this issue.",
    authResults: authPass,
    ...overrides,
  });

  async function deliver(
    input: Record<string, unknown>,
    options: { secret?: string; timestamp?: string; signature?: string } = {},
  ) {
    const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify(input);
    const signature =
      options.signature ?? webhookSignature(timestamp, rawBody, options.secret ?? secretA);
    return app.inject({
      method: "POST",
      url: "/api/inbound-mail/webhook",
      headers: {
        "x-astrama-timestamp": timestamp,
        "x-astrama-signature": signature,
        "content-type": "application/json",
      },
      payload: rawBody,
    });
  }

  async function employeeTicketView(ticketId: string) {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: process.env.APP_ORIGIN },
      payload: {
        organisation: tenantSlug,
        email: "employee@inbound.test",
        password: "Inbound-employee-password-2026!",
      },
    });
    expect(login.statusCode, login.body).toBe(201);
    const cookies = login.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies[0]! : cookies!).split(";")[0]!;
    const response = await app.inject({
      method: "GET",
      url: `/api/tickets/${ticketId}`,
      headers: { origin: process.env.APP_ORIGIN, cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.body;
  }

  async function makeTicket(state = "Open") {
    sequence++;
    return owner.ticket.create({
      data: {
        tenantId,
        type: "incident",
        sequence,
        number: `INC${String(sequence).padStart(4, "0")}`,
        summary: `Inbound correlation ${sequence}`,
        description: "Existing customer ticket",
        state,
        priority: "P3",
        severity: "S3",
        categoryId,
        departmentId,
        callerId: employeeId,
        submittedById: employeeId,
        untriaged: false,
      },
    });
  }

  async function makeDelivery(
    ticketId: string,
    recipientId: string,
    audience: string,
    token?: string,
  ) {
    const event = await owner.outbox.create({
      data: {
        tenantId,
        ticketId,
        event: "ticket.message",
        payload: { audience },
      },
    });
    return owner.notificationDelivery.create({
      data: {
        tenantId,
        eventId: event.id,
        recipientId,
        ...(token ? { replyTokenHash: replyTokenHash(token) } : {}),
      },
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.APP_ORIGIN ??= "http://localhost:4310";
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    const { createApp } = await import("../dist/main.js");
    const { InboundMailService } =
      await import("../dist/modules/inbound-mail/inbound-mail.service.js");
    const { TicketsService, ticketInclude } =
      await import("../dist/modules/tickets/tickets.service.js");
    app = await createApp();
    await app.getHttpAdapter().getInstance().ready();
    service = app.get(InboundMailService);
    const tickets = app.get(TicketsService);
    summarizeCaller = async (ticketId) => {
      const ticket = await owner.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: ticketInclude,
      });
      return tickets.summary(ticket).callerName;
    };

    secretA = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    secretB = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    const setupTenant = async (slug: string, address: string, secret: string) => {
      const tenant = await owner.tenant.create({
        data: { slug: `${slug}-${randomUUID()}`, name: slug, brandName: "Astrama" },
      });
      const department = await owner.department.create({
        data: { tenantId: tenant.id, name: "Mail triage", isTriage: true },
      });
      const category = await owner.category.create({
        data: { tenantId: tenant.id, departmentId: department.id, name: "General help" },
      });
      const agent = await owner.user.create({
        data: {
          tenantId: tenant.id,
          email: `${slug}-agent@inbound.test`,
          name: `${slug} queue agent`,
          role: "agent",
          passwordHash: "test-only-password-hash",
        },
      });
      await owner.department.update({
        where: { id: department.id },
        data: { queueOwnerId: agent.id },
      });
      await owner.membership.create({
        data: { tenantId: tenant.id, departmentId: department.id, userId: agent.id },
      });
      await owner.inboundMailSettings.create({
        data: {
          tenantId: tenant.id,
          triageDepartmentId: department.id,
          triageCategoryId: category.id,
          encryptedWebhookSecret: encryptSecret(secret, `inbound-mail:${tenant.id}`),
          allowUnverifiedSenders: true,
        },
      });
      await owner.inboundMailAddress.create({
        data: {
          tenantId: tenant.id,
          address,
          departmentId: department.id,
          categoryId: category.id,
          isGeneral: true,
        },
      });
      return {
        slug: tenant.slug,
        tenantId: tenant.id,
        departmentId: department.id,
        categoryId: category.id,
        agentId: agent.id,
      };
    };

    const primary = await setupTenant("inbound-a", address, secretA);
    tenantSlug = primary.slug;
    tenantId = primary.tenantId;
    departmentId = primary.departmentId;
    categoryId = primary.categoryId;
    agentId = primary.agentId;
    const other = await setupTenant("inbound-b", "other@inbound.test", secretB);
    otherTenantId = other.tenantId;
    otherAgentId = other.agentId;
    const employee = await owner.user.create({
      data: {
        tenantId,
        email: "employee@inbound.test",
        name: "Mail employee",
        role: "employee",
        passwordHash: await hash("Inbound-employee-password-2026!", { type: argon2id }),
      },
    });
    employeeId = employee.id;
    const otherAgent = await owner.user.create({
      data: {
        tenantId,
        email: "other-agent@inbound.test",
        name: "Other queue agent",
        role: "agent",
        passwordHash: "test-only-password-hash",
      },
    });
    otherAgentId = otherAgent.id;
    await owner.membership.create({
      data: { tenantId, departmentId, userId: otherAgent.id },
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    if (!owner) return;
    for (const id of [tenantId, otherTenantId].filter(Boolean)) {
      await owner.ticket.updateMany({ where: { tenantId: id }, data: { duplicateOfId: null } });
      await owner.department.updateMany({
        where: { tenantId: id },
        data: { queueOwnerId: null, substituteId: null },
      });
      for (const table of [
        "inbound_messages",
        "inbound_sender_rates",
        "inbound_mail_addresses",
        "inbound_mail_settings",
        "notification_deliveries",
        "attachments",
        "approvals",
        "approval_delegations",
        "idempotency",
        "outbox",
        "audits",
        "activities",
        "tickets",
        "notification_preferences",
        "sla_settings",
        "automation_settings",
        "config_audits",
        "sessions",
        "memberships",
        "categories",
        "departments",
        "users",
        "counters",
        "tenants",
      ])
        await owner.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "${table === "tenants" ? "id" : "tenant_id"}"=$1::uuid`,
          id,
        );
    }
    await owner.$disconnect();
  });

  it("rejects tenant B signatures and bad or expired webhook signatures", async () => {
    const input = message();
    expect((await deliver(input, { secret: secretB })).statusCode).toBe(401);
    expect((await deliver(input, { signature: "00".repeat(32) })).statusCode).toBe(401);
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    expect((await deliver(input, { timestamp })).statusCode).toBe(401);
  });

  it("authenticates the exact raw JSON bytes from the webhook request", async () => {
    const input = message();
    const rawBody = JSON.stringify(input, null, 2);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = webhookSignature(timestamp, rawBody, secretA);
    const valid = await app.inject({
      method: "POST",
      url: "/api/inbound-mail/webhook",
      headers: {
        "content-type": "application/json",
        "x-astrama-timestamp": timestamp,
        "x-astrama-signature": signature,
      },
      payload: rawBody,
    });
    expect(valid.statusCode, valid.body).toBe(202);
    const altered = await app.inject({
      method: "POST",
      url: "/api/inbound-mail/webhook",
      headers: {
        "content-type": "application/json",
        "x-astrama-timestamp": timestamp,
        "x-astrama-signature": signature,
      },
      payload: rawBody.replace("  ", " "),
    });
    expect(altered.statusCode).toBe(401);
  });

  it("returns the same unauthorized response for unknown addresses and missing tenant secrets", async () => {
    const unknown = await deliver(message({ recipient: "unknown@inbound.test" }));
    await owner.inboundMailSettings.update({
      where: { tenantId: otherTenantId },
      data: { encryptedWebhookSecret: null },
    });
    const unconfigured = await deliver(message({ recipient: "other@inbound.test" }), {
      secret: secretB,
    });
    expect(unknown.statusCode).toBe(401);
    expect(unconfigured.statusCode).toBe(401);
    expect(unknown.json().message).toBe(unconfigured.json().message);
  });

  it("deduplicates message IDs and ignores loops and automatic replies", async () => {
    const duplicate = message();
    expect((await deliver(duplicate)).statusCode).toBe(202);
    expect((await deliver(duplicate)).statusCode).toBe(202);
    expect(
      await owner.inboundMessage.count({ where: { tenantId, messageId: duplicate.messageId } }),
    ).toBe(1);

    const automatic = message({ headers: { autoSubmitted: "auto-replied" } });
    expect((await deliver(automatic)).statusCode).toBe(202);
    const row = await owner.inboundMessage.findUniqueOrThrow({
      where: { tenantId_messageId: { tenantId, messageId: automatic.messageId } },
    });
    expect(row.status).toBe("ignored");
  });

  it("stores the twenty-first message as ignored without retaining its content", async () => {
    const sender = `rate-${randomUUID()}@sender.test`;
    const sent = [];
    for (let count = 1; count <= 21; count++)
      sent.push(
        await deliver(message({ sender, subject: `message ${count}`, text: "private body" })),
      );
    expect(sent.every((response) => response.statusCode === 202)).toBe(true);
    const limited = await owner.inboundMessage.findFirstOrThrow({
      where: { tenantId, senderEmail: sender, subject: "" },
    });
    expect(limited.status).toBe("ignored");
    expect(limited.lastError).toBe("rate_limited");
    expect(limited.textBody).toBe("");
    expect(limited.htmlBody).toBeNull();
    expect(limited.attachments).toEqual([]);
    expect(await owner.inboundMessage.count({ where: { tenantId, senderEmail: sender } })).toBe(21);
  });

  it("keeps the 150 KB login limit while allowing the larger webhook route", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: process.env.APP_ORIGIN, "content-type": "application/json" },
      payload: JSON.stringify({
        organisation: "x",
        email: "x@example.test",
        password: "x".repeat(200000),
      }),
    });
    expect(login.statusCode).toBe(413);
    const oversizedWebhook = await app.inject({
      method: "POST",
      url: "/api/inbound-mail/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(message({ text: "x".repeat(200000) })),
    });
    expect(oversizedWebhook.statusCode).toBe(400);
  });

  it("keeps a known but unauthenticated sender unverified and routes to triage", async () => {
    const input = message({
      authResults: { spf: "fail", dkim: "fail", dmarc: "fail" },
    });
    await deliver(input);
    await service.dispatch();
    const row = await owner.inboundMessage.findUniqueOrThrow({
      where: { tenantId_messageId: { tenantId, messageId: input.messageId as string } },
    });
    const ticket = await owner.ticket.findFirstOrThrow({ where: { tenantId, id: row.ticketId! } });
    expect(ticket.inboundUnverified).toBe(true);
    const requester = await owner.user.findUniqueOrThrow({ where: { id: ticket.callerId } });
    expect(requester).toMatchObject({ name: "Email intake", role: "system", active: false });
    expect(ticket.submittedById).toBe(requester.id);
    expect(await summarizeCaller(ticket.id)).toBe(input.sender);
    expect(ticket.departmentId).toBe(departmentId);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: process.env.APP_ORIGIN },
      payload: {
        organisation: tenantSlug,
        email: `email-intake@${tenantSlug}.invalid`,
        password: "not-a-system-user-password",
      },
    });
    expect(login.statusCode).toBe(401);
  });

  it.each([
    [{ spf: "fail", dkim: "pass", dmarc: "pass" }, "aligned DKIM passes when SPF fails"],
    [{ spf: "pass", dkim: "fail", dmarc: "pass" }, "aligned SPF passes when DKIM fails"],
  ] as const)("accepts a DMARC-authenticated sender: %s (%s)", async (authResults) => {
    const input = message({ authResults });
    await deliver(input);
    await service.dispatch();
    const row = await owner.inboundMessage.findUniqueOrThrow({
      where: { tenantId_messageId: { tenantId, messageId: input.messageId as string } },
    });
    const ticket = await owner.ticket.findFirstOrThrow({ where: { tenantId, id: row.ticketId! } });
    expect(ticket.inboundUnverified).toBe(false);
    expect(ticket.callerId).toBe(employeeId);
  });

  it("correlates replies by reply token, delivery ID, and ticket number", async () => {
    const tokenTicket = await makeTicket();
    const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    await makeDelivery(tokenTicket.id, employeeId, "customer", token);
    const tokenReply = message({
      recipient: `help+t.${token}@inbound.test`,
      subject: "A reply with a token",
    });
    await deliver(tokenReply);

    const deliveryTicket = await makeTicket();
    const delivery = await makeDelivery(deliveryTicket.id, employeeId, "customer");
    const deliveryReply = message({
      inReplyTo: `<${delivery.id}@astrama.test>`,
      subject: "A reply with In-Reply-To",
    });
    await deliver(deliveryReply);

    const subjectTicket = await makeTicket();
    const subjectReply = message({ subject: `Re: [${subjectTicket.number}] Please help` });
    await deliver(subjectReply);
    await service.dispatch();

    for (const [input, ticket] of [
      [tokenReply, tokenTicket],
      [deliveryReply, deliveryTicket],
      [subjectReply, subjectTicket],
    ] as const) {
      const row = await owner.inboundMessage.findUniqueOrThrow({
        where: { tenantId_messageId: { tenantId, messageId: input.messageId as string } },
      });
      expect(row.ticketId).toBe(ticket.id);
    }
  });

  it("keeps internal email replies internal and requires the delivery recipient to match", async () => {
    const ticket = await makeTicket();
    const internalDelivery = await makeDelivery(ticket.id, agentId, "internal");
    const reply = message({
      sender: "inbound-a-agent@inbound.test",
      inReplyTo: `<${internalDelivery.id}@astrama.test>`,
    });
    await deliver(reply);
    await service.dispatch();
    const activity = await owner.activity.findFirstOrThrow({
      where: { tenantId, ticketId: ticket.id, body: "Please help with this issue." },
    });
    expect(activity.audience).toBe("internal");
    const replyEvent = await owner.outbox.findFirstOrThrow({
      where: { tenantId, ticketId: ticket.id, event: "ticket.message" },
      orderBy: { createdAt: "desc" },
    });
    expect(replyEvent.payload).toMatchObject({ audience: "internal", inbound: true });
    expect(await employeeTicketView(ticket.id)).not.toContain("Please help with this issue.");

    const mismatchDelivery = await makeDelivery(ticket.id, otherAgentId, "customer");
    const mismatch = message({
      sender: "inbound-a-agent@inbound.test",
      inReplyTo: `<${mismatchDelivery.id}@astrama.test>`,
    });
    await deliver(mismatch);
    await service.dispatch();
    const unmatched = await owner.inboundMessage.findUniqueOrThrow({
      where: { tenantId_messageId: { tenantId, messageId: mismatch.messageId as string } },
    });
    expect(unmatched.ticketId).not.toBe(ticket.id);
    expect(await owner.activity.count({ where: { tenantId, ticketId: ticket.id } })).toBe(1);
  });

  it("marks the first customer-visible agent email reply as the first SLA response", async () => {
    const ticket = await makeTicket();
    const delivery = await makeDelivery(ticket.id, agentId, "customer");
    const reply = message({
      sender: "inbound-a-agent@inbound.test",
      inReplyTo: `<${delivery.id}@astrama.test>`,
    });
    await deliver(reply);
    await service.dispatch();
    const updated = await owner.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updated.slaFirstRespondedAt).toBeInstanceOf(Date);
  });

  it("turns a reply to a Complete ticket into a linked duplicate", async () => {
    const ticket = await makeTicket("Complete");
    const delivery = await makeDelivery(ticket.id, employeeId, "customer");
    const reply = message({
      inReplyTo: `<${delivery.id}@astrama.test>`,
      subject: "Follow-up on completed work",
    });
    await deliver(reply);
    await service.dispatch();
    const row = await owner.inboundMessage.findUniqueOrThrow({
      where: { tenantId_messageId: { tenantId, messageId: reply.messageId as string } },
    });
    const duplicate = await owner.ticket.findUniqueOrThrow({ where: { id: row.ticketId! } });
    expect(duplicate.duplicateOfId).toBe(ticket.id);
  });

  it("accepts a customer reply on a Resolved ticket without treating it as closure confirmation", async () => {
    const ticket = await makeTicket("Resolved");
    const delivery = await makeDelivery(ticket.id, employeeId, "customer");
    const reply = message({
      inReplyTo: `<${delivery.id}@astrama.test>`,
      text: "The issue is still happening.",
    });
    await deliver(reply);
    await service.dispatch();
    expect((await owner.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).state).toBe(
      "Resolved",
    );
    const activity = await owner.activity.findFirstOrThrow({
      where: { tenantId, ticketId: ticket.id, body: reply.text as string },
    });
    expect(activity.audience).toBe("customer");
  });

  it.skipIf(!process.env.S3_ENDPOINT || !process.env.CLAMAV_HOST)(
    "logs processing failure metadata and deletes uploaded objects after a rolled-back transaction",
    async () => {
      const input = message({
        attachments: [
          {
            filename: "diagnostics.txt",
            contentType: "text/plain",
            contentBase64: Buffer.from("safe diagnostic attachment").toString("base64"),
          },
        ],
      });
      await deliver(input);
      const row = await owner.inboundMessage.findUniqueOrThrow({
        where: { tenantId_messageId: { tenantId, messageId: input.messageId as string } },
      });
      const trigger = `inbound_failure_${randomUUID().replaceAll("-", "")}`;
      await owner.$executeRawUnsafe(`
        CREATE FUNCTION public.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.tenant_id = '${tenantId}'::uuid AND NEW.status = 'processed' THEN
            RAISE EXCEPTION 'forced inbound processing rollback' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END $$
      `);
      await owner.$executeRawUnsafe(
        `CREATE TRIGGER ${trigger} BEFORE UPDATE ON public.inbound_messages FOR EACH ROW EXECUTE FUNCTION public.${trigger}()`,
      );
      const storage = (service as unknown as { storage: S3Client }).storage;
      const send = vi.spyOn(storage, "send");
      const logger = (service as unknown as { logger: { error: (value: string) => void } }).logger;
      const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        await service.dispatch();
        const uploadKeys = send.mock.calls.flatMap(([command]) =>
          command instanceof PutObjectCommand ? [command.input.Key!] : [],
        );
        expect(uploadKeys).toHaveLength(1);
        const details = JSON.parse(String(log.mock.calls[0]?.[0]));
        expect(details).toMatchObject({
          event: "inbound_message_processing_failed",
          tenantId,
          inboundMessageId: row.id,
          attempt: 1,
          errorName: expect.any(String),
        });
        expect(JSON.stringify(details)).not.toContain(input.subject);
        const check = new S3Client({
          endpoint: process.env.S3_ENDPOINT,
          region: process.env.S3_REGION ?? "us-east-1",
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY!,
            secretAccessKey: process.env.S3_SECRET_KEY!,
          },
        });
        try {
          await expect(
            check.send(
              new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: uploadKeys[0] }),
            ),
          ).rejects.toThrow();
        } finally {
          await check.destroy();
        }
        expect(await owner.attachment.count({ where: { tenantId } })).toBe(0);
      } finally {
        send.mockRestore();
        log.mockRestore();
        await owner.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON public.inbound_messages`);
        await owner.$executeRawUnsafe(`DROP FUNCTION public.${trigger}()`);
      }
    },
  );
  it("receives real SMTP into durable intake, accepts forwarded DKIM, and triages a spoofed From without trusting supplied headers", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const server = createMailIntakeServer({
      resolveRecipient: (recipient) => service.smtpRecipient(recipient),
      accept: (input) => service.acceptSmtp(input),
      trustedTestOptions: {
        resolver: async (name, type) => {
          if (type === "TXT" && name === "inbound.test") return [["v=spf1 ip4:192.0.2.1 -all"]];
          if (type === "TXT" && name === "_dmarc.inbound.test") return [["v=DMARC1; p=reject"]];
          if (type === "TXT" && name === "fixture._domainkey.inbound.test")
            return [[`v=DKIM1; k=rsa; p=${key}`]];
          throw Object.assign(new Error("Fixture DNS absent"), { code: "ENODATA" });
        },
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.server.address() as { port: number }).port;
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port, ignoreTLS: true });
    const signedId = `<smtp-${randomUUID()}@inbound.test>`,
      spoofedId = `<spoof-${randomUUID()}@inbound.test>`;
    try {
      await expect(
        transport.sendMail({
          from: "employee@inbound.test",
          to: "unknown@inbound.test",
          text: "Refuse unknown",
        }),
      ).rejects.toMatchObject({ responseCode: 550 });
      const signed = await nodemailer
        .createTransport({
          streamTransport: true,
          buffer: true,
          dkim: {
            domainName: "inbound.test",
            keySelector: "fixture",
            privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          },
        })
        .sendMail({
          from: "employee@inbound.test",
          to: "other@inbound.test",
          messageId: signedId,
          subject: "Forwarded signed fixture",
          text: "Please help with this forwarded message.",
        });
      await transport.sendMail({
        envelope: { from: "employee@inbound.test", to: address },
        raw: signed.message as Buffer,
      });
      await transport.sendMail({
        envelope: { from: "employee@inbound.test", to: address },
        raw: signed.message as Buffer,
      });
      await transport.sendMail({
        from: "employee@inbound.test",
        to: address,
        messageId: spoofedId,
        subject: "Spoofed SMTP fixture",
        text: "Do not impersonate a known employee.",
        headers: { "Authentication-Results": "forged; dmarc=pass; dkim=pass; spf=pass" },
      });
      await service.dispatch();
      const verified = await owner.inboundMessage.findUniqueOrThrow({
        where: { tenantId_messageId: { tenantId, messageId: signedId } },
      });
      expect(await owner.inboundMessage.count({ where: { tenantId, messageId: signedId } })).toBe(
        1,
      );
      expect(verified.authResults).toEqual({ spf: "fail", dkim: "pass", dmarc: "pass" });
      expect(
        await owner.ticket.findUniqueOrThrow({ where: { id: verified.ticketId! } }),
      ).toMatchObject({ tenantId, callerId: employeeId, inboundUnverified: false });
      const spoof = await owner.inboundMessage.findUniqueOrThrow({
        where: { tenantId_messageId: { tenantId, messageId: spoofedId } },
      });
      expect(spoof.authResults).toMatchObject({ dmarc: "fail" });
      const triaged = await owner.ticket.findUniqueOrThrow({ where: { id: spoof.ticketId! } });
      expect(triaged).toMatchObject({ tenantId, departmentId, inboundUnverified: true });
      expect(triaged.callerId).not.toBe(employeeId);
      expect(
        await owner.inboundMessage.count({
          where: { tenantId: otherTenantId, messageId: { in: [signedId, spoofedId] } },
        }),
      ).toBe(0);
    } finally {
      transport.close();
      await new Promise<void>((resolve) => server.close(resolve));
    }
  }, 30000);

  it("checks forwarding with a hashed single-use probe and never returns stored secrets", async () => {
    vi.stubEnv("INBOUND_MAIL_DOMAIN", "in.astrama.test");
    const admin = await owner.user.create({
      data: {
        tenantId,
        name: "Forwarding admin",
        email: `${randomUUID()}@admin.test`,
        passwordHash: "!",
        role: "admin",
        mfaEnrolled: true,
        mfaSecret: encryptSecret("JBSWY3DPEHPK3PXP", "fixture"),
      },
    });
    const token = randomUUID(),
      csrf = randomUUID();
    await owner.session.create({
      data: {
        tenantId,
        userId: admin.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        csrfToken: csrf,
        mfaVerified: true,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const headers = {
      origin: process.env.APP_ORIGIN!,
      cookie: `astrama_session=${token}`,
      "x-csrf-token": csrf,
    };
    try {
      const foreignAlias = await app.inject({
        method: "POST",
        url: "/api/admin/inbound-mail/addresses",
        headers,
        payload: {
          address: "another-organisation@in.astrama.test",
          departmentId,
          categoryId,
          isGeneral: false,
        },
      });
      expect(foreignAlias.statusCode).toBe(400);
      const start = await app.inject({
        method: "POST",
        url: "/api/admin/inbound-mail/check",
        headers,
        payload: {},
      });
      expect(start.statusCode, start.body).toBe(201);
      const code = start.json().testCode as string;
      const settings = await owner.inboundMailSettings.findUniqueOrThrow({ where: { tenantId } });
      expect(settings.forwardingProbeHash).toBe(createHash("sha256").update(code).digest("hex"));
      const view = () => app.inject({ method: "GET", url: "/api/admin/inbound-mail", headers });
      expect((await view()).json()).toMatchObject({
        platformAddress: `${tenantSlug}@in.astrama.test`,
        forwarding: { status: "pending" },
      });
      expect(
        await owner.inboundMailAddress.findUniqueOrThrow({ where: { address } }),
      ).toMatchObject({ isGeneral: true });
      expect(
        await owner.inboundMailAddress.findUniqueOrThrow({
          where: { address: `${tenantSlug}@in.astrama.test` },
        }),
      ).toMatchObject({ isGeneral: false });
      const input = message({
        recipient: `${tenantSlug}@in.astrama.test`,
        subject: `FW: Astrama forwarding check ${code}`,
      });
      await service.acceptSmtp(input);
      const completed = await view();
      expect(completed.json().forwarding.status).toBe("working");
      expect(completed.body).not.toContain(code);
      expect(completed.body).not.toContain(settings.forwardingProbeHash!);
      expect(completed.body).not.toContain(settings.encryptedWebhookSecret!);
      const probe = await owner.inboundMessage.findUniqueOrThrow({
        where: { tenantId_messageId: { tenantId, messageId: input.messageId } },
      });
      expect(probe).toMatchObject({ status: "ignored", textBody: "", ticketId: null });
      const replacement = await app.inject({
        method: "POST",
        url: "/api/admin/inbound-mail/check",
        headers,
        payload: {},
      });
      const db = app.get(Database);
      expect(
        await db.withTenant(tenantId, (tx) => consumeForwardingProbe(tx, tenantId, code)),
      ).toBe(false);
      expect((await view()).json().forwarding.status).toBe("pending");
      const consumed = await Promise.all(
        Array.from({ length: 5 }, () =>
          db.withTenant(tenantId, (tx) =>
            consumeForwardingProbe(tx, tenantId, replacement.json().testCode),
          ),
        ),
      );
      expect(consumed.filter(Boolean)).toHaveLength(1);
      await app.inject({
        method: "POST",
        url: "/api/admin/inbound-mail/check",
        headers,
        payload: {},
      });
      await owner.inboundMailSettings.update({
        where: { tenantId },
        data: { forwardingProbeStartedAt: new Date(Date.now() - 31 * 60000) },
      });
      expect((await view()).json().forwarding.status).toBe("problem");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
