import "reflect-metadata";
import { Database } from "./database.js";
import { NotificationWorker } from "./notifications.js";

const worker = new NotificationWorker(new Database());
await worker.start();
console.info(JSON.stringify({ event: "notification.worker.started" }));
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void worker.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
