import { NestFactory } from "@nestjs/core";
import type { NotificationWorker } from "../src/modules/notifications/notifications.service.js";

export async function createNotificationWorker() {
  const [{ NotificationWorker }, { NotificationWorkerModule }] = await Promise.all([
    import("../dist/modules/notifications/notifications.service.js"),
    import("../dist/modules/notifications/notification-worker.module.js"),
  ]);
  const context = await NestFactory.createApplicationContext(NotificationWorkerModule, {
    logger: false,
  });
  return { context, worker: context.get(NotificationWorker) as NotificationWorker };
}
