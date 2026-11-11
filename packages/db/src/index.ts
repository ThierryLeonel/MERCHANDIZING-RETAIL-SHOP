import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/client";

export * from "../generated/client";
export { Prisma };

/** Creates a Prisma client using the engine-free pg driver adapter. */
export function createPrismaClient(databaseUrl = process.env.DATABASE_URL): PrismaClient {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const adapter = new PrismaPg({ connectionString: databaseUrl, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
  return new PrismaClient({ adapter });
}

export type Tx = Prisma.TransactionClient;
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;
