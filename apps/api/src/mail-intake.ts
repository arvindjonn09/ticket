import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Database } from "./database.js";
import { TicketsService } from "./modules/tickets/tickets.service.js";
import { InboundMailService } from "./modules/inbound-mail/inbound-mail.service.js";
import { createMailIntakeServer } from "./mail-intake.server.js";

@Module({ providers: [Database, TicketsService, InboundMailService] })
class MailIntakeModule {}

const keyFile = process.env.MAIL_INTAKE_TLS_KEY_FILE;
const certFile = process.env.MAIL_INTAKE_TLS_CERT_FILE;
if (!!keyFile !== !!certFile || (process.env.NODE_ENV === "production" && !keyFile))
  throw new Error("Configure both mail intake TLS certificate files before production startup");
const port = Number(process.env.MAIL_INTAKE_PORT ?? 25);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid SMTP intake port");
const context = await NestFactory.createApplicationContext(MailIntakeModule, { logger: false });
const db = context.get(Database);
await db.assertRuntimeRole();
const inbound = context.get(InboundMailService);
let rejected = 0;
let rejectionFlush: Promise<unknown> | undefined;
function flushRejections(): Promise<unknown> {
  if (rejectionFlush || !rejected) return rejectionFlush ?? Promise.resolve();
  const count = rejected;
  rejected = 0;
  rejectionFlush = db.$executeRaw`SELECT record_platform_mail_rejection(${count}::bigint)`
    .catch(() => {
      rejected += count;
    })
    .finally(() => {
      rejectionFlush = undefined;
    });
  return rejectionFlush;
}
// Batch anonymous refusal counts so abusive SMTP commands do not each write a DB row.
const rejectionTimer = setInterval(() => void flushRejections(), 5000).unref();
const server = createMailIntakeServer({
  resolveRecipient: (recipient) => inbound.smtpRecipient(recipient),
  accept: (message) => inbound.acceptSmtp(message),
  onRejected: () => {
    rejected++;
  },
  maxMessageBytes: process.env.MAIL_INTAKE_MAX_BYTES
    ? Number(process.env.MAIL_INTAKE_MAX_BYTES)
    : undefined,
  maxClients: process.env.MAIL_INTAKE_MAX_CLIENTS
    ? Number(process.env.MAIL_INTAKE_MAX_CLIENTS)
    : undefined,
  maxConnectionsPerIp: process.env.MAIL_INTAKE_CONNECTIONS_PER_IP
    ? Number(process.env.MAIL_INTAKE_CONNECTIONS_PER_IP)
    : undefined,
  maxConnectionsPerSender: process.env.MAIL_INTAKE_CONNECTIONS_PER_SENDER
    ? Number(process.env.MAIL_INTAKE_CONNECTIONS_PER_SENDER)
    : undefined,
  messagesPerIpPerMinute: process.env.MAIL_INTAKE_MESSAGES_PER_IP_MINUTE
    ? Number(process.env.MAIL_INTAKE_MESSAGES_PER_IP_MINUTE)
    : undefined,
  messagesPerSenderPerMinute: process.env.MAIL_INTAKE_MESSAGES_PER_SENDER_MINUTE
    ? Number(process.env.MAIL_INTAKE_MESSAGES_PER_SENDER_MINUTE)
    : undefined,
  ...(keyFile && certFile ? { key: await readFile(keyFile), cert: await readFile(certFile) } : {}),
});
server.on("error", () => {
  clearInterval(rejectionTimer);
  console.error(JSON.stringify({ event: "mail.intake.error" }));
  void context.close().finally(() => process.exit(1));
});
server.listen(port, "0.0.0.0", () =>
  console.info(JSON.stringify({ event: "mail.intake.started", port })),
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(rejectionTimer);
    server.close(
      () =>
        void (async () => {
          await rejectionFlush;
          await flushRejections();
          await context.close();
          process.exit(0);
        })(),
    );
  });
