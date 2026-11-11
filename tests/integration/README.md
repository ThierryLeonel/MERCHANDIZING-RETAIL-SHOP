# Integration tests

API unit and database integration tests live in `apps/api/test` (they share the NestJS harness). Run with `pnpm test` — they reset `TEST_DATABASE_URL` and refuse to touch a database whose name does not contain "test".
