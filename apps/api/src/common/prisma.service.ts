import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { createPrismaClient, Prisma, PrismaClient, Tx } from "@retail/db";

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient = createPrismaClient();

  /** Runs fn in a READ COMMITTED transaction. Row locks (FOR UPDATE / conditional updates) provide concurrency safety. */
  tx<T>(fn: (tx: Tx) => Promise<T>, opts: { timeout?: number } = {}): Promise<T> {
    return this.client.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: opts.timeout ?? 20_000,
      maxWait: 10_000,
    });
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
