import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Database } from "./database.js";
import { TenantLifecycleService } from "./modules/lifecycle/lifecycle.service.js";

@Module({ providers: [Database, TenantLifecycleService] })
class TenantLifecycleModule {}

const context = await NestFactory.createApplicationContext(TenantLifecycleModule, {
  logger: false,
});
const service = context.get(TenantLifecycleService);
let running = false;
const run = async () => {
  if (running) return;
  running = true;
  try {
    await service.run();
  } catch {
    console.error(JSON.stringify({ event: "tenant.lifecycle.failed" }));
  } finally {
    running = false;
  }
};
await run();
const timer = setInterval(() => void run(), 60_000);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    void context.close().then(() => process.exit(0));
  });
