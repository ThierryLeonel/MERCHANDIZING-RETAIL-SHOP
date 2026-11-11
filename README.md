# Retail Suite

Integrated retail management for a multi-branch merchandising business (mini-supermarket style): point of sale, catalogue and pricing, purchasing, inventory with weighted-average costing, cashier sessions, customers and credit, approvals, and **double-entry accounting posted automatically by every transaction**. Localised defaults for Cameroon (XAF, `Africa/Douala`), configurable taxes and policies.

> Status: **Phase 1 complete and large parts of Phase 2 implemented.** See [feature status](documentation/operations/known-limitations-and-backlog.md) for exactly what is verified, simulated, deferred or blocked, and [BUILD_PROGRESS.md](BUILD_PROGRESS.md) for the build log.

## Stack
React 19 + TypeScript + Vite 7 + Tailwind 4 · NestJS 11 · PostgreSQL 16 · Prisma 7 (engine-free client, `pg` adapter) · Vitest + Supertest · Playwright · pnpm workspaces (modular monolith).

## Requirements
- Node.js **22.12+** and pnpm 10 (`corepack enable`)
- PostgreSQL 16 (Docker Compose file provided, or any local/managed instance)
- A Chromium-based browser for Playwright (`npx playwright install chromium`, or set `PLAYWRIGHT_CHROME_PATH`)

## Quick start (development)
```bash
cp .env.example .env                 # adjust DATABASE_URL etc.
docker compose up -d postgres        # or use your own PostgreSQL 16 (create retail_dev and retail_test)
pnpm install
pnpm db:generate                     # Prisma client
pnpm --filter @retail/api-contracts build && pnpm --filter @retail/db build
pnpm db:migrate                      # apply committed SQL migrations
pnpm seed:demo --reset            # DEMO data through the real services (dev only)

pnpm dev:api                         # http://localhost:3000/api/v1  (OpenAPI UI: /api/docs)
pnpm dev:worker                      # outbox + payment timeout recovery
pnpm dev:web                         # http://localhost:5173
```

### Demo sign-in (demo data only — fictional business)
Password for all demo users: `Demo@12345`

| Role | Email |
|---|---|
| Owner | owner@mboa.demo |
| Store manager (Akwa) | manager.akwa@mboa.demo |
| Cashier (Akwa; till 2 has an open session) | cashier2.akwa@mboa.demo |
| Cashier (Bonapriso; open session with a pending mobile-money sale) | cashier.bonapriso@mboa.demo |
| Purchasing officer | buyer@mboa.demo |
| Storekeeper | storekeeper@mboa.demo |
| Accountant | accountant@mboa.demo |
| System administrator (no approval authority) | admin@mboa.demo |
| Read-only auditor | auditor@mboa.demo |

The demo seed refuses to run when `NODE_ENV=production`. For a real installation use `pnpm setup:production` (see the [deployment guide](documentation/operations/deployment.md)); it never creates default credentials.

## Commands
| Command | What it does |
|---|---|
| `pnpm db:migrate` / `db:reset` / `db:check` | Apply migrations / reset (dev+test only) / verify the live DB matches the Prisma schema |
| `pnpm test` | API unit + integration tests against `TEST_DATABASE_URL` (reset each run) |
| `pnpm test:e2e` | Playwright browser workflow (seeds `retail_e2e`, starts API :3100 and web :5174) |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | Across all workspaces |
| `pnpm --filter @retail/api openapi` | Export `documentation/architecture/openapi.json` |
| `pnpm --filter @retail/db erd`, `pnpm --filter @retail/api-contracts docs` | Regenerate ERD and permission matrix docs |

## Documentation
- Architecture: [overview](documentation/architecture/overview.md) · [database](documentation/architecture/database.md) · [ERD](documentation/architecture/erd.md) · [OpenAPI](documentation/architecture/openapi.json)
- Requirements: [permission matrix](documentation/requirements/permission-matrix.md) · [pricing rules](documentation/requirements/pricing.md) · [report definitions](documentation/requirements/reports.md)
- Accounting: [posting matrix](documentation/accounting/posting-matrix.md) · [policies (costing, rounding, backdating, payments)](documentation/accounting/policies.md)
- Operations: [deployment](documentation/operations/deployment.md) · [backup & recovery](documentation/operations/backup-recovery.md) · [feature status, limitations & backlog](documentation/operations/known-limitations-and-backlog.md)

## Repository layout
```
apps/api        NestJS API (src/modules/*), worker (src/worker), seeds (src/seed), tests (test/)
apps/web        React SPA (src/pages/*, src/components)
apps/worker     README — the worker process runs from apps/api/src/worker
packages/db     Prisma client + tools: migrate, drift-check, generate-ddl, erd
packages/api-contracts  shared permission catalogue
database/       prisma/schema.prisma, migrations/, seed-data/
tests/end-to-end  Playwright
documentation/, infrastructure/ (Dockerfile, nginx, postgres init)
```

## Internet and offline
The application is cloud-connected and requires internet at each store. It does **not** provide offline trading; that is a separately scoped future phase.
