# BUILD_PROGRESS

_Last updated: 2026-11-16 (session 6: responsive and softer UI, dialog typing fix, branch edit/delete). Read this first when continuing the build._

## Current phase
**Phase 1 — complete and verified.** **Phase 2 — mostly implemented** (supplier invoices & payments, credit customers, returns, split payments, transfers, counts, adjustments, approvals, expenses, control-account reconciliation). Remaining Phase 2 items: supplier returns/credit notes, provider settlements and statement reconciliation workflows, auto-cancel of stale pending sales, POS paid-out and exchange-link UI. Phase 3/4 not started (schema foundations exist for promotions, bundles/kits, landed costs, settlements, reconciliations, integrations).

## Completed and verified features
Verified = covered by automated tests that passed in this session (see "Commands run").
- Monorepo (pnpm), PostgreSQL schema (97 tables, 312 FKs), committed migrations, migration runner with checksums, drift check.
- DB-level integrity: non-negative stock, balanced journals at commit (deferred triggers), period lock, immutable posted journals, append-only ledgers/audit, one open session per register.
- Auth (argon2id, lockout, JWT + rotating httpOnly refresh with reuse detection and 30 s grace), session revocation, server-side permissions, branch scope, cost hiding, request validation, structured errors, idempotency keys, webhook signature + duplicate protection, rate limiting.
- Catalogue (types, variants, attributes, barcodes incl. carton barcodes, packaging conversions), pricing precedence with effective dates, min price & discount approvals.
- Catalogue setup screen (`/products/setup`): categories with sub-categories (no cycles, case-insensitive duplicate check, activate/deactivate), departments, brands, units; quick "new category" from the product form; category filter includes sub-categories.
- Bulk / loose goods (`BULK` type: one SKU, fractional quantities, no serials; buy by lot via packaging unit) and negotiable prices: cashiers bargain down to the minimum price, a hard floor (`BELOW_MIN_PRICE`, no approval route); POS "Bargain" dialog accepts a unit price or an agreed total; Pay is disabled until the quote matches the cart.
- Import & export (`/import`, `data.import`): products & categories (with optional opening stock), opening stock, customers from .xlsx/.csv; English/French headers; dry-run per-row plan; all-or-nothing; export current products/customers in the same format for edit-and-reimport; starter catalogue (~108 mini-supermarket items, prices empty → *Price not set*, unsellable until priced). See documentation/operations/data-import.md.
- Voids (`transactions.void`, Owner): sale (full reversing return + refund from till/safe/account or to customer account; *Void & re-enter* loads items into POS), expense, customer account payment, supplier payment — records kept, reversals dated today. Deletes only for never-used products, categories/departments/brands/units, customers. Sales history page (`/sales`), supplier payments tab, customer payments tab. See documentation/accounting/policies.md "Voids and corrections".
- Chart of accounts editing (add / edit / delete unused; codes and types fixed once used; system accounts stay manual-off) and financial accounts (add with an auto-created ledger account under Banks/Wallets/Cash/Clearing, rename, deactivate when empty, delete if never used). `ChartService`.
- Printing: `components/print.tsx` copies a receipt (80 mm) or report (A4 with business header, title, period, printed by/at) into `#print-root`; Print buttons on all reports, P&L, balance sheet, trial balance, reconciliation, customer statement, cashier session X/Z report; receipts show VOIDED on voided sales.
- Sample customers (6) and suppliers (5) marked "(sample)" on the Import page; supplier import/export, edit and delete (unused only).
- Backup & reset (Administration, `admin.backup` / `admin.reset`, Owner): full SQL backup download (FK-ordered INSERTs, deferred links updated at the end, restorable without superuser into a fresh migrated DB — verified table-for-table); clear transactions or everything (TRUNCATE, password + business-name confirmation, single-business only, audit kept). See documentation/operations/backup-recovery.md.
- Audit log retention (`admin.audit_purge`, Owner): delete entries older than 6/12/24/36 months with password confirmation and optional CSV download first; DB trigger allows DELETE only with the purge flag and only for entries older than 6 months; UPDATE always refused; purge is itself audited.
- Opening balances (`/opening-balances`, `accounting.opening_balances`, Owner + System Administrator): cash/bank/wallet balances, customer debts (open items payable and aged) and store credit, supplier debts (opening supplier invoices), other accounts; balancing to Opening balance equity; reversible while unpaid. See documentation/accounting/policies.md "Opening balances".
- Cash registers (Administration → Branches & registers): create, edit (name; code while unused; stock location when no session is open; activate/deactivate — till must be empty and no open session), delete if never used (removes its till account and ledger account). Till ledger codes now pick the first free 571xx code.
- Fixes found while testing: supplier update accepted arbitrary fields (now a validated DTO); report endpoints returned the Express response to an interceptor (server errors in logs); wrong confirmation/approver passwords returned 401 and signed the user out (now 400); refresh rate limit raised to 120/min (configurable).
- Single-service hosting (Laravel Cloud): port opened immediately on IPv6+IPv4 with 503 while starting, in-process migrations, DB-stored signing secret when `JWT_SECRET` is absent.
- Purchasing: PO lifecycle with approval threshold, partial receipts with accepted/damaged/rejected, over-receipt tolerance, batches/expiry, serials; supplier invoice matching with PPV (no double counting); supplier payments & advances.
- Inventory: append-only ledger, weighted average per branch (exact residue), concurrency-safe issues, reservations, FEFO, quarantine/damaged locations, transfers with in-transit and shortages, adjustments, counts.
- POS & payments: backend-priced quote/checkout, cash tendered/change/retained, split payments, pending electronic payments with reservation, authorised manual confirmation, simulator provider, timeout recovery, held carts (no reservation), receipts.
- Returns (limits, conditions, original amounts and cost, approvals) and refunds.
- Cashier sessions (float from safe, drops, paid-outs API, count, variance reason/approval, close to safe).
- Customers & credit (limits with approval, account payments, deposits as liability, statements, ageing).
- Accounting: posting engine + configurable posting rules, manual journals with approval, reversals, periods close/reopen-with-approval, trial balance, P&L, balance sheet, 7 control-account reconciliations.
- Web app: all main navigation areas with role-aware menus; POS, returns, products, inventory, purchasing, customers, finance, accounting, reports (17 with CSV), approvals, administration, account/session management.
- Demo seed through services (reconciles exactly); production setup (no default credentials).
- Docs: architecture, database, ERD (generated), permission matrix (generated), posting matrix, policies, pricing, reports, deployment, backup/recovery, feature status/limitations/backlog, OpenAPI (123 paths).

