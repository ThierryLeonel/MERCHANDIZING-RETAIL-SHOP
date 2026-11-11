import { Injectable } from "@nestjs/common";
import type { Tx } from "@retail/db";

/**
 * Gap-free document numbers allocated inside the business transaction
 * (row-locked UPSERT); a rolled-back transaction releases its number.
 */
@Injectable()
export class SequenceService {
  async next(tx: Tx, businessId: string, scope: string, prefix: string, padding = 6): Promise<string> {
    const rows = await tx.$queryRaw<{ value: number; prefix: string; padding: number }[]>`
      INSERT INTO document_sequences (id, business_id, scope, prefix, next_value, padding)
      VALUES (gen_random_uuid(), ${businessId}::uuid, ${scope}, ${prefix}, 2, ${padding})
      ON CONFLICT (business_id, scope) DO UPDATE SET next_value = document_sequences.next_value + 1
      RETURNING next_value - 1 AS value, prefix, padding`;
    const r = rows[0];
    return `${r.prefix}${String(r.value).padStart(r.padding, "0")}`;
  }
}
