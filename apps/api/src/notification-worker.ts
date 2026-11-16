import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NotificationWorker } from "./modules/notifications/notifications.service.js";
import { NotificationWorkerModule } from "./modules/notifications/notification-worker.module.js";

const context = await NestFactory.createApplicationContext(NotificationWorkerModule, {
  logger: false,
});
const worker = context.get(NotificationWorker);
await worker.start();
console.info(JSON.stringify({ event: "notification.worker.started" }));
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void worker.stop().then(
      async () => {
        await context.close();
        process.exit(0);
      },
      async () => {
        await context.close();
        process.exit(1);
      },
    );
  });
