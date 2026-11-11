/**
 * Verifies that every Prisma model/field exists in the live database with a
 * compatible type and nullability, and that every FK column has a constraint.
 * Substitutes for `prisma migrate diff` where the schema engine is unavailable.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: require("node:path").join(__dirname, "..", "..", "..", ".env"), quiet: true });
import { getDMMF } from "@prisma/internals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { pgConnectionConfig, resolveDatabaseUrl } from "../src/database-url";

const TYPE_MAP: Record<string, string[]> = {
  String: ["text", "uuid", "character varying"], Int: ["integer"], Boolean: ["boolean"], Json: ["jsonb"],
  Decimal: ["numeric"], DateTime: ["timestamp with time zone", "date", "timestamp without time zone"],
};

export async function driftCheck(databaseUrl: string): Promise<string[]> {
  const dmmf = await getDMMF({ datamodel: readFileSync(join(__dirname, "..", "..", "..", "database", "prisma", "schema.prisma"), "utf8") });
  const c = new Client(pgConnectionConfig(databaseUrl));
  await c.connect();
  const cols = (await c.query(`SELECT table_name, column_name, data_type, udt_name, is_nullable, numeric_precision, numeric_scale
    FROM information_schema.columns WHERE table_schema='public'`)).rows;
  const fks = new Set((await c.query(`SELECT tc.table_name || '.' || kcu.column_name AS k FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`)).rows.map((r) => r.k));
  await c.end();
  const problems: string[] = [];
  const byKey = new Map(cols.map((r) => [`${r.table_name}.${r.column_name}`, r]));
  for (const m of dmmf.datamodel.models as any[]) {
    const t = m.dbName ?? m.name;
    for (const f of m.fields as any[]) {
      if (f.kind === "object") continue;
      const col = byKey.get(`${t}.${f.dbName ?? f.name}`);
      if (!col) { problems.push(`missing column ${t}.${f.name}`); continue; }
      if (f.kind === "enum") { if (col.udt_name !== f.type && col.udt_name !== `_${f.type}`) problems.push(`${t}.${f.name}: expected enum ${f.type}, got ${col.udt_name}`); }
      else if (f.isList) { if (col.data_type !== "ARRAY") problems.push(`${t}.${f.name}: expected array`); }
      else if (!TYPE_MAP[f.type]?.includes(col.data_type)) problems.push(`${t}.${f.name}: type ${f.type} vs ${col.data_type}`);
      if (f.type === "Decimal" && f.nativeType) {
        const [p, s] = f.nativeType[1].map(Number);
        if (col.numeric_precision !== p || col.numeric_scale !== s) problems.push(`${t}.${f.name}: decimal(${p},${s}) vs (${col.numeric_precision},${col.numeric_scale})`);
      }
      const nullable = col.is_nullable === "YES";
      if (nullable === (f.isRequired || f.isList)) problems.push(`${t}.${f.name}: nullability mismatch`);
      if (/_id$/.test(f.name) && !f.isId && !["source_id","source_line_id","subject_id","entity_id","owner_id","tax_id","event_id","external_id"].includes(f.name) && !fks.has(`${t}.${f.name}`))
        problems.push(`${t}.${f.name}: no foreign key constraint`);
    }
  }
  return problems;
}

if (require.main === module) {
  driftCheck(resolveDatabaseUrl()!).then((p) => {
    if (p.length) { console.error(`Schema drift detected (${p.length}):\n` + p.join("\n")); process.exit(1); }
    console.log("No drift: database matches database/prisma/schema.prisma");
  }).catch((e) => { console.error(e); process.exit(1); });
}