- Responsive, softer UI (session 6): the sidebar becomes a slide-in drawer below 1024 px (hamburger, backdrop, Esc, closes on navigation); header, page headers, card headers, pagination and dialog footers wrap; tables scroll sideways inside their card; dialogs are bottom sheets on phones (92dvh, safe-area padding) and centred with a fade/scale animation from 640 px; POS stacks catalogue over cart on phones/tablets; inputs use 16 px text on phones (no iOS zoom). Buttons: rounded, smooth hover/press (scale 0.97), focus rings; selects: native (scanner/keyboard friendly) with a custom chevron and soft focus ring; reduced-motion respected.
- Typing fix: dialogs no longer pull the cursor back to their first field while typing (the focus effect re-ran on every render because parents pass a new onClose); search boxes never overwrite text being typed.
- Branches: edit (name, phone, address, active; code only while unused, safe renamed with it) and delete (only with no transactions or stock; removes default locations, unused registers, tills, safe and their ledger accounts). Audit entries stay append-only; a branch delete may only clear branch_id on that branch's entries (trigger-enforced, migration 20261116010000). Branch and register rows have Edit and Delete buttons.

Session 6 verification: `pnpm test` **71/71** (adds branch edit/delete incl. trigger refusal of other audit updates), `pnpm test:e2e` **21/21** (adds key-by-key typing focus check, branch create/edit/delete with refusal for a branch with sales, phone-viewport drawer/no-sideways-scroll/dialog fit), drift check clean, lint clean, build OK.

Session 5 verification: `pnpm test` **70/70** (incl. opening balances with payment allocation, ageing and reconciliation, and register lifecycle) (adds chart/financial-account tests, audit retention incl. direct-SQL refusal, and a backup → restore into a fresh database → clear test), `pnpm test:e2e` **19/19** (incl. opening balances by the System Administrator and register create/edit/delete) (adds accounts setup, sample contacts, printing, backup download, clear), drift check clean, lint clean, build OK.

Session 4 verification: `pnpm test` **63/63**, `pnpm test:e2e` **11/11** (adds starter catalogue import, CSV customer import, void from Sales history), drift check clean, lint clean, build OK; Excel template download and export → re-import round trip checked in Chrome.

Session 3 verification: `pnpm test` **55/55**, `pnpm test:e2e` **8/8** (adds categories + bargaining browser test), drift check clean, build OK, demo seed reconciles (adds a bale of T-shirts and wax fabric by the metre).

Implemented but not covered by a dedicated automated test: admin screens, counts workflow, reports UI, customer/finance/accounting UI screens (screens were visually checked for dashboard, POS, P&L, inventory, admin).

