import "reflect-metadata";
import { INestApplicationContext, Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { PrismaService } from "../common/prisma.service";
import { config } from "../config";
import { PaymentAdapterRegistry } from "../modules/sales/payment-adapters";
import { SalesService } from "../modules/sales/sales.service";
import { processOutboxBatch } from "./outbox";

/**
 * Background worker loop: transactional outbox (after-commit work) and
 * periodic recovery (payment attempt timeouts). Safe to run in several
 * processes at once (events are claimed with FOR UPDATE SKIP LOCKED).
 * Runs inside the API process by default (RUN_WORKER=true) or standalone.
 */
export function startWorkerLoop(app: INestApplicationContext) {
  const prisma = app.get(PrismaService);
  const sales = app.get(SalesService);
  const adapters = app.get(PaymentAdapterRegistry);
  const log = new Logger("Worker");
  let stopping = false;
  log.log(`Worker started (poll ${config.workerPollMs}ms, mobile money: ${config.mobileMoneyMode})`);
  const done = (async () => {
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
  })();
  return { stop: async () => { stopping = true; await done; } };
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });
  const w = startWorkerLoop(app);
  const shutdown = async () => { await w.stop(); await app.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
if (require.main === module) main();
