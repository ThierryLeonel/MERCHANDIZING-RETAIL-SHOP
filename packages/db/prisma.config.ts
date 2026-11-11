import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "../../database/prisma/schema.prisma",
  migrations: { path: "../../database/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/retail_dev" },
});