## Important design decisions (details: documentation/architecture/overview.md, documentation/accounting/policies.md)
1. Modular monolith; worker runs from `apps/api/src/worker` (separate process, shared services).
2. Prisma fields are snake_case to match raw SQL used for locking/reporting.
3. Prisma 7 engine-free client with `@prisma/adapter-pg`. **Prisma's schema-engine binary download is blocked in the build environment**, so migrations are SQL: `0001_init` generated by `packages/db/tools/generate-ddl.ts` (DMMF → DDL, explicit FK map that fails on unmapped `*_id`), later migrations hand-written; `packages/db/tools/migrate.ts` writes Prisma-compatible `_prisma_migrations` rows; `drift-check.ts` validates DB vs schema.
4. Weighted-average costing per (variant, branch); inventory values at currency precision; last unit takes remainder → exact stock-to-ledger reconciliation.
5. Stock documents cannot be backdated; financial documents may be dated inside open periods only.
6. PPV is expensed (within cost of sales); damaged receipts are recognised into a DAMAGED location; rejected are not.
7. Quarantine/damaged are locations; availability = sellable locations − reservations.
8. Pending electronic payments reserve stock; held carts never do.
9. Generic approvals (request → decide → consume once) with module hooks; no self-approval by default; System Administrator holds no approval permissions; thresholds editable only with `admin.settings` + `accounting.periods`.
10. Warehouses are branches of kind WAREHOUSE.
11. Money in API responses is always an exact decimal string.
12. **Gotcha:** decimal.js `isPos()` returns true for zero — never use it; use `.gt(0)` / `.lt(0)` (all code converted).

## Commands run and results (session 1, final run from repo root)
| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 (4 workspaces) |
| `pnpm lint` | exit 0 (ESLint 9 + typescript-eslint; api and web) |
| `pnpm build` | exit 0 (packages, api `dist/`, web `dist/` 325 kB JS gzip 104 kB) |
| `pnpm db:check` | No drift |
| `pnpm test` | **50/50 passed** (7 files: unit, inventory-costing, purchasing, sales-payments, returns-transfers, accounting, http-security) |
| `pnpm test:e2e` | **6/6 passed** (Playwright, system Chrome: purchase → receipt → sale → return → cashier close → reconciliation & permission check) |
| `pnpm seed:demo --reset` | completed; all 7 reconciliation checks OK |
| `pnpm setup:production` (scratch DB) | weak password rejected; success on empty DB; refused on second run |
| `node apps/api/dist/main.js` | compiled API served `/api/v1/health` OK |
| Docker Compose | **not run** — no Docker daemon in the environment |

Bugs found and fixed during verification: zero quantities passing `isPos()` guards; return lines against the same sale line double-counting the remaining cost; UI amount summing stripping integer zeros ("5500" → "55") — caught by the browser test; refresh-token rotation race under React StrictMode / multiple tabs (added grace window migration).

## Known issues
See `documentation/operations/known-limitations-and-backlog.md` (abandoned pending sales keep reservations; single-day demo history; in-memory rate limiting; idempotency record pruning; report row caps; no receipt/invoice reversal documents yet; partial i18n).

## Pending migrations or configuration
- No pending migrations. Current: `20261111090000_init`, `20261111090100_integrity_controls`, `20261111100000_session_refresh_grace`, `20261112040000_system_secrets`, `20261114080000_bulk_negotiable_pricing`, `20261114080100_bulk_units` (adds KG/L/M/BAG/BALE/HEAP units to existing businesses), `20261115170000_voids_imports` (void columns; grants `transactions.void` and `data.import` to Owner roles), `20261115190000_backup_reset_permissions` (grants `admin.backup` and `admin.reset` to Owner roles), `20261115200000_audit_retention` (audit trigger allows purging entries older than 6 months; grants `admin.audit_purge` to Owner roles), `20261115210000_opening_balances` (opening_balances, customer_opening_items, customer_opening_allocations, supplier_invoices.opening_balance_id; grants `accounting.opening_balances` to Owner and System Administrator), `20261116010000_branch_delete` (audit trigger also allows clearing `branch_id` only for the branch being deleted, under the transaction-local `app.branch_delete` flag). Migrations run automatically at API start (`MIGRATE_ON_START=false` to disable).
- `init` and `integrity_controls` were edited before first release. Databases created from an earlier snapshot must be reset (`pnpm db:reset`, dev only). **From now on only add new migrations.**
- Configure for production: `JWT_SECRET`, `CORS_ORIGINS`, persistent private storage, real tax rates (none shipped), posting-rule review by an accountant, approval thresholds.
- Live mobile money needs provider credentials and an adapter (Phase 4).

## Exact next implementation steps
1. Worker job: auto-cancel `PENDING_PAYMENT` sales whose attempts all failed/expired after N minutes (release reservations, notify cashier); test it.
2. POS UI: paid-out dialog (API exists: `POST /cashier-sessions/:id/movements` kind `PAID_OUT`), exchange flow that sets `exchange_return_id` after a return.
3. Price-list management screen (API exists: `GET/POST /price-lists/:id/items`).
4. Supplier returns + supplier credit notes (tables exist: `purchase_returns`, `purchase_return_lines`, `supplier_credit_notes`): stock out at receipt cost from DAMAGED/QUARANTINE, Dr Payable / Cr Inventory, credit-note allocation.
5. Settlements (gross/fees/net from clearing accounts) and statement reconciliation (tables exist), then the direct cash-flow report.
6. Integration tests for counts workflow and admin role-grant escalation guard; Playwright for transfers and approvals.
7. MFA (TOTP) for privileged roles; register device tokens.
8. French dictionary and string extraction.
9. Phase 3: promotions engine, bundles/kits, landed-cost allocation, PDF exports.
