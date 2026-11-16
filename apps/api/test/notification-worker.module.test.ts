import { NestFactory } from "@nestjs/core";
import { expect, it, vi } from "vitest";
import { NotificationWorkerModule } from "../src/modules/notifications/notification-worker.module.js";
import { NotificationWorker } from "../src/modules/notifications/notifications.service.js";

it("resolves the notification worker and its services through Nest providers", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://astrama:local@127.0.0.1:5432/astrama");
  vi.stubEnv("SMTP_HOST", "127.0.0.1");
  vi.stubEnv("SMTP_FROM", "astrama@example.test");
  vi.stubEnv("APP_ORIGIN", "https://astrama.example.test");
  const context = await NestFactory.createApplicationContext(NotificationWorkerModule, {
    logger: false,
  });
  try {
    expect(context.get(NotificationWorker)).toBeInstanceOf(NotificationWorker);
  } finally {
    await context.close();
    vi.unstubAllEnvs();
  }
});
