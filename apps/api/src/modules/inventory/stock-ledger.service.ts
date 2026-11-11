import { Injectable } from "@nestjs/common";
import type { MovementType, Tx } from "@retail/db";
import { D, Dec, money, unitCost, ZERO } from "../../common/money";
import { invalid } from "../../common/errors";

/**
 * The stock ledger: the only code allowed to change stock_balances and
 * inventory_cost_pools. Every change writes an append-only stock_movement.
 *
 * Costing policy: weighted average per (variant, branch). Inventory value is
 * carried at currency precision. An issue takes value = pool.value × q / pool.qty
 * (rounded), and the last unit out takes the exact remaining value, so pool
 * values always sum to the inventory control account without residue.
 *
 * Concurrency: the cost pool row is locked FOR UPDATE before the balance row is
 * conditionally decremented (`qty_on_hand - qty_reserved >= q`). Callers lock
 * variants in ascending id order to avoid deadlocks. Two cashiers selling the
 * last unit therefore serialise; the second sees insufficient stock.
 *
 * Backdating policy: movements always post at the current time. Document dates
 * (e.g. a supplier's delivery date) are informational and never re-value history.
 */
export interface MovementBase {
  businessId: string;
  branchId: string;
  locationId: string;
  variantId: string;
  quantity: Dec; // base units, positive
  movementType: MovementType;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  documentNumber?: string | null;
  reason?: string | null;
  batchId?: string | null;
  serialNumberId?: string | null;
  userId: string;
  currencyDecimals: number;
}
export interface StockInInput extends MovementBase { value: Dec }
export interface StockOutInput extends MovementBase { requireSellable?: boolean; fromReservation?: boolean }
export interface MovementResult { value: Dec; unitCost: Dec; movementId: string }

interface PoolRow { id: string; quantity: Dec; value: Dec }

@Injectable()
export class StockLedgerService {
  private async lockPool(tx: Tx, businessId: string, branchId: string, variantId: string): Promise<PoolRow> {
    await tx.$executeRaw`INSERT INTO inventory_cost_pools (id, business_id, branch_id, variant_id, quantity, value, average_cost, updated_at)
      VALUES (gen_random_uuid(), ${businessId}::uuid, ${branchId}::uuid, ${variantId}::uuid, 0, 0, 0, now())
      ON CONFLICT (variant_id, branch_id) DO NOTHING`;
    const rows = await tx.$queryRaw<PoolRow[]>`SELECT id, quantity, value FROM inventory_cost_pools
      WHERE variant_id = ${variantId}::uuid AND branch_id = ${branchId}::uuid FOR UPDATE`;
    return { id: rows[0].id, quantity: D(rows[0].quantity), value: D(rows[0].value) };
  }

  private async writePool(tx: Tx, poolId: string, quantity: Dec, value: Dec) {
    const avg = quantity.gt(0) ? unitCost(value.div(quantity)) : ZERO;
    await tx.$executeRaw`UPDATE inventory_cost_pools SET quantity = ${quantity.toString()}::numeric, value = ${value.toString()}::numeric,
      average_cost = ${avg.toString()}::numeric, last_movement_at = now(), updated_at = now() WHERE id = ${poolId}::uuid`;
  }

  private async insertMovement(tx: Tx, m: MovementBase, signedQty: Dec, signedValue: Dec, cost: Dec, poolQty: Dec, poolValue: Dec, journalId?: string | null) {
    const mv = await tx.stockMovement.create({
      data: {
        business_id: m.businessId, branch_id: m.branchId, location_id: m.locationId, variant_id: m.variantId,
        batch_id: m.batchId ?? null, serial_number_id: m.serialNumberId ?? null, movement_type: m.movementType,
        quantity: signedQty, unit_cost: cost, value: signedValue, pool_qty_after: poolQty, pool_value_after: poolValue,
        source_type: m.sourceType, source_id: m.sourceId, source_line_id: m.sourceLineId ?? null,
        document_number: m.documentNumber ?? null, reason: m.reason ?? null, journal_entry_id: journalId ?? null, created_by_id: m.userId,
      },
    });
    return mv.id;
  }

  /** Adds stock and value to the branch cost pool. */
  async stockIn(tx: Tx, input: StockInInput): Promise<MovementResult> {
    if (!input.quantity.gt(0)) throw invalid("INVALID_QUANTITY", "Quantity must be positive");
    const value = money(input.value, input.currencyDecimals);
    if (value.lt(0)) throw invalid("INVALID_VALUE", "Stock value cannot be negative");
    const pool = await this.lockPool(tx, input.businessId, input.branchId, input.variantId);
    const newQty = pool.quantity.plus(input.quantity);
    const newVal = pool.value.plus(value);
    await this.writePool(tx, pool.id, newQty, newVal);
    await tx.$executeRaw`INSERT INTO stock_balances (id, business_id, branch_id, location_id, variant_id, batch_id, qty_on_hand, qty_reserved, updated_at)
      VALUES (gen_random_uuid(), ${input.businessId}::uuid, ${input.branchId}::uuid, ${input.locationId}::uuid, ${input.variantId}::uuid,
              ${input.batchId ?? null}::uuid, ${input.quantity.toString()}::numeric, 0, now())
      ON CONFLICT (location_id, variant_id, batch_id) DO UPDATE SET qty_on_hand = stock_balances.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now()`;
    const cost = unitCost(value.div(input.quantity));
    const movementId = await this.insertMovement(tx, input, input.quantity, value, cost, newQty, newVal);
    return { value, unitCost: cost, movementId };
  }

