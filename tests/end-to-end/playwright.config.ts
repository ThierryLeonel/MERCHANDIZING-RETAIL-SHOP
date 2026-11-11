import { defineConfig } from "@playwright/test";

/**
 * Browser tests run against a dedicated database (E2E_DATABASE_URL), reset and
 * demo-seeded by global-setup, with the API on :3100 and the web app on :5174.
 */
const E2E_DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/retail_e2e";
const chrome = process.env.PLAYWRIGHT_CHROME_PATH ?? (require("node:fs").existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);

export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: { baseURL: "http://127.0.0.1:5174", trace: "retain-on-failure", screenshot: "only-on-failure", launchOptions: chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : {} },
  webServer: [
    { command: "node -r @swc-node/register src/main.ts", cwd: "../../apps/api", port: 3100, reuseExistingServer: false, timeout: 120_000, env: { DATABASE_URL: E2E_DB, API_PORT: "3100", CORS_ORIGINS: "http://127.0.0.1:5174", RATE_LIMIT_PER_MINUTE: "5000", NODE_ENV: "test" } },
    { command: "npx vite --host 127.0.0.1 --port 5174 --strictPort", cwd: "../../apps/web", port: 5174, reuseExistingServer: false, timeout: 120_000, env: { API_URL: "http://localhost:3100" } },
  ],
});
