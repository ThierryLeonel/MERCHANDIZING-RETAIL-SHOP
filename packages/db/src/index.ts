import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/client";
import { pgConnectionConfig, resolveDatabaseUrl } from "./database-url";

export { pgConnectionConfig, resolveDatabaseUrl };

export * from "../generated/client";
export { Prisma };

/** Creates a Prisma client using the engine-free pg driver adapter. */
export function createPrismaClient(databaseUrl = resolveDatabaseUrl()): PrismaClient {
  if (!databaseUrl) throw new Error("No database configured: set DATABASE_URL (or DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD)");
  const adapter = new PrismaPg({ ...pgConnectionConfig(databaseUrl), max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
  return new PrismaClient({ adapter });
}

export type Tx = Prisma.TransactionClient;
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;
