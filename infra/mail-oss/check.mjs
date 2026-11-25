import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { setTimeout } from "node:timers/promises";

const require = createRequire("/app/apps/api/package.json");
const { PrismaClient } = require("@prisma/client");
const nodemailer = require("nodemailer");
const db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
const domain = process.env.MAIL_OSS_DOMAIN || "astrama.localhost";
const recipient = `ossfixture@in.${domain}`;
const messageId = `<${process.env.MAIL_OSS_TEST_RUN}@sender.example.test>`;
const subject = `OSS mail check ${process.env.MAIL_OSS_TEST_RUN}`;
const mode = process.argv[2];
let runtime, platformTransport;

async function eventually(check, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await check().catch(() => false);
    if (result) return result;
    await setTimeout(500);
  }
  throw new Error(`Timed out: ${description}`);
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "mox", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

try {
  if (mode === "seed") {
    const state = await db.platformMailSettings.findUniqueOrThrow({ where: { id: true } });
    assert.equal(state.activeProfileId, null, "Use a fresh disposable database");
    assert.equal(await db.platformMailProfile.count(), 0, "Use a fresh disposable database");
    const { encryptSecret } = await import("/app/apps/api/dist/mfa.js");
    const { password, ...smtpSettings } = JSON.parse(
      await readFile("/mox/private/smtp-profile.json", "utf8"),
    );
    // Only this disposable fixture bypasses the HTTP test/MFA activation flow covered elsewhere.
    const selected = await db.platformMailProfile.create({
      data: {
        id: randomUUID(),
        settings: { ...smtpSettings, name: "Disposable Mox", provider: "mox" },
        encryptedPassword: encryptSecret(password, "platform-smtp"),
        testedAt: new Date(),
      },
    });
    await db.platformMailSettings.update({
      where: { id: true },
      data: { activeProfileId: selected.id, revision: { increment: 1 } },
    });
    const tenant = await db.tenant.create({
      data: { slug: "ossfixture", name: "Disposable OSS mail check", brandName: "Astrama" },
    });
    const agent = await db.user.create({
      data: {
        tenantId: tenant.id,
        name: "Disposable agent",
        email: "agent@example.test",
        passwordHash: "disabled-fixture-password",
        role: "agent",
      },
    });
    const queue = await db.department.create({
      data: {
        tenantId: tenant.id,
        name: "Disposable triage",
        isTriage: true,
        queueOwnerId: agent.id,
      },
    });
    await db.membership.create({
      data: { tenantId: tenant.id, userId: agent.id, departmentId: queue.id },
    });
    const category = await db.category.create({
      data: { tenantId: tenant.id, name: "Disposable general", departmentId: queue.id },
    });
    await db.inboundMailSettings.create({
      data: { tenantId: tenant.id, triageDepartmentId: queue.id, triageCategoryId: category.id },
    });
    await db.inboundMailAddress.create({
      data: {
        tenantId: tenant.id,
        address: recipient,
        departmentId: queue.id,
        categoryId: category.id,
        isGeneral: true,
      },
    });
    console.info("PASS disposable tenant, mapped intake and encrypted active Mox profile seeded");
  } else if (mode === "check") {
    assert.equal((await stat("/mox/private")).mode & 0o777, 0o700);
    assert.equal((await stat("/mox/private/smtp-profile.json")).mode & 0o777, 0o600);
    assert.deepEqual(await readdir("/mail-oss-ca"), ["ca.crt"]);
    console.info("PASS private credentials and separate public-certificate-only volume");
    const profile = JSON.parse(await readFile("/mox/private/smtp-profile.json", "utf8"));
    const options = {
      host: "mox",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: profile.username, pass: profile.password },
      connectionTimeout: 3000,
      greetingTimeout: 3000,
      socketTimeout: 5000,
    };
    const transport = nodemailer.createTransport(options);
    await eventually(() => transport.verify(), "verified STARTTLS and SMTP authentication");
    console.info("PASS authenticated SMTP STARTTLS with CA and hostname verification");
    for (const port of [25, 143, 993, 80, 443, 465]) assert.equal(await listening(port), false);
    console.info("PASS Mox inbound SMTP, IMAP and HTTP listeners disabled");
    await assert.rejects(nodemailer.createTransport({ ...options, tls: { ca: [] } }).verify());
    console.info("PASS untrusted certificate rejected");
    await assert.rejects(
      nodemailer
        .createTransport({ ...options, tls: { servername: "wrong-host.example.test" } })
        .verify(),
    );
    await assert.rejects(
      nodemailer.createTransport({ ...options, requireTLS: false, ignoreTLS: true }).verify(),
    );
    console.info("PASS wrong TLS hostname and plaintext authentication refused");
    await assert.rejects(
      nodemailer
        .createTransport({
          ...options,
          auth: { user: profile.username, pass: "wrong-disposable-password" },
        })
        .verify(),
    );
    await assert.rejects(
      nodemailer.createTransport({ ...options, auth: undefined }).sendMail({
        from: profile.fromAddress,
        to: recipient,
        subject: "Must refuse unauthenticated relay",
        text: "Disposable check",
      }),
    );
    console.info("PASS wrong credentials and unauthenticated relay refused");
    const intake = nodemailer.createTransport({
      host: "mail-intake",
      port: 2525,
      ignoreTLS: true,
      connectionTimeout: 3000,
      greetingTimeout: 3000,
      socketTimeout: 5000,
    });
    await eventually(() => intake.verify(), "intake readiness");
    await assert.rejects(
      intake.sendMail({
        from: "outsider@example.test",
        to: "unknown@outside.example.test",
        subject: "Must refuse unknown recipient",
        text: "Disposable check",
      }),
      (error) => error.responseCode === 550 && error.command === "RCPT TO",
    );
    console.info("PASS intake unknown RCPT refused with 550; no open relay");
    await transport.sendMail({
      from: { name: "Disposable Astrama Support", address: profile.fromAddress },
      to: recipient,
      messageId,
      subject,
      text: "Disposable queue persistence check",
    });
    const queued = await eventually(
      () => db.inboundMessage.findFirst({ where: { messageId } }),
      "Mox normal queue delivery to PostgreSQL intake",
    );
    assert.equal(queued.recipient, recipient);
    assert.equal(queued.status, "queued");
    assert.equal(queued.senderEmail, profile.fromAddress);
    assert.notEqual(queued.authResults.dmarc, "pass");
    assert.equal(await db.inboundMessage.count({ where: { messageId } }), 1);
    console.info(
      "PASS real Mox queue -> mail-intake -> durable tenant-scoped PostgreSQL queue; local DNS is unverified",
    );
    require("reflect-metadata");
    const { Database } = await import("/app/apps/api/dist/database.js");
    const { createPlatformTransport, sendTenantMail } =
      await import("/app/apps/api/dist/platform-mail.js");
    const { encryptSecret } = await import("/app/apps/api/dist/mfa.js");
    runtime = new Database();
    await runtime.assertRuntimeRole();
    platformTransport = createPlatformTransport(runtime);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: "ossfixture" } });
    assert.equal(queued.tenantId, tenant.id);
    const activeMessageId = `<${process.env.MAIL_OSS_TEST_RUN}-active@${domain}>`;
    await runtime.withTenant(tenant.id, (tx) =>
      sendTenantMail(platformTransport, tx, tenant.id, {
        to: recipient,
        messageId: `<${process.env.MAIL_OSS_TEST_RUN}-active@ignored.example.test>`,
        subject: `${subject} active profile`,
        text: "Disposable active platform transport check",
      }),
    );
    const activeMessage = await eventually(
      () => db.inboundMessage.findFirst({ where: { messageId: activeMessageId } }),
      "active platform profile delivery through Mox to intake",
    );
    assert.equal(activeMessage.tenantId, tenant.id);
    assert.equal(activeMessage.senderEmail, profile.fromAddress);
    assert.equal(activeMessage.recipient, recipient);
    // An Astrama-generated Message-ID must retain the existing self-notification loop protection.
    assert.equal(activeMessage.status, "ignored");
    console.info(
      "PASS runtime active profile -> Mox -> actual intake with platform identity and loop protection",
    );
    const state = await db.platformMailSettings.findUniqueOrThrow({ where: { id: true } });
    const previous = await db.platformMailProfile.findUniqueOrThrow({
      where: { id: state.activeProfileId },
    });
    // Model credentials becoming invalid after an earlier successful profile test.
    const invalidated = await db.platformMailProfile.create({
      data: {
        id: randomUUID(),
        settings: previous.settings,
        encryptedPassword: encryptSecret("wrong-revision-fixture-password", "platform-smtp"),
        testedAt: new Date(),
      },
    });
    await db.platformMailSettings.update({
      where: { id: true },
      data: {
        activeProfileId: invalidated.id,
        previousProfileId: previous.id,
        revision: { increment: 1 },
      },
    });
    await assert.rejects(
      platformTransport.sendMail({
        to: recipient,
        subject: "Must reload invalidated credentials",
        text: "Disposable cache check",
      }),
    );
    await db.platformMailSettings.update({
      where: { id: true },
      data: {
        activeProfileId: previous.id,
        previousProfileId: invalidated.id,
        revision: { increment: 1 },
      },
    });
    await runtime.withTenant(tenant.id, (tx) =>
      sendTenantMail(platformTransport, tx, tenant.id, {
        to: "operator@outside.example.test",
        subject: `${subject} capture`,
        messageId: `<${process.env.MAIL_OSS_TEST_RUN}-capture@ignored.example.test>`,
        text: "Disposable active platform capture check",
      }),
    );
    const captured = await eventually(async () => {
      const response = await fetch("http://mail:8025/api/v1/messages");
      const body = await response.json();
      return body.messages?.find((message) => message.Subject === `${subject} capture`);
    }, "Mox catch-all transport to Mailpit");
    const capturedMessage = await fetch(`http://mail:8025/api/v1/message/${captured.ID}`).then(
      (response) => response.json(),
    );
    assert.deepEqual(capturedMessage.From, {
      Name: "Astrama Support",
      Address: profile.fromAddress,
    });
    assert.equal(
      capturedMessage.MessageID.replace(/^<|>$/g, ""),
      `${process.env.MAIL_OSS_TEST_RUN}-capture@${domain}`,
    );
    console.info(
      "PASS active profile revision changes and rollback refresh the same runtime transport without restart",
    );
    console.info(
      "PASS active tenant mail preserves brand and platform headers; other mail reaches Mailpit",
    );
    transport.close();
    intake.close();
  } else if (mode === "durable") {
    const queued = await db.inboundMessage.findFirstOrThrow({ where: { messageId } });
    assert.equal(queued.status, "queued");
    assert.equal(await db.inboundMessage.count({ where: { messageId } }), 1);
    console.info("PASS queued message survives intake restart");
  } else throw new Error("Unknown OSS mail check mode");
} catch (error) {
  // SMTP errors can contain identities; never print credentials, content or full error objects.
  console.error(`OSS mail check failed (${mode}): ${error.code || error.name || "error"}`);
  process.exitCode = 1;
} finally {
  platformTransport?.close();
  await runtime?.$disconnect();
  await db.$disconnect();
}
