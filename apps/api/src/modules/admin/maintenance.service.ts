import { Injectable } from "@nestjs/common";
import { verify } from "@node-rs/argon2";
import { AuthContext, assertCan } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { invalid } from "../../common/errors";
import { PrismaService } from "../../common/prisma.service";

/** Tables never written to a backup: secrets, live sessions, request de-duplication and the migration log. */
const BACKUP_SKIP = new Set(["_prisma_migrations", "system_secrets", "user_sessions", "idempotency_records"]);

/** Everything produced by trading: documents, ledgers, balances, sessions, approvals, queues. */
export const TRANSACTION_TABLES = [
  "sale_line_taxes", "sale_payment_allocations", "payment_attempts", "payment_provider_events", "refunds", "sales_return_lines", "sales_returns", "payments", "sale_lines", "sales", "held_carts",
  "stock_reservations", "stock_movements", "stock_balances", "inventory_cost_pools", "stock_adjustment_lines", "stock_adjustments", "stock_count_lines", "stock_counts", "stock_transfer_lines", "stock_transfers",
  "serial_numbers", "batches",
  "invoice_receipt_matches", "supplier_invoice_lines", "supplier_invoices", "supplier_payment_allocations", "supplier_payments", "goods_receipt_lines", "goods_receipts", "purchase_order_lines", "purchase_orders",
  "purchase_return_lines", "purchase_returns", "supplier_credit_notes", "landed_cost_allocations", "landed_cost_documents",
  "expense_lines", "expenses", "cash_counts", "cash_movements", "cashier_sessions", "funds_transfers", "settlement_lines", "settlements", "reconciliation_lines", "reconciliations",
  "journal_lines", "journal_entries", "approval_actions", "approval_requests", "notifications", "outbox_events", "background_jobs", "webhook_inbox", "idempotency_records",
];
/** Catalogue and contacts, removed only when clearing everything. */
export const MASTER_TABLES = [
  "promotion_rules", "promotions", "bundle_components", "price_list_items", "price_lists", "variant_attribute_values", "variant_unit_conversions", "barcodes", "product_variants", "products",
  "attribute_values", "attributes", "categories", "brands", "departments", "customers", "customer_groups", "suppliers", "attachments",
];

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

