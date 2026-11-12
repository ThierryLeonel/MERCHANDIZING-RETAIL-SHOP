# Worker

The background worker is a separate **process** but shares the API codebase so it uses the same services, transactions and posting rules:

- Source: `apps/api/src/worker/main.ts` (loop) and `apps/api/src/worker/outbox.ts` (handlers)
- Dev: `pnpm dev:worker` · Production: `node apps/api/dist/worker/index.js`

Responsibilities: transactional outbox (`payment.initiate`, `sale.completed` → low-stock notifications), payment-attempt timeout recovery, heartbeat (`background_jobs.worker-heartbeat`, shown by `GET /api/v1/health`). Multiple workers are safe (`FOR UPDATE SKIP LOCKED`).
