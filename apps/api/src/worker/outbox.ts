import { Logger } from "@nestjs/common";
import type { PrismaService } from "../common/prisma.service";
import type { PaymentAdapterRegistry } from "../modules/sales/payment-adapters";

const log = new Logger("Outbox");
const MAX_ATTEMPTS = 8;

/** Claims and processes a batch of outbox events. Returns the number processed. */
export async function processOutboxBatch(prisma: PrismaService, adapters: PaymentAdapterRegistry, batch = 20): Promise<number> {
  const claimed = await prisma.client.$queryRaw<{ id: string; topic: string; payload: any; attempts: number; business_id: string | null }[]>`
    UPDATE outbox_events SET status = 'PROCESSING', locked_at = now(), attempts = attempts + 1
    WHERE id IN (SELECT id FROM outbox_events WHERE status = 'PENDING' AND available_at <= now() ORDER BY created_at LIMIT ${batch} FOR UPDATE SKIP LOCKED)
    RETURNING id, topic, payload, attempts, business_id`;
  for (const ev of claimed) {
    try {
      await handle(prisma, adapters, ev);
      await prisma.client.outboxEvent.update({ where: { id: ev.id }, data: { status: "DONE", processed_at: new Date(), last_error: null } });
    } catch (e) {
      const failed = ev.attempts >= MAX_ATTEMPTS;
      await prisma.client.outboxEvent.update({ where: { id: ev.id }, data: { status: failed ? "FAILED" : "PENDING", last_error: (e as Error).message.slice(0, 500), available_at: new Date(Date.now() + Math.min(2 ** ev.attempts, 300) * 1000) } });
      log.warn(`event ${ev.topic} ${ev.id} failed (attempt ${ev.attempts}): ${(e as Error).message}`);
    }
  }
  // recover events stuck in PROCESSING (crashed worker)
  await prisma.client.$executeRaw`UPDATE outbox_events SET status = 'PENDING' WHERE status = 'PROCESSING' AND locked_at < now() - interval '5 minutes'`;
  return claimed.length;
}

async function handle(prisma: PrismaService, adapters: PaymentAdapterRegistry, ev: { topic: string; payload: any; business_id: string | null }) {
  switch (ev.topic) {
    case "payment.initiate": {
      const attempt = await prisma.client.paymentAttempt.findUnique({ where: { request_reference: ev.payload.request_reference } });
      if (!attempt || attempt.status !== "PENDING") return;
      const adapter = adapters.get(attempt.provider);
      const r = await adapter.initiate({ requestReference: attempt.request_reference, amount: ev.payload.amount, currency: ev.payload.currency, payerPhone: ev.payload.payer_phone });
      await prisma.client.paymentAttempt.update({ where: { id: attempt.id }, data: { external_reference: r.externalReference, last_checked_at: new Date() } });
      return;
    }
    case "sale.completed": {
      // Low-stock alerts (de-duplicated per variant/branch/day).
      const rows = await prisma.client.$queryRaw<{ variant_id: string; sku: string; name: string; available: string; reorder_point: string }[]>`
        SELECT v.id AS variant_id, v.sku, v.name, COALESCE(SUM(sb.qty_on_hand - sb.qty_reserved), 0)::text AS available, v.reorder_point::text
        FROM product_variants v LEFT JOIN stock_balances sb ON sb.variant_id = v.id AND sb.branch_id = ${ev.payload.branch_id}::uuid
          AND sb.location_id IN (SELECT id FROM locations WHERE is_sellable)
        WHERE v.id = ANY(${ev.payload.variant_ids}::uuid[]) AND v.reorder_point > 0
        GROUP BY v.id HAVING COALESCE(SUM(sb.qty_on_hand - sb.qty_reserved), 0) <= v.reorder_point`;
      const day = new Date().toISOString().slice(0, 10);
      for (const r of rows) {
        await prisma.client.notification.upsert({
          where: { business_id_dedupe_key: { business_id: ev.business_id!, dedupe_key: `low:${ev.payload.branch_id}:${r.variant_id}:${day}` } },
          create: { business_id: ev.business_id!, branch_id: ev.payload.branch_id, kind: "LOW_STOCK", title: `Low stock: ${r.sku}`, body: `${r.name} has ${r.available} available (reorder point ${r.reorder_point}).`, link: `/inventory?search=${encodeURIComponent(r.sku)}`, dedupe_key: `low:${ev.payload.branch_id}:${r.variant_id}:${day}` },
          update: { body: `${r.name} has ${r.available} available (reorder point ${r.reorder_point}).` },
        });
      }
      return;
    }
    default:
      log.warn(`no handler for ${ev.topic}; marking done`);
  }
}
