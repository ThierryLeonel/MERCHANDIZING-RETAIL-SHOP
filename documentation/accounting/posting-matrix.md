# Accounting posting matrix

Every business event posts exactly one balanced journal **inside the same database transaction** as the operational change (stock, payments, document status). If any part fails, nothing is recorded. Accounts are resolved through **posting rules** (`posting_rules` table, Accounting → Chart/Posting rules), so the matrix below is configuration, not code. Default account codes are shown in brackets (SYSCOHADA-inspired numbering — **not a certified chart; have your accountant review the mapping**).

| Event (source_type) | Debit | Credit | Notes |
|---|---|---|---|
| Opening stock (`opening_balance`) | Inventory [3110] | Opening balance equity [1190] | Qty × entered unit cost |
| Goods receipt (`goods_receipt`) | Inventory [3110] | Goods received not invoiced [4081] (supplier tagged) | Accepted **and damaged** quantities at PO cost; rejected not recognised |
| Supplier invoice matched to receipt (`supplier_invoice`) | GRNI [4081] at receipt value; Recoverable input tax [4452 or tax-rate account] if configured; Purchase price variance [6019] if invoice > receipt | Supplier payable [4010]; PPV [6019] if invoice < receipt | **Inventory is not touched** — prevents double counting. Final match clears exact remaining receipt value |
| Supplier invoice non-stock line | Chosen expense account | Supplier payable [4010] | e.g. freight not allocated to stock (landed-cost allocation is Phase 3) |
| Supplier payment (`supplier_payment`) | Supplier payable [4010] (allocated); Supplier advances [4091] (unallocated) | Paying financial account (bank/safe/wallet) | Allocation cannot exceed invoice outstanding |
| Sale (`sale`) | Collection account per **confirmed** payment (till / wallet clearing / card clearing / bank) at amount retained; Customer receivable [4110] for on-account portion | Sales revenue [7010] tax-exclusive; Output tax [4431 or tax-rate account] per rate | Posted only when all payments are confirmed |
| Cost of sale (same journal) | Cost of goods sold [6010] | Inventory [3110] | Weighted-average cost at moment of sale |
| Customer return (`sales_return`) | Sales returns [7019] (net); Output tax reversal; Inventory [3110] at **original line cost** for restocked goods; Write-offs [6581] for non-restockable cost | Refund account (till/bank/wallet) or Customer receivable [4110] / Customer deposits [4191]; Cost of goods sold [6010] (total returned cost) | Quarantined/damaged returns stay in inventory (different location) |
| Customer account payment (`customer_payment`) | Receiving financial account | Customer receivable [4110] (allocated); Customer deposits [4191] (unapplied) | Deposits are a liability, never revenue |
| Opening float (`cashier_session`) | Till (register's own account) | Safe | Internal transfer, not income |
| Cash drop (`cash_movement`) | Safe | Till | |
| Paid-out (`cash_movement`) | Chosen expense account | Till | Approval above threshold |
| Session close (`cashier_session_close`) | Till (overage) **or** Cash shortages [6582]; then Safe (counted cash) | Cash overages [7581] **or** Till (shortage); then Till | Till returns to zero after every close |
| Internal transfer (`funds_transfer`) | Destination account (net of fee); Bank & mobile money fees [6310] | Source account | Not an expense except the fee |
| Expense (`expense`) | Expense category accounts | Paying account | Tills excluded (use paid-outs) |
| Stock adjustment – loss/correction (`stock_adjustment`) | Inventory shrinkage [6580] | Inventory | At average cost |
| Stock adjustment – damage/expiry | Damaged & expired write-offs [6581] | Inventory | |
| Stock adjustment – found | Inventory | Inventory gains [7580] | At current average cost |
| Count variance (`stock_count`) | Shrinkage [6580] / Inventory | Inventory / Inventory gains [7580] | After approval above threshold |
| Transfer dispatch (`stock_transfer_dispatch`) | Inventory in transit [3810] | Inventory | Source branch average cost |
| Transfer receipt (`stock_transfer_receipt`) | Inventory (received); Shrinkage [6580] (documented shortage) | Inventory in transit [3810] | In-transit clears exactly per line |
| Manual journal (`manual_journal`) | Any non-control account | Any non-control account | Posts **only after approval by another user** |
| Reversal (`REVERSAL`) | Mirror of original | Mirror of original | Original marked REVERSED; never deleted |

## Controls enforced by the database (migration `20261111090100_integrity_controls`)

- Each journal line is one-sided and positive; header debit = credit > 0.
- Deferred constraint triggers verify at **commit** that lines sum to the header (an entry without lines, or with unbalanced lines, aborts the transaction).
- Entries must fall inside an **OPEN** fiscal period they reference (period lock).
- Posted journal entries cannot be updated (except linking a reversal) or deleted; journal lines, stock movements, audit events and approval actions are append-only.
- Completed sales cannot be deleted and their financial fields cannot change.

## Control-account reconciliation (Accounting → Reconciliation)

| Check | Sub-ledger | Ledger |
|---|---|---|
| Inventory valuation | Σ cost-pool values | Inventory control |
| Stock ledger value | Σ stock movement values | Σ cost-pool values |
| Stock ledger quantity | Σ movement quantities | Σ on-hand balances |
| Inventory in transit | Σ (dispatch value − resolved value) of open transfers | In-transit account |
| GRNI | Σ (receipt line value − matched receipt value) | GRNI (credit) |
| Supplier payables | Σ open invoice balances | Payables (credit) |
| Customer receivables | Σ open credit-sale balances | Receivables |

All seven checks are verified by the integration test suite and the browser test after a full workflow.
