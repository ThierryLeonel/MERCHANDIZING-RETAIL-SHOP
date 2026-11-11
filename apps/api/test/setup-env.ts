// Tests always run against TEST_DATABASE_URL (reset by global-setup), never the dev database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/retail_test";
process.env.NODE_ENV = "test";
process.env.MOBILE_MONEY_MODE = "simulator";
process.env.PAYMENT_ATTEMPT_TIMEOUT_SECONDS = "120";
