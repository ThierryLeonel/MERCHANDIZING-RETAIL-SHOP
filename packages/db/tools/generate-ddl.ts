/**
 * Generates PostgreSQL DDL from the Prisma schema (DMMF).
 *
 * Why this exists: the Prisma schema engine binary could not be downloaded in
 * the build environment, so `prisma migrate dev` was unavailable. This tool
 * produced the committed initial migration (0001_init). Future migrations may
 * be authored with `prisma migrate diff` where the engine is available, or
 * written by hand; `drift-check.ts` verifies the live DB matches the schema.
 *
 * Every scalar *_id column that is not a Prisma relation must appear in
 * FK_TARGETS (or POLYMORPHIC) — the tool fails otherwise, so no foreign key is
 * silently forgotten. All foreign keys use ON DELETE RESTRICT.
 *
 * Usage: pnpm --filter @retail/db ddl > database/migrations/<dir>/migration.sql
 */
import { getDMMF } from "@prisma/internals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Polymorphic references and identifiers that merely end in _id (not FKs).
const POLYMORPHIC = new Set(["source_id", "source_line_id", "subject_id", "entity_id", "owner_id", "tax_id", "event_id", "external_id"]);

const FK_TARGETS: Record<string, string> = {
  business_id: "businesses",
  branch_id: "branches", from_branch_id: "branches", to_branch_id: "branches", default_branch_id: "branches",
  location_id: "locations", from_location_id: "locations", to_location_id: "locations",
  user_id: "users", cashier_id: "users", actor_id: "users",
  created_by_id: "users", approved_by_id: "users", posted_by_id: "users", confirmed_by_id: "users",
  decided_by_id: "users", requested_by_id: "users", closed_by_id: "users", counted_by_id: "users",
  dispatched_by_id: "users", received_by_id: "users", uploaded_by_id: "users",
  variant_id: "product_variants", bundle_variant_id: "product_variants", component_variant_id: "product_variants",
  product_id: "products",
  department_id: "departments", category_id: "categories", brand_id: "brands",
  base_unit_id: "units", unit_id: "units", tax_rate_id: "tax_rates",
  output_account_id: "accounts", input_account_id: "accounts", gl_account_id: "accounts",
  account_id: "accounts", expense_account_id: "accounts",
  financial_account_id: "financial_accounts", counter_account_id: "financial_accounts",
  float_source_account_id: "financial_accounts", closing_transfer_account_id: "financial_accounts",
  till_account_id: "financial_accounts", from_account_id: "financial_accounts", to_account_id: "financial_accounts",
  clearing_account_id: "financial_accounts", destination_account_id: "financial_accounts",
  image_attachment_id: "attachments",
  supplier_id: "suppliers", preferred_supplier_id: "suppliers",
  customer_id: "customers", customer_group_id: "customer_groups",
  approval_request_id: "approval_requests", variance_approval_id: "approval_requests",
  journal_entry_id: "journal_entries", closing_journal_id: "journal_entries", reversal_of_id: "journal_entries",
  purchase_order_id: "purchase_orders", purchase_order_line_id: "purchase_order_lines",
  goods_receipt_id: "goods_receipts", goods_receipt_line_id: "goods_receipt_lines",
  supplier_invoice_id: "supplier_invoices", supplier_invoice_line_id: "supplier_invoice_lines",
  purchase_return_id: "purchase_returns",
  batch_id: "batches", serial_number_id: "serial_numbers",
  sale_id: "sales", sale_line_id: "sale_lines", sales_return_id: "sales_returns", exchange_return_id: "sales_returns",
  register_id: "cash_registers", cashier_session_id: "cashier_sessions",
  payment_id: "payments", fiscal_period_id: "fiscal_periods", expense_category_id: "expense_categories",
  journal_line_id: "journal_lines",
};

/** Table-specific overrides where a column name means something else. */
const FK_OVERRIDES: Record<string, string> = {
  "categories.parent_id": "categories",
  "accounts.parent_id": "accounts",
  "journal_entries.reversed_by_id": "journal_entries",
};

type Field = any;
type Model = any;

function q(id: string) {
  return `"${id}"`;
}

function columnType(f: Field, enums: Set<string>): string {
  if (f.kind === "enum") return q(f.type) + (f.isList ? "[]" : "");
  const nt = f.nativeType as [string, string[]] | undefined;
  let t: string;
  switch (f.type) {
    case "String":
      if (nt?.[0] === "Uuid") t = "UUID";
      else if (nt?.[0] === "VarChar") t = `VARCHAR(${nt[1][0]})`;
      else t = "TEXT";
      break;
    case "Int": t = "INTEGER"; break;
    case "BigInt": t = "BIGINT"; break;
    case "Boolean": t = "BOOLEAN"; break;
    case "Json": t = "JSONB"; break;
    case "Decimal": t = nt ? `DECIMAL(${nt[1].join(",")})` : "DECIMAL(65,30)"; break;
    case "DateTime":
      if (nt?.[0] === "Date") t = "DATE";
      else if (nt?.[0] === "Timestamptz") t = `TIMESTAMPTZ(${nt[1][0] ?? 6})`;
      else t = "TIMESTAMP(3)";
      break;
    default:
      if (enums.has(f.type)) return q(f.type);
      throw new Error(`Unsupported type ${f.type} on ${f.name}`);
  }
  return t + (f.isList ? "[]" : "");
}

