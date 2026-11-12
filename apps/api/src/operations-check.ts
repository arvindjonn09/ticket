import "reflect-metadata";
import { createTransport } from "nodemailer";
import { z } from "zod";
import { Database } from "./database.js";
import { operationalHealth } from "./operations.js";

const db = new Database();
try {
  await db.assertRuntimeRole();
  const status = await operationalHealth(db);
  console.info(JSON.stringify(status));
  if (!status.healthy) {
    process.exitCode = 1;
    if (process.argv.includes("--notify")) {
      const recipient = z.email().parse(process.env.OPERATOR_ALERT_EMAIL);
      if (!process.env.SMTP_HOST || !process.env.SMTP_FROM)
        throw new Error("Alert transport is not configured");
      const mail = createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === "true",
        requireTLS: process.env.NODE_ENV === "production" && process.env.SMTP_SECURE !== "true",
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
        ...(process.env.SMTP_USER
          ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } }
          : {}),
      });
      try {
        await mail.sendMail({
          from: process.env.SMTP_FROM,
          to: recipient,
          subject: "Astrama operational check needs attention",
          text:
            "Unhealthy components: " +
            Object.entries(status.checks)
              .filter(([, ok]) => !ok)
              .map(([name]) => name)
              .join(", ") +
            ". Check the private operator logs and deployment runbook.",
        });
      } finally {
        mail.close();
      }
    }
  }
} catch {
  console.error("Operational check failed. Inspect the private service configuration.");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
