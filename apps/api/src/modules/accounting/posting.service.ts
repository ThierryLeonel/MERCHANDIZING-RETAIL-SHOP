import { Injectable } from "@nestjs/common";
import type { Tx } from "@retail/db";
import { D, Dec, DecInput, money, sum, ZERO } from "../../common/money";
import { invalid } from "../../common/errors";
import { SequenceService } from "../../common/sequence.service";
import { dateOnly } from "../../common/settings.service";

/**
 * Posting keys — the configurable posting matrix (posting_rules table).
 * documentation/accounting/posting-matrix.md describes every event.
 */
export const POSTING_KEYS = [
  "inventory", "inventory_in_transit", "grni", "supplier_payable", "supplier_advance", "input_tax",
  "customer_receivable", "customer_deposit", "output_tax", "sales_revenue", "sales_returns",
  "cost_of_sales", "purchase_price_variance", "inventory_gain", "inventory_loss", "inventory_writeoff",
  "cash_over", "cash_short", "payment_fees", "opening_equity", "retained_earnings", "rounding",
] as const;
export type PostingKey = (typeof POSTING_KEYS)[number];

export interface PostingLine {
  account?: PostingKey;
  accountId?: string;
  debit?: DecInput;
  credit?: DecInput;
  memo?: string;
  branchId?: string | null;
  supplierId?: string | null;
  customerId?: string | null;
  financialAccountId?: string | null;
}

export interface PostingInput {
  businessId: string;
  branchId?: string | null;
  entryDate: string; // YYYY-MM-DD business date
  sourceType: string;
  sourceId?: string | null;
  sourceNumber?: string | null;
  description: string;
  lines: PostingLine[];
  createdById: string;
  isManual?: boolean;
  approvalRequestId?: string | null;
  reversalOfId?: string | null;
  currencyDecimals: number;
}

@Injectable()
export class PostingService {
  constructor(private seq: SequenceService) {}

  async accountIdFor(tx: Tx, businessId: string, key: PostingKey): Promise<string> {
    const rule = await tx.postingRule.findUnique({ where: { business_id_key: { business_id: businessId, key } } });
    if (!rule) throw invalid("POSTING_RULE_MISSING", `No account mapped for posting key "${key}". Configure it under Accounting → Posting rules.`);
    return rule.account_id;
  }

