# Accounting and inventory policies

These policies are implemented in code and verified by tests. Change them only with your accountant.

## Money, quantities and rounding
- Money uses exact decimals (`NUMERIC(18,2)`); quantities `NUMERIC(18,3)`; unit costs `NUMERIC(18,6)` (informational). JavaScript floating point is never used for financial arithmetic (decimal.js via Prisma on the server; the browser only formats).
- Currency precision comes from business settings (XAF = 0 decimals). Amounts are rounded **HALF-UP at line level**; document totals are sums of rounded lines.
- Tax-exclusive pricing: `tax = round(net × rate)`. Tax-inclusive pricing (setting `prices_include_tax`): `tax = round(total × rate / (100 + rate))`, `net = total − tax`.
- The system ships **no statutory tax rates** and makes no compliance claim. The demo uses an illustrative 10 % "DEMO-TAX".

## Inventory costing
- **Weighted average per (variant, branch).** Each branch (warehouses are branches of kind WAREHOUSE) has its own cost pool, because landed cost and stock mix differ between sites. Transfers move value at the **source** branch's average cost into the destination pool.
- Inventory value is carried at currency precision. An issue takes `round(pool value × qty / pool qty)`; when a pool empties the last unit takes the exact remainder, so Σ pool values always equals the inventory control account (no rounding residue).
- Returns restock at the **original sale line cost**, not today's average or selling price. Positive adjustments and count surpluses enter at the current average cost.
- Purchase price differences found at invoice are expensed to **Purchase price variance** (inside cost of sales) rather than re-valuing stock that may already be sold. Landed-cost capitalisation is Phase 3.
- Damaged goods received are recognised (we accept liability and claim from the supplier) and held in the branch's DAMAGED location, which is not sellable. Rejected goods are not recognised.

## Physical vs financial flows
- FEFO (first-expiry-first-out) picking chooses batches physically; valuation always uses the branch average. Expired batches are excluded from sale automatically.
- Stock in QUARANTINE / DAMAGED locations is valued but not available for sale.

## Backdating policy
- **Stock-affecting documents cannot be backdated.** Receipts, sales, returns, transfers, adjustments and counts post at the current time and are journalled on the business-local current date. A supplier's delivery or document date can be recorded for reference but never re-values history. This prevents late postings from silently corrupting historical average costs.
- Purely financial documents (expenses, supplier invoices/payments, manual journals, funds transfers) may carry an earlier date **only within an open fiscal period**.
- Closing a period blocks all postings dated inside it (stock documents included, because they journal on today's date). Reopening requires an approval by a user with `approve.period_reopen`; earlier periods must be closed first.

## Payments
- Electronic payments (mobile money, card, bank transfer) start **PENDING** and are never treated as received because a method was selected. They become CONFIRMED only through a verified provider callback or an **authorised manual confirmation** (permission `pos.confirm_payment`, a reference, the confirming user and an audit event).
- A sale with pending payments reserves its stock; it completes atomically when the last payment confirms. Timed-out attempts are failed by the worker; the cashier can take another tender or cancel (which releases the reservation).
- For cash, the system records amount tendered, change given and **amount retained** (the amount posted).
- Refunds are separate records linked to the return.

## Returns
- Must reference the original sale line; cannot exceed the remaining returnable quantity (enforced with row locks and a DB check).
- Refund = the original line's net and tax amounts pro rata (the final unit takes the exact remainder). Returns outside the return window (setting) or above the refund threshold need approval.
- Exchanges are recorded as a linked return followed by a new sale.

## Opening balances (go-live)
Screen **Opening balances** (permission `accounting.opening_balances`, granted to Owner and System Administrator). One document (`OB-…`) posts one journal (source `opening_balance`) dated the chosen as-of date (not in the future, in an open period):

| Section | Posting |
|---|---|
| Cash / bank / mobile money (per financial account; negative = overdraft) | Dr (or Cr) the account's ledger account, tagged with the financial account. Tills are excluded — they start empty. |
| Customer owes | Dr Customer receivables (tagged with the customer) + an **open item** (`customer_opening_items`) with a due date; payments can be allocated to it, ageing and statements include it. |
| Customer store credit | Cr Customer deposits (usable as store credit at the POS). |
| Supplier owed | Cr Supplier payables (tagged) + an **opening supplier invoice** (no goods lines) that supplier payments allocate to. |
| Other accounts (loans, equipment, capital, other receivables) | Dr or Cr any postable, active account that is not a system/control account or a cash/bank account. |
| Balancing figure | Opening balance equity (account 1190) for the difference. |

Opening **stock** is entered separately per product (Import → Opening stock, or the products import): Dr Inventory / Cr Opening balance equity. The receivable and payable reconciliation checks include the opening items. A document can be reversed (mirror journal; open items voided; opening invoices reversed) only while none of its customer or supplier amounts has been paid. Several documents are allowed (e.g. for a forgotten balance); the screen warns when one already exists.

## Voids and corrections (no deletion of posted transactions)
Posted transactions are never deleted or edited in place: the stock ledger, journals and audit log are append-only (enforced by database triggers), and completed sales are immutable. An administrator holding `transactions.void` (granted to the Owner role by default) can instead **void** a transaction; the original stays on record, marked voided, with who/when/why, and a reversing entry is posted **dated the day of the void** (so closed periods are never changed):

| Transaction | What a void does |
|---|---|
| Sale | A full return of everything not yet returned (stock back at original cost to sellable stock, or written off if "put back into stock" is unticked) and a refund: cash from the voider's open till, cash from the safe/petty cash, mobile money / bank / card from a chosen account, or to the customer's account (reduces the receivable first, then store credit). No approval thresholds apply — the voider holds the authority. The sale shows *Voided*; further returns against it are refused. |
| Expense | Mirror-image reversal of its journal; status `REVERSED`. |
| Customer account payment | Allocations to credit sales are undone (they become outstanding again) and the journal is reversed. Refused if the unapplied part was already used as store credit. |
| Supplier payment | Invoice allocations are undone (invoices become outstanding again) and the journal is reversed. |

**Editing** a posted transaction = void it, then enter it again correctly. On a sale, *Void & re-enter* voids it and opens its items in the POS (agreed/overridden prices kept, discounts to be re-applied).

**Deleting** is only possible for records that were never used: products with no stock movements, purchases or sales (otherwise *Discontinue*), categories with no products or sub-categories, departments/brands/units not in use, and customers with no sales, payments or held carts (otherwise mark inactive).

## Customer credit
- Credit sales require an ACTIVE credit account and permission `pos.credit_sale`. Exceeding the limit requires a `CUSTOMER_CREDIT` approval for at least the excess.
- Unapplied customer payments and store credit are customer deposits (liability).

## Reporting dates
- Operational reports use the business-local date (`Africa/Douala` by default) of the completion/posting time. Financial statements use journal entry dates.
