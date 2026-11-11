# Deployment guide

> Nothing has been deployed publicly by the build session. This guide describes a supported path.

## Runtime requirements
- Node.js ≥ 22.12, pnpm 10 (`corepack enable`)
- PostgreSQL 16 (managed service recommended, with PITR backups)
- HTTPS reverse proxy (nginx, Caddy or a cloud load balancer)
- Stable internet at every store: the POS is cloud-connected and does not trade offline

## Build
```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build               # packages → api (dist/) → web (dist/)
```
Or containers: `docker build -f infrastructure/docker/api.Dockerfile -t retail-api .` (API and worker share the image) and serve `apps/web/dist` from nginx using `infrastructure/nginx/default.conf`.

## Configure (environment)
See `.env.example`. In production set at minimum: `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET` (≥ 32 random chars — the API refuses to start otherwise), `CORS_ORIGINS` (your web origin), `STORAGE_LOCAL_DIR` on persistent private storage (or replace the storage adapter with object storage), `MOBILE_MONEY_MODE` (`simulator` is disabled in production for the simulate endpoints; live adapters are Phase 4).

## First run
```bash
pnpm db:migrate
SETUP_BUSINESS_NAME="Your Company" SETUP_OWNER_EMAIL=owner@example.com SETUP_OWNER_PASSWORD='<strong password>' pnpm setup:production
```
`setup:production` creates the business, roles, chart of accounts, posting rules, approval policies and the owner account (forced password change). It refuses to run if a business exists and never creates demo data or default credentials. Then, in the app: create branches, registers, users, tax rates (from official guidance), products, and post opening stock.

## Processes
| Process | Command | Notes |
|---|---|---|
| API | `node apps/api/dist/main.js` | Stateless; run ≥ 2 behind the proxy |
| Worker | `node apps/api/dist/worker/main.js` | Outbox + payment timeouts; safe to run several (SKIP LOCKED) |
| Web | static files `apps/web/dist` | Proxy `/api` to the API |

## Health and monitoring
- `GET /api/v1/health` — database latency and worker heartbeat (`worker_last_seen`). Alert if the worker heartbeat is older than 1 minute.
- Logs are structured one-line request logs with request IDs and no bodies. Wire `errorReporter` in `apps/api/src/common/errors.ts` to Sentry or similar.
- Watch `outbox_events` with status `FAILED`.

## Upgrades
1. Back up the database. 2. Deploy new code. 3. `pnpm db:migrate` (checksummed; refuses modified migrations). 4. `pnpm db:check`. 5. Restart API and worker.