function defaultClause(f: Field): string {
  if (f.isUpdatedAt) return " DEFAULT CURRENT_TIMESTAMP";
  if (!f.hasDefaultValue) return "";
  const d = f.default;
  if (d && typeof d === "object" && !Array.isArray(d) && "name" in d) {
    if (d.name === "uuid") return " DEFAULT gen_random_uuid()";
    if (d.name === "now") return " DEFAULT CURRENT_TIMESTAMP";
    if (d.name === "dbgenerated") return ` DEFAULT ${d.args[0]}`;
    throw new Error(`Unsupported default fn ${d.name}`);
  }
  if (Array.isArray(d)) return ` DEFAULT ARRAY[]::TEXT[]`;
  if (typeof d === "string") {
    if (f.kind === "enum") return ` DEFAULT '${d}'`;
    return ` DEFAULT '${d.replace(/'/g, "''")}'`;
  }
  return ` DEFAULT ${d}`;
}

async function main() {
  const schemaPath = join(__dirname, "..", "..", "..", "database", "prisma", "schema.prisma");
  const dmmf = await getDMMF({ datamodel: readFileSync(schemaPath, "utf8") });
  const dm = dmmf.datamodel;
  const enums = new Set<string>(dm.enums.map((e: any) => e.name));
  const tableOf = (modelName: string) => {
    const m = dm.models.find((x: Model) => x.name === modelName);
    return (m.dbName ?? m.name) as string;
  };
  const out: string[] = [];
  const fks: string[] = [];
  const idx: string[] = [];

  out.push("-- Generated by packages/db/tools/generate-ddl.ts from database/prisma/schema.prisma");
  out.push("CREATE EXTENSION IF NOT EXISTS pgcrypto;\n");

  for (const e of dm.enums) {
    out.push(`CREATE TYPE ${q(e.name)} AS ENUM (${e.values.map((v: any) => `'${v.name}'`).join(", ")});`);
  }
  out.push("");

  for (const m of dm.models as Model[]) {
    const table = m.dbName ?? m.name;
    const cols: string[] = [];
    const scalarRelationCols = new Set<string>();
    for (const f of m.fields) {
      if (f.kind === "object" && f.relationFromFields?.length) {
        f.relationFromFields.forEach((c: string) => scalarRelationCols.add(c));
      }
    }
    for (const f of m.fields as Field[]) {
      if (f.kind === "object") continue;
      const col = f.dbName ?? f.name;
      cols.push(`  ${q(col)} ${columnType(f, enums)}${f.isRequired || f.isList ? " NOT NULL" : ""}${defaultClause(f)}`);
    }
    const pkFields: string[] = m.primaryKey?.fields ?? m.fields.filter((f: Field) => f.isId).map((f: Field) => f.name);
    cols.push(`  CONSTRAINT ${q(table + "_pkey")} PRIMARY KEY (${pkFields.map(q).join(", ")})`);
    out.push(`CREATE TABLE ${q(table)} (\n${cols.join(",\n")}\n);\n`);

    // Unique constraints (field-level and model-level)
    for (const f of m.fields as Field[]) {
      if (f.isUnique) idx.push(`CREATE UNIQUE INDEX ${q(`${table}_${f.name}_key`)} ON ${q(table)}(${q(f.name)});`);
    }
    for (const u of m.uniqueFields as string[][]) {
      idx.push(`CREATE UNIQUE INDEX ${q(`${table}_${u.join("_")}_key`)} ON ${q(table)}(${u.map(q).join(", ")});`);
    }

    // Relations declared in Prisma
    for (const f of m.fields as Field[]) {
      if (f.kind !== "object" || !f.relationFromFields?.length) continue;
      const target = tableOf(f.type);
      const name = `${table}_${f.relationFromFields.join("_")}_fkey`;
      fks.push(
        `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(name)} FOREIGN KEY (${f.relationFromFields.map(q).join(", ")}) REFERENCES ${q(target)}(${f.relationToFields.map(q).join(", ")}) ON DELETE RESTRICT ON UPDATE CASCADE;`,
      );
    }
    // Convention-based foreign keys for scalar id columns
    for (const f of m.fields as Field[]) {
      if (f.kind === "object" || f.isId) continue;
      const col: string = f.name;
      if (!/_id$/.test(col) || scalarRelationCols.has(col) || POLYMORPHIC.has(col)) continue;
      const target = FK_OVERRIDES[`${table}.${col}`] ?? FK_TARGETS[col];
      if (!target) throw new Error(`No FK target for ${table}.${col}; add to FK_TARGETS or POLYMORPHIC`);
      fks.push(
        `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(`${table}_${col}_fkey`)} FOREIGN KEY (${q(col)}) REFERENCES ${q(target)}("id") ON DELETE RESTRICT ON UPDATE CASCADE;`,
      );
      // index FK columns that are not already the leading column of an index
      idx.push(`CREATE INDEX IF NOT EXISTS ${q(`${table}_${col}_idx`)} ON ${q(table)}(${q(col)});`);
    }
  }

  // @@index declarations
  for (const i of (dm as any).indexes ?? []) {
    if (i.type !== "normal") continue;
    const table = tableOf(i.model);
    const fields = i.fields.map((f: any) => f.name);
    idx.push(`CREATE INDEX IF NOT EXISTS ${q(i.dbName ?? `${table}_${fields.join("_")}_idx`)} ON ${q(table)}(${fields.map(q).join(", ")});`);
  }

  out.push("-- Indexes");
  const seen = new Set<string>();
  for (const stmt of idx) {
    const name = stmt.match(/INDEX (?:IF NOT EXISTS )?"([^"]+)"/)![1];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(stmt);
  }
  out.push("\n-- Foreign keys (ON DELETE RESTRICT everywhere: posted records are never cascade-deleted)");
  out.push(...fks);
  process.stdout.write(out.join("\n") + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