  /** Removes stock at weighted-average cost. Fails (never goes negative) if unavailable. */
  async stockOut(tx: Tx, input: StockOutInput): Promise<MovementResult> {
    if (!input.quantity.gt(0)) throw invalid("INVALID_QUANTITY", "Quantity must be positive");
    if (input.requireSellable) {
      const loc = await tx.location.findUnique({ where: { id: input.locationId } });
      if (!loc?.is_sellable) throw invalid("LOCATION_NOT_SELLABLE", "Stock in quarantine or damaged locations cannot be sold");
    }
    const pool = await this.lockPool(tx, input.businessId, input.branchId, input.variantId);
    const q = input.quantity.toString();
    const updated = input.fromReservation
      ? await tx.$queryRaw<{ id: string }[]>`UPDATE stock_balances SET qty_on_hand = qty_on_hand - ${q}::numeric, qty_reserved = qty_reserved - ${q}::numeric, updated_at = now()
          WHERE location_id = ${input.locationId}::uuid AND variant_id = ${input.variantId}::uuid
            AND batch_id IS NOT DISTINCT FROM ${input.batchId ?? null}::uuid
            AND qty_reserved >= ${q}::numeric AND qty_on_hand >= ${q}::numeric
          RETURNING id`
      : await tx.$queryRaw<{ id: string }[]>`UPDATE stock_balances SET qty_on_hand = qty_on_hand - ${q}::numeric, updated_at = now()
          WHERE location_id = ${input.locationId}::uuid AND variant_id = ${input.variantId}::uuid
            AND batch_id IS NOT DISTINCT FROM ${input.batchId ?? null}::uuid
            AND qty_on_hand - qty_reserved >= ${q}::numeric
          RETURNING id`;
    if (updated.length === 0 || pool.quantity.lessThan(input.quantity)) {
      const avail = await this.available(tx, input.locationId, input.variantId, input.batchId ?? null);
      throw invalid("INSUFFICIENT_STOCK", `Insufficient stock: requested ${input.quantity}, available ${avail}`, {
        variantId: input.variantId, locationId: input.locationId, requested: input.quantity.toString(), available: avail.toString(),
      });
    }
    const value = pool.quantity.equals(input.quantity) ? pool.value : money(pool.value.times(input.quantity).div(pool.quantity), input.currencyDecimals);
    const newQty = pool.quantity.minus(input.quantity);
    const newVal = newQty.isZero() ? ZERO : pool.value.minus(value);
    await this.writePool(tx, pool.id, newQty, newVal);
    const cost = unitCost(value.div(input.quantity));
    const movementId = await this.insertMovement(tx, input, input.quantity.neg(), value.neg(), cost, newQty, newVal);
    return { value, unitCost: cost, movementId };
  }

  /**
   * Moves stock between two locations of the same branch (e.g. into
   * quarantine). Value stays in the branch pool, so no journal is needed.
   */
  async relocate(tx: Tx, input: MovementBase & { toLocationId: string; toBatchId?: string | null }) {
    const q = input.quantity.toString();
    const updated = await tx.$queryRaw<{ id: string }[]>`UPDATE stock_balances SET qty_on_hand = qty_on_hand - ${q}::numeric, updated_at = now()
      WHERE location_id = ${input.locationId}::uuid AND variant_id = ${input.variantId}::uuid
        AND batch_id IS NOT DISTINCT FROM ${input.batchId ?? null}::uuid AND qty_on_hand - qty_reserved >= ${q}::numeric RETURNING id`;
    if (!updated.length) throw invalid("INSUFFICIENT_STOCK", "Insufficient stock to relocate");
    await tx.$executeRaw`INSERT INTO stock_balances (id, business_id, branch_id, location_id, variant_id, batch_id, qty_on_hand, qty_reserved, updated_at)
      VALUES (gen_random_uuid(), ${input.businessId}::uuid, ${input.branchId}::uuid, ${input.toLocationId}::uuid, ${input.variantId}::uuid,
              ${input.toBatchId ?? input.batchId ?? null}::uuid, ${q}::numeric, 0, now())
      ON CONFLICT (location_id, variant_id, batch_id) DO UPDATE SET qty_on_hand = stock_balances.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now()`;
    const pool = await this.lockPool(tx, input.businessId, input.branchId, input.variantId);
    await this.insertMovement(tx, input, input.quantity.neg(), ZERO, ZERO, pool.quantity, pool.value);
    await this.insertMovement(tx, { ...input, locationId: input.toLocationId, batchId: input.toBatchId ?? input.batchId }, input.quantity, ZERO, ZERO, pool.quantity, pool.value);
  }