@Injectable()
export class MaintenanceService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private async confirmOwner(auth: AuthContext, password: string) {
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: auth.userId } });
    // 400, not 401: a wrong confirmation password must not look like an expired session (which signs the user out)
    if (!password || !(await verify(user.password_hash, password))) throw invalid("WRONG_PASSWORD", "Your password is incorrect");
  }

  // ------------------------------------------------------------------ backup
  /**
   * Full backup as a plain SQL script of INSERT statements, in foreign-key
   * order. Restore it into a NEW, EMPTY database on which `pnpm db:migrate`
   * has been run with the same application version:
   *   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backup.sql
   * Cycles (self-references, reversal links, voided sales) are restored by
   * follow-up UPDATEs, and closed fiscal periods are closed again at the end,
   * so no superuser rights are needed.
   */
  async *backup(auth: AuthContext): AsyncGenerator<string> {
    assertCan(auth, "admin.backup");
    const db = this.prisma.client;
    const tables = (await db.$queryRawUnsafe<{ t: string }[]>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t).filter((t) => !BACKUP_SKIP.has(t));
    const fks = await db.$queryRawUnsafe<{ child: string; col: string; parent: string; notnull: boolean }[]>(`
      SELECT c.conrelid::regclass::text AS child, a.attname AS col, c.confrelid::regclass::text AS parent, a.attnotnull AS notnull
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`);
    const strip = (t: string) => t.replace(/^public\./, "").replace(/"/g, "");
    // Order tables by their required (NOT NULL) foreign keys; an optional foreign key that points to a
    // table restored later (or to its own table) becomes a "deferred" column: inserted NULL, set afterwards.
    const hard = new Map<string, string[]>(tables.map((t) => [t, []]));
    const soft: { child: string; col: string; parent: string }[] = [];
    for (const f of fks) {
      const c = strip(f.child), p = strip(f.parent);
      if (!hard.has(c) || !hard.has(p)) continue;
      if (f.notnull && c !== p) hard.get(c)!.push(p); else soft.push({ child: c, col: f.col, parent: p });
    }
    // tables each table needs first through required keys (transitively)
    const reach = new Map<string, Set<string>>();
    const reachOf = (t: string): Set<string> => {
      if (reach.has(t)) return reach.get(t)!;
      const r = new Set<string>(); reach.set(t, r);
      for (const p of hard.get(t)!) { r.add(p); for (const x of reachOf(p)) r.add(x); }
      return r;
    };
    const softOf = new Map<string, { col: string; parent: string }[]>(tables.map((t) => [t, []]));
    for (const e of soft) softOf.get(e.child)!.push(e);
    const order: string[] = []; const state = new Map<string, number>(); const deferred = new Map<string, Set<string>>();
    const defer = (t: string, col: string) => (deferred.get(t) ?? deferred.set(t, new Set()).get(t)!).add(col);
    const visit = (t: string) => {
      state.set(t, 1);
      for (const p of hard.get(t)!) {
        if (state.get(p) === 1) throw new Error(`Required foreign keys form a cycle at ${t} → ${p}`);
        if (!state.get(p)) visit(p);
      }
      for (const e of softOf.get(t)!) {
        // follow an optional link unless it would loop back (self-reference, or the parent needs this table first)
        if (e.parent === t || state.get(e.parent) === 1 || reachOf(e.parent).has(t)) { if (state.get(e.parent) !== 2) defer(t, e.col); continue; }
        if (!state.get(e.parent)) visit(e.parent);
      }
      state.set(t, 2); order.push(t);
    };
    for (const t of tables) if (!state.get(t)) visit(t);
    // append-only tables cannot be fixed up with UPDATEs afterwards
    for (const t of ["journal_lines", "stock_movements", "audit_events", "approval_actions"]) if (deferred.get(t)?.size) throw new Error(`Backup ordering problem: ${t}.${[...deferred.get(t)!].join(",")} would need a later update`);
    const migrations = await db.$queryRawUnsafe<{ migration_name: string }[]>(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`);
    const business = await db.business.findUnique({ where: { id: auth.businessId }, select: { name: true } });

    yield `-- Retail Suite backup of "${business?.name ?? ""}" — ${new Date().toISOString()}\n`;
    yield `-- Schema version (last migration): ${migrations.at(-1)?.migration_name ?? "?"}\n`;
    yield `-- CONTAINS PERSONAL DATA AND PASSWORD HASHES: store it privately.\n`;
    yield `-- Restore: create a NEW empty database, run "pnpm db:migrate" with the same application version, then\n--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f this-file.sql\n`;
    yield `-- After restoring, users sign in again (sessions and the signing secret are not part of the backup).\n\n`;
    yield `BEGIN;\nDO $$ BEGIN IF EXISTS (SELECT 1 FROM businesses) THEN RAISE EXCEPTION 'Restore only into an empty, freshly migrated database'; END IF; END $$;\n`;
    yield `-- the migrations seed the permission catalogue; replace it with the backed-up rows (ids must match role grants)\nDELETE FROM role_permissions; DELETE FROM permissions;\n\n`;

    const updates: string[] = [];
    for (const t of order) {
      const cols = (await db.$queryRawUnsafe<{ c: string; nullable: string }[]>(`SELECT column_name AS c, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, t));
      const defCols = deferred.get(t) ?? new Set<string>();
      const special = t === "journal_entries" ? "journal" : t === "fiscal_periods" ? "periods" : null;
      if (special === "journal") {
        // a reversal is always created after the entry it reverses: rows go in creation order, so the
        // back-reference is inserted directly; only the forward link (reversed_by_id) is set afterwards
        defCols.delete("reversal_of_id");
        defCols.add("reversed_by_id");
      }
      const hasId = cols.some((c) => c.c === "id");
      const exprs = cols.map((c) => {
        if (defCols.has(c.c)) return `'NULL'`;
        if (special === "journal" && c.c === "status") return `quote_nullable(CASE WHEN "reversed_by_id" IS NOT NULL THEN 'POSTED' ELSE "status"::text END)`;
        if (special === "periods" && c.c === "status") return `quote_nullable('OPEN')`;
        return `quote_nullable(${q(c.c)}::text)`;
      });
      const count = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${q(t)}`))[0].n);
      if (!count) continue;
      yield `-- ${t}: ${count} row(s)\n`;
      const orderBy = cols.some((c) => c.c === "created_at") ? `ORDER BY "created_at"${hasId ? `, "id"` : ""}` : hasId ? `ORDER BY "id"` : "";
      for (let off = 0; off < count; off += 500) {
        const rows = await db.$queryRawUnsafe<{ v: string }[]>(`SELECT '(' || concat_ws(',', ${exprs.join(", ")}) || ')' AS v FROM ${q(t)} ${orderBy} LIMIT 500 OFFSET ${off}`);
        yield `INSERT INTO ${q(t)} (${cols.map((c) => q(c.c)).join(", ")}) VALUES\n${rows.map((r) => r.v).join(",\n")};\n`;
      }
      if (hasId && (defCols.size || special)) {
        const set = [...defCols].map((c) => special === "journal" && c === "reversed_by_id" ? `"status" = %L::"DocumentStatus", "reversed_by_id" = %L::uuid` : `${q(c)} = %L`);
        const args = [...defCols].map((c) => special === "journal" && c === "reversed_by_id" ? `"status"::text, "reversed_by_id"::text` : `${q(c)}::text`);
        if (special === "periods") { set.push(`"status" = %L::"PeriodStatus"`); args.push(`"status"::text`); }
        const where = special === "journal" ? `WHERE "reversed_by_id" IS NOT NULL` : special === "periods" ? `WHERE "status"::text <> 'OPEN'` : `WHERE ${[...defCols].map((c) => `${q(c)} IS NOT NULL`).join(" OR ")}`;
        if (set.length) {
          const rows = await db.$queryRawUnsafe<{ v: string }[]>(`SELECT format('UPDATE ${q(t).replace(/%/g, "%%")} SET ${set.join(", ")} WHERE "id" = %L;', ${[...args, `"id"::text`].join(", ")}) AS v FROM ${q(t)} ${where}`);
          updates.push(...rows.map((r) => r.v));
        }
      }
    }
    if (updates.length) yield `\n-- links restored after all rows exist (reversals, self-references, voided sales) and closed periods\n${updates.filter((u) => !u.startsWith('UPDATE "fiscal_periods"')).join("\n")}\n${updates.filter((u) => u.startsWith('UPDATE "fiscal_periods"')).join("\n")}\n`;
    yield `COMMIT;\n`;
    await this.audit.record(auth, { action: "backup.downloaded", entityType: "business", entityId: auth.businessId, summary: "Full backup downloaded" });
  }

  // --------------------------------------------------------- audit retention
  /** Audit entries can only be purged once they are at least this many months old (also enforced by the database). */
  static readonly AUDIT_MIN_MONTHS = 6;

  private auditCutoff(months: number) {
    if (!Number.isInteger(months) || months < MaintenanceService.AUDIT_MIN_MONTHS) throw invalid("RETENTION_TOO_SHORT", `Audit entries must be kept for at least ${MaintenanceService.AUDIT_MIN_MONTHS} months`);
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - months);
    return d;
  }

  /** How many entries a purge would delete. */
  async auditPurgePreview(auth: AuthContext, months: number) {
    assertCan(auth, "admin.audit_purge");
    const cutoff = this.auditCutoff(months);
    const where = { business_id: auth.businessId, created_at: { lt: cutoff } };
    const [count, oldest] = await Promise.all([this.prisma.client.auditEvent.count({ where }), this.prisma.client.auditEvent.findFirst({ where, orderBy: { created_at: "asc" }, select: { created_at: true } })]);
    return { months, cutoff: cutoff.toISOString(), count, oldest: oldest?.created_at ?? null };
  }

  /** The entries a purge would delete, as rows for a CSV download (kept by the business before purging). */
  async auditPurgeRows(auth: AuthContext, months: number) {
    assertCan(auth, "admin.audit_purge");
    const cutoff = this.auditCutoff(months);
    const rows = await this.prisma.client.auditEvent.findMany({ where: { business_id: auth.businessId, created_at: { lt: cutoff } }, orderBy: { created_at: "asc" } });
    const users = await this.prisma.client.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actor_id).filter(Boolean) as string[])] } }, select: { id: true, full_name: true } });
    return rows.map((r) => ({ when: r.created_at.toISOString(), user: users.find((u) => u.id === r.actor_id)?.full_name ?? "", action: r.action, entity: r.entity_type, entity_id: r.entity_id ?? "", summary: r.summary, ip: r.ip_address ?? "", data: JSON.stringify(r.data) }));
  }

  /**
   * Deletes this business's audit entries older than `months` (at least 6).
   * The database trigger independently refuses to delete anything newer than
   * 6 months. The purge itself is recorded as a new audit entry.
   */
  async purgeAudit(auth: AuthContext, input: { months: number; password: string }) {
    assertCan(auth, "admin.audit_purge");
    await this.confirmOwner(auth, input.password);
    const cutoff = this.auditCutoff(input.months);
    const deleted = await this.prisma.tx(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.audit_purge', 'on', true)`);
      const n = await tx.$executeRaw`DELETE FROM audit_events WHERE business_id = ${auth.businessId}::uuid AND created_at < ${cutoff}`;
      await tx.$executeRawUnsafe(`SELECT set_config('app.audit_purge', 'off', true)`);
      await this.audit.record(auth, { action: "audit.purged", entityType: "business", entityId: auth.businessId, summary: `${n} audit entries older than ${input.months} months (before ${cutoff.toISOString().slice(0, 10)}) deleted`, data: { months: input.months, cutoff: cutoff.toISOString(), deleted: n } }, tx);
      return n;
    }, { timeout: 120_000 });
    return { deleted, cutoff: cutoff.toISOString() };
  }

  // ------------------------------------------------------------------- clear
  /**
   * Clears the application for a fresh start.
   *  - "transactions": sales, purchases, stock, payments, expenses, sessions, journals, approvals
   *    (products, customers, suppliers, users, branches, chart of accounts and settings stay).
   *  - "everything": also products, categories, brands, customers and suppliers.
   * Users, roles, branches, registers, the chart of accounts, financial accounts,
   * tax rates, units and settings are always kept, as is the audit log.
   * Requires admin.reset, the user's password and the exact business name.
   */
  async clear(auth: AuthContext, input: { mode: "transactions" | "everything"; confirm_name: string; password: string }, internal: { allowSeveralBusinesses?: boolean } = {}) {
    assertCan(auth, "admin.reset");
    await this.confirmOwner(auth, input.password);
    const db = this.prisma.client;
    const business = await db.business.findUniqueOrThrow({ where: { id: auth.businessId } });
    if (input.confirm_name.trim() !== business.name.trim()) throw invalid("CONFIRMATION_MISMATCH", `Type the business name exactly ("${business.name}") to confirm`);
    if (!internal.allowSeveralBusinesses && (await db.business.count()) > 1) throw invalid("MULTI_BUSINESS", "This database holds several businesses; clearing is only available for a single-business installation");
    const tables = input.mode === "everything" ? [...TRANSACTION_TABLES, ...MASTER_TABLES] : TRANSACTION_TABLES;
    const existing = new Set((await db.$queryRawUnsafe<{ t: string }[]>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`)).map((r) => r.t));
    const list = tables.filter((t) => existing.has(t));
    await this.prisma.tx(async (tx) => {
      // TRUNCATE (not DELETE) so the append-only ledger triggers stay in force for normal operation;
      // all related tables are listed in one statement, so nothing outside the list can be cascaded.
      await tx.$executeRawUnsafe(`TRUNCATE ${list.map(q).join(", ")}`);
      // document numbers restart (customer / supplier codes keep counting unless everything is cleared)
      if (input.mode === "everything") await tx.documentSequence.deleteMany({ where: { business_id: auth.businessId } });
      else await tx.documentSequence.deleteMany({ where: { business_id: auth.businessId, scope: { notIn: ["CUSTOMER", "SUPPLIER"] } } });
      await this.audit.record(auth, { action: "application.cleared", entityType: "business", entityId: auth.businessId, summary: input.mode === "everything" ? "Application cleared: all transactions, products, customers and suppliers deleted" : "Application cleared: all transactions deleted", data: { mode: input.mode, tables: list.length } }, tx);
    }, { timeout: 120_000 });
    return { cleared: input.mode, tables: list.length };
  }
}