  /** Finds (or creates, if absent) the monthly fiscal period; rejects closed periods. */
  async periodFor(tx: Tx, businessId: string, date: string) {
    const d = dateOnly(date);
    let p = await tx.fiscalPeriod.findFirst({ where: { business_id: businessId, start_date: { lte: d }, end_date: { gte: d } } });
    if (!p) {
      const start = `${date.slice(0, 7)}-01`;
      const endD = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0));
      p = await tx.fiscalPeriod.upsert({
        where: { business_id_start_date: { business_id: businessId, start_date: dateOnly(start) } },
        create: { business_id: businessId, name: date.slice(0, 7), start_date: dateOnly(start), end_date: endD },
        update: {},
      });
    }
    if (p.status !== "OPEN") throw invalid("PERIOD_CLOSED", `Fiscal period ${p.name} is closed. Post in an open period or request a reopen.`);
    return p;
  }

  /**
   * Posts a balanced journal. Amounts are rounded to currency precision; zero
   * lines are dropped; the DB re-validates balance and period at commit.
   */
  async post(tx: Tx, input: PostingInput) {
    const dec = input.currencyDecimals;
    const resolved: { accountId: string; debit: Dec; credit: Dec; l: PostingLine }[] = [];
    const cache = new Map<string, string>();
    for (const l of input.lines) {
      const debit = money(l.debit ?? 0, dec);
      const credit = money(l.credit ?? 0, dec);
      if (debit.lt(0) || credit.lt(0)) throw invalid("NEGATIVE_AMOUNT", "Journal amounts must be positive");
      if (debit.isZero() && credit.isZero()) continue;
      let accountId = l.accountId;
      if (!accountId) {
        if (!l.account) throw invalid("ACCOUNT_REQUIRED", "Journal line needs an account");
        accountId = cache.get(l.account) ?? (await this.accountIdFor(tx, input.businessId, l.account));
        cache.set(l.account, accountId);
      }
      // net a line that has both sides
      const net = debit.minus(credit);
      resolved.push({ accountId, debit: net.gt(0) ? net : ZERO, credit: net.lt(0) ? net.neg() : ZERO, l });
    }
    const totalDr = sum(resolved, (r) => r.debit);
    const totalCr = sum(resolved, (r) => r.credit);
    if (!totalDr.equals(totalCr)) {
      throw invalid("UNBALANCED_JOURNAL", `Journal does not balance (Dr ${totalDr} / Cr ${totalCr})`);
    }
    if (totalDr.isZero()) return null; // nothing to post (e.g. zero-value document)
    const accounts = await tx.account.findMany({ where: { id: { in: [...new Set(resolved.map((r) => r.accountId))] } } });
    for (const a of accounts) {
      if (!a.is_postable || !a.active) throw invalid("ACCOUNT_NOT_POSTABLE", `Account ${a.code} ${a.name} cannot be posted to`);
      if (input.isManual && !a.allow_manual) throw invalid("ACCOUNT_CONTROL", `Account ${a.code} is a control account; use the source module instead of a manual journal`);
    }
    const period = await this.periodFor(tx, input.businessId, input.entryDate);
    const number = await this.seq.next(tx, input.businessId, "JOURNAL", "JE-");
    return tx.journalEntry.create({
      data: {
        business_id: input.businessId,
        branch_id: input.branchId ?? null,
        number,
        entry_date: dateOnly(input.entryDate),
        fiscal_period_id: period.id,
        source_type: input.sourceType,
        source_id: input.sourceId ?? null,
        source_number: input.sourceNumber ?? null,
        description: input.description,
        is_manual: input.isManual ?? false,
        total_debit: totalDr,
        total_credit: totalCr,
        reversal_of_id: input.reversalOfId ?? null,
        approval_request_id: input.approvalRequestId ?? null,
        created_by_id: input.createdById,
        lines: {
          create: resolved.map((r, i) => ({
            line_no: i + 1,
            account_id: r.accountId,
            branch_id: r.l.branchId === undefined ? (input.branchId ?? null) : r.l.branchId,
            debit: r.debit,
            credit: r.credit,
            memo: r.l.memo ?? null,
            supplier_id: r.l.supplierId ?? null,
            customer_id: r.l.customerId ?? null,
            financial_account_id: r.l.financialAccountId ?? null,
          })),
        },
      },
    });
  }

  /** Posts a mirror-image reversal and links it to the original. */
  async reverse(tx: Tx, entryId: string, opts: { date: string; reason: string; userId: string; currencyDecimals: number }) {
    const orig = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
    if (!orig) throw invalid("NOT_FOUND", "Journal entry not found");
    if (orig.status !== "POSTED" || orig.reversed_by_id) throw invalid("ALREADY_REVERSED", "Journal entry is already reversed");
    const rev = await this.post(tx, {
      businessId: orig.business_id,
      branchId: orig.branch_id,
      entryDate: opts.date,
      sourceType: "REVERSAL",
      sourceId: orig.id,
      sourceNumber: orig.number,
      description: `Reversal of ${orig.number}: ${opts.reason}`,
      createdById: opts.userId,
      reversalOfId: orig.id,
      currencyDecimals: opts.currencyDecimals,
      lines: orig.lines.map((l) => ({
        accountId: l.account_id, debit: l.credit, credit: l.debit, memo: l.memo ?? undefined,
        branchId: l.branch_id, supplierId: l.supplier_id, customerId: l.customer_id, financialAccountId: l.financial_account_id,
      })),
    });
    await tx.journalEntry.update({ where: { id: orig.id }, data: { status: "REVERSED", reversed_by_id: rev!.id } });
    return rev!;
  }
}

export function amountOrZero(v: DecInput | null | undefined) {
  return D(v ?? 0);
}