  async available(tx: Tx, locationId: string, variantId: string, batchId: string | null | undefined): Promise<Dec> {
    const rows = await tx.$queryRaw<{ a: Dec | null }[]>`SELECT SUM(qty_on_hand - qty_reserved) AS a FROM stock_balances
      WHERE location_id = ${locationId}::uuid AND variant_id = ${variantId}::uuid
        AND (${batchId ?? null}::uuid IS NULL OR batch_id = ${batchId ?? null}::uuid)`;
    return D(rows[0]?.a ?? 0);
  }

  /**
   * Plans a FEFO (first-expiry-first-out) pick across batches at a location.
   * Physical picking only — valuation still uses the branch average cost.
   * Expired batches are excluded from sale.
   */
  async planFefo(tx: Tx, locationId: string, variantId: string, quantity: Dec, today: string): Promise<{ batchId: string | null; quantity: Dec }[]> {
    const rows = await tx.$queryRaw<{ batch_id: string | null; avail: Dec; expiry_date: Date | null }[]>`
      SELECT sb.batch_id, (sb.qty_on_hand - sb.qty_reserved) AS avail, b.expiry_date FROM stock_balances sb
      LEFT JOIN batches b ON b.id = sb.batch_id
      WHERE sb.location_id = ${locationId}::uuid AND sb.variant_id = ${variantId}::uuid AND sb.qty_on_hand - sb.qty_reserved > 0
        AND (b.expiry_date IS NULL OR b.expiry_date >= ${today}::date)
      ORDER BY b.expiry_date ASC NULLS LAST, b.received_at ASC NULLS LAST`;
    const plan: { batchId: string | null; quantity: Dec }[] = [];
    let remaining = quantity;
    for (const r of rows) {
      if (remaining.lte(0)) break;
      const take = D(r.avail).lessThan(remaining) ? D(r.avail) : remaining;
      plan.push({ batchId: r.batch_id, quantity: take });
      remaining = remaining.minus(take);
    }
    if (remaining.gt(0)) {
      const total = rows.reduce((a, r) => a.plus(D(r.avail)), ZERO);
      throw invalid("INSUFFICIENT_STOCK", `Insufficient unexpired stock: requested ${quantity}, available ${total}`, { variantId, available: total.toString() });
    }
    return plan;
  }

  /** Reserves available stock for a document (e.g. a sale awaiting electronic payment). */
  async reserve(tx: Tx, r: { businessId: string; locationId: string; variantId: string; batchId?: string | null; quantity: Dec; sourceType: string; sourceId: string; expiresAt?: Date }) {
    const q = r.quantity.toString();
    const updated = await tx.$queryRaw<{ id: string }[]>`UPDATE stock_balances SET qty_reserved = qty_reserved + ${q}::numeric, updated_at = now()
      WHERE location_id = ${r.locationId}::uuid AND variant_id = ${r.variantId}::uuid AND batch_id IS NOT DISTINCT FROM ${r.batchId ?? null}::uuid
        AND qty_on_hand - qty_reserved >= ${q}::numeric RETURNING id`;
    if (!updated.length) {
      const avail = await this.available(tx, r.locationId, r.variantId, r.batchId ?? null);
      throw invalid("INSUFFICIENT_STOCK", `Insufficient stock: requested ${r.quantity}, available ${avail}`, { variantId: r.variantId, available: avail.toString() });
    }
    return tx.stockReservation.create({
      data: { business_id: r.businessId, location_id: r.locationId, variant_id: r.variantId, batch_id: r.batchId ?? null, quantity: r.quantity, source_type: r.sourceType, source_id: r.sourceId, expires_at: r.expiresAt ?? null },
    });
  }

  /** Releases all open reservations of a document (cancel/expiry). */
  async releaseReservations(tx: Tx, sourceType: string, sourceId: string) {
    const rows = await tx.stockReservation.findMany({ where: { source_type: sourceType, source_id: sourceId, released_at: null } });
    for (const r of rows) {
      const batchId = r.batch_id ?? null;
      await tx.$executeRaw`UPDATE stock_balances SET qty_reserved = GREATEST(qty_reserved - ${r.quantity.toString()}::numeric, 0), updated_at = now()
        WHERE location_id = ${r.location_id}::uuid AND variant_id = ${r.variant_id}::uuid AND batch_id IS NOT DISTINCT FROM ${batchId}::uuid`;
      await tx.stockReservation.update({ where: { id: r.id }, data: { released_at: new Date() } });
    }
    return rows.length;
  }
}
