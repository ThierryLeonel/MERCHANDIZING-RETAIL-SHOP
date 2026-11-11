# Architecture overview

## Shape
A **modular monolith** (no microservices):

```
apps/web      React 19 + TypeScript + Vite + Tailwind 4 SPA (role-aware UI)
apps/api      NestJS 11 REST API under /api/v1 (+ OpenAPI at /api/docs)
              └─ src/worker/main.ts  background worker process (same codebase)
packages/db   Prisma 7 client (engine-free, pg driver adapter) + migration tooling
packages/api-contracts  permission catalogue and approval types shared by API and web
database/     prisma/schema.prisma, migrations/ (committed SQL), seed-data/
tests/        end-to-end/ (Playwright); API integration tests live in apps/api/test
documentation/, infrastructure/
```

Adaptations from the suggested structure (deliberate):
- **Worker** lives in `apps/api/src/worker` so it reuses the same services and transaction code; `apps/worker/README.md` explains how to run it. It is still a separate process.
- **UI components** live in `apps/web/src/components` (single consumer); a `packages/ui` package would add build plumbing without benefit yet.
- **Integration tests** live next to the API (`apps/api/test`) to share the Nest test harness.

## API modules (apps/api/src/modules)
auth · admin · catalogue (+pricing) · inventory (stock ledger) · purchasing · sales (+payment adapters) · finance (sessions, transfers, expenses) · customers · accounting (posting engine, statements, reconciliation) · approvals · reports · system (health, attachments).

Cross-cutting (`src/common`): Prisma service with READ COMMITTED transactions, decimal money helpers, structured errors, auth/permission guards, idempotency interceptor, audit service, document sequences, settings/timezone helpers, log redaction.

## Request pipeline
`ThrottlerGuard` (rate limits; stricter on login and supervisor override) → `AuthGuard` (JWT **and** live DB session check, so revocation is immediate) → `PermissionsGuard` (`@RequirePermissions`) → `ValidationPipe` (whitelist, reject unknown fields) → service (branch scope checks, business rules) → `IdempotencyInterceptor` (critical mutations require `Idempotency-Key`; replays stored response) → `DecimalSerializerInterceptor` (decimals as exact strings) → `GlobalExceptionFilter` (`{ error: { code, message, details }, requestId }`).

## Transaction safety
- Every business document (sale, receipt, return, transfer step, count posting, session close…) is one database transaction covering document rows, stock movements, cost pools, and the journal.
- **Overselling prevention:** the stock ledger locks the `(variant, branch)` cost-pool row `FOR UPDATE`, then decrements the balance with a conditional update (`qty_on_hand − qty_reserved ≥ q`). Variants are locked in ascending id order to avoid deadlocks. A DB `CHECK (qty_on_hand >= 0)` is the last line of defence. Verified by a concurrent "last unit" test.
- **Gap-free document numbers** are allocated with a row-locked upsert inside the transaction.
- **External calls never run inside DB transactions.** Payment initiation is written to the **outbox** in the same transaction and executed by the worker after commit (`FOR UPDATE SKIP LOCKED`, exponential back-off, stuck-event recovery).
- **Payment state machine:** `PENDING → CONFIRMED | FAILED | CANCELLED`. Provider callbacks are de-duplicated by a unique `(provider, event_id)`; late callbacks for final states are recorded and ignored. The worker expires stale attempts (timeout recovery).

## Security
- argon2id password hashing; account lockout after 5 failures (15 min).
- 15-minute HS256 access tokens held in memory; refresh token in an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/auth`, rotated on every use with reuse detection (a stale token revokes the session) and a 30-second grace window for concurrent tabs.
- Server-side permissions and branch scope on every endpoint; cost prices stripped from responses for users without `products.view_cost`.
- Supervisor override: an approver re-authenticates on the cashier's screen; creates a single-use, 60-second session that is revoked immediately.
- Private attachments: magic-byte type sniffing, size limit, stored outside the web root, served only to authorised users with `nosniff`.
- Logs never include bodies; sensitive keys are redacted from logs and audit payloads; CSV exports neutralise formula injection.
- Helmet headers, CORS allow-list, request IDs.

## Key decisions (ADR summary)
| # | Decision | Rationale |
|---|---|---|
| 1 | snake_case Prisma fields | Raw SQL for locking/reporting matches code 1:1 |
| 2 | Weighted average **per branch** | Branch landed costs differ; transfers carry source cost |
| 3 | Inventory value at currency precision; last unit takes remainder | Exact stock-to-ledger reconciliation with no residue |
| 4 | Stock documents cannot be backdated | Protects historical average cost |
| 5 | PPV expensed, not capitalised | Stock may already be sold; landed cost allocation is Phase 3 |
| 6 | Pending electronic payments reserve stock; held carts do not | Matches the requirement and avoids selling stock a customer is paying for |
| 7 | Warehouses modelled as branches (kind WAREHOUSE) | Same costing, locations and accounting dimension |
| 8 | Quarantine/damaged are **locations**, not balance columns | Simple, auditable relocation; availability = sellable locations only |
| 9 | Migrations are committed SQL in Prisma's folder format, applied by `packages/db/tools/migrate.ts` | The Prisma schema-engine binary could not be downloaded in the build environment; the runner writes Prisma-compatible `_prisma_migrations` rows so `prisma migrate deploy` works where the engine is available. A drift check compares the live DB to the Prisma schema |
| 10 | Approvals as a generic request → decide → consume flow with module hooks | One audited mechanism for discounts, overrides, refunds, adjustments, POs, credit, journals, period reopen, cash variances |

## Offline
The system is **cloud-connected only**. It does not claim offline trading; browser caching is not an offline mode. Offline POS is a separately designed Phase 4 item (local queue, conflict rules, stock reservation strategy).
