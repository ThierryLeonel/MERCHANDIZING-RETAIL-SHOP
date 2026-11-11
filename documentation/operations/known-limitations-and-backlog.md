# Feature status, known limitations and backlog

Legend: **Verified** = implemented and covered by automated tests (integration and/or browser) · **Implemented** = built end to end (DB → API → UI), exercised by the demo seed and/or manual screenshots, without a dedicated automated test · **Simulated** = development stand-in, clearly labelled · **Schema only** = tables exist, no workflow yet · **Deferred** / **Blocked**.

## Status by area

| Area | Status | Notes |
|---|---|---|
| Auth: argon2id, lockout, JWT + rotating refresh cookie, reuse detection, grace window, session list/revoke, password change | Verified | MFA/TOTP for privileged roles is deferred (schema fields exist) |
| Server-side permissions, branch scope, cost hiding | Verified | |
| Roles/permissions admin, users, branches, registers, tax rates, approval policies, settings, audit log | Implemented | UI admin screens not browser-tested |
| Approvals (request, decide, supervisor override, consume once, no self-approval, hooks) | Verified | |
| Catalogue: products, variants, attributes, barcodes, packaging conversions, images, statuses | Verified (API) / Implemented (UI) | Image upload via private attachments |
| Product types STANDARD, VARIANT, PREPACKED_SET, NON_STOCK | Verified | |
| VIRTUAL_BUNDLE, ASSEMBLED_KIT | Schema only | Creation is refused with a clear message (Phase 3) |
| Price lists, branch prices, effective dates, wholesale via customer group, min price | Verified | Price-list item editing UI is API-only (POST `/price-lists/:id/items`); no screen yet |
| Promotions engine | Schema only | Phase 3 |
| Purchase orders, approval threshold, partial receipts, accepted/damaged/rejected, over-receipt tolerance, batches, serials | Verified | |
| Supplier invoices with 3-way matching, price variance, supplier payments, advances | Verified | |
| Supplier returns, supplier credit notes, landed-cost allocation | Schema only | Phase 2/3 |
| Stock ledger, weighted average per branch, reservations, FEFO, quarantine, serials | Verified | |
| Transfers (draft → approved → dispatched → partial/received → closed) with shortages | Verified (API) / Implemented (UI) | |
| Physical counts (snapshot, blind entry, approval, posting) | Implemented | Seeded; no dedicated automated test |
| Adjustments / write-offs with approval | Verified | |
| Low stock alerts (worker), reorder suggestions, expiry report | Implemented | |
| POS: scan, search, shortcuts, cart, quantity, discounts with approval, customer, held carts, receipt print | Verified (browser test covers search → cash sale → receipt) | Hardware barcode scanners work as keyboard input |
| Split payments, pending electronic payments, manual confirmation, timeout recovery, duplicate callback protection | Verified | |
| Mobile money provider | **Simulated** | `MOBILE_MONEY_MODE=simulator`: labelled “DEV SIMULATOR” controls emit signed callbacks; disabled in production. Live MTN/Orange adapters need credentials (Phase 4) |
| Card payments | Implemented (manual confirmation) | No terminal integration; authorised user enters the approval code |
| Returns and exchanges (partial, limits, conditions, original cost, approval) | Verified | Exchange = return + new sale; the link field `exchange_return_id` is supported by the API but not yet set by the UI |
| Cashier sessions: float, drops, paid-outs (API), count, variance with approval, close to safe | Verified | Paid-out UI not yet on the POS (API supports it) |
| Customers, credit limits, account payments, deposits, statements, ageing | Verified (API) / Implemented (UI) | |
| Double-entry accounting, posting matrix, period locks, manual journals with approval, reversals | Verified | |
| Trial balance, P&L, balance sheet, control-account reconciliation | Verified | |
| Expenses, internal transfers | Implemented | |
| Settlements (provider gross/fees/net) and bank statement reconciliation workflows | Schema only | Fees can be recorded via internal transfer with fee today |
| Direct cash-flow report | Deferred | By requirement, after reconciliations are reliable |
| Reports (17) with CSV export and drill-down | Implemented | PDF export deferred; browser print available |
| Outbox + worker, health check with worker heartbeat | Verified (outbox processing seen in logs; payment expiry tested) | |
| i18n | Partial | Structure (`apps/web/src/i18n`) with navigation/common strings; most screen text is still inline English |
| Offline trading | Not supported | Separate Phase 4 design |
| Docker Compose / Dockerfile | **Unverified** | No Docker daemon in the build environment; PostgreSQL 16 was run directly instead |
| Prisma migrate engine | **Blocked in build env** | Binary download refused by network policy; migrations are committed SQL applied by our runner (Prisma-compatible history table) |

## Known limitations / issues
1. **Abandoned pending sales keep their reservation** until a cashier cancels or completes them; the worker fails expired payment attempts but does not auto-cancel the sale. A session cannot close while it has pending sales. *Backlog: auto-cancel after N minutes with notification.* (The demo seed intentionally leaves one such sale, `S-DLA2-000004`, on the Bonapriso till.)
2. Demo history is a single day because stock documents cannot be backdated by policy; the dashboard 7-day chart therefore shows one bar after seeding.
3. Rate limiting uses in-memory storage per API instance; use a shared store (e.g. Redis) when running several instances.
4. `idempotency_records` are never pruned; add a scheduled cleanup (e.g. older than 7 days).
5. Report endpoints cap rows (500–1000) rather than paginate; audit view shows the latest 200 events.
6. Source-document corrections: goods receipts and supplier invoices cannot yet be reversed by a document (supplier returns/credit notes are Phase 2/3); manual journals can be reversed.
7. Paid-out expense accounts are not restricted to EXPENSE-type accounts server-side.
8. The `allow_negative_stock` business setting is not supported: non-negative stock is enforced by a database CHECK.
9. Customer account-payment method is inferred from the receiving account type.
10. Registered POS device tokens (`cash_registers.device_token_hash`) are not yet enforced.
11. Initial migrations `..._init` and `..._integrity_controls` were edited before first release; any database created from an earlier copy must be reset (`pnpm db:reset`, dev only). From now on, only add new migrations.

## Backlog (priority order)
1. Auto-cancel stale pending sales; paid-out and exchange flows in the POS UI; price-list editing screen.
2. Supplier returns and credit notes; goods-receipt reversal document.
3. Provider settlements and bank/wallet statement reconciliation; then direct cash-flow report.
4. MFA (TOTP) for Owner/Accountant/System Administrator; device registration for registers.
5. French translation pass (move remaining strings into `i18n`).
6. Phase 3: promotions engine, virtual bundles & assembled kits, landed-cost allocation (by value/quantity), warranty claims, PDF exports, expanded reports.
7. Phase 4: live MTN MoMo / Orange Money adapters (behind `PaymentAdapterRegistry`), SMS/email notifications via the outbox, additional sales channels, separately designed offline POS.
