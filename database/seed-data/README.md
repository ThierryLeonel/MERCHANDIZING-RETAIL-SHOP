# Seed data

Demonstration data is generated **through the business services** (not SQL inserts) so stock, cost pools and journals agree exactly: `apps/api/src/seed/demo-seed.ts` (`pnpm seed:demo --reset`, dev only).

It creates a fictional business (Mboa Home & Style — DEMO) with 2 stores + 1 warehouse, 4 registers, 11 users across all roles, 35 products / 63 SKUs across all merchandise categories (clothing and shoe variants, carton-to-piece conversions, an expiry-tracked product with a near-expiry batch, serial-tracked appliances and watches, a non-stock service), suppliers, customers (incl. credit accounts), purchase orders and receipts (incl. damaged goods and a partial delivery), a matched supplier invoice with price variance and part payment, transfers (one with a shortage, one in transit), cash/mobile-money/card/bank/split/credit/carton sales, returns, a pending mobile-money sale, cashier sessions (one closed with a variance), expenses, an approved write-off and a posted physical count. It finishes by printing the control-account reconciliation.

Production setup is separate: `apps/api/src/seed/production-setup.ts` (`pnpm setup:production`).
