import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { PrismaService } from "../common/prisma.service";
import { config } from "../config";
import { SalesService } from "../modules/sales/sales.service";
import { PaymentAdapterRegistry } from "../modules/sales/payment-adapters";
import { processOutboxBatch } from "./outbox";

/**
 * Background worker: processes the transactional outbox (after-commit work)
 * and runs periodic recovery (payment attempt timeouts). Multiple workers are
 * safe: events are claimed with FOR UPDATE SKIP LOCKED.
 */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });
  const prisma = app.get(PrismaService);
  const sales = app.get(SalesService);
  const adapters = app.get(PaymentAdapterRegistry);
  const log = new Logger("Worker");
  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));
  log.log(`Worker started (poll ${config.workerPollMs}ms, mobile money: ${config.mobileMoneyMode})`);
  while (!stopping) {
    try {
      const n = await processOutboxBatch(prisma, adapters);
      const expired = await sales.expireStaleAttempts();
      if (n || expired) log.log(`processed ${n} outbox event(s), expired ${expired} payment attempt(s)`);
      await prisma.client.backgroundJob.upsert({ where: { name: "worker-heartbeat" }, create: { name: "worker-heartbeat", last_run_at: new Date(), last_status: "OK", run_count: 1 }, update: { last_run_at: new Date(), last_status: "OK", run_count: { increment: 1 } } });
    } catch (e) {
      log.error(`worker loop error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, config.workerPollMs));
  }
  await app.close();
}
main();
