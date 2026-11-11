import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" }, jsc: { parser: { syntax: "typescript", decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true }, target: "es2022" } })],
  test: {
    globals: true,
    include: ["test/**/*.spec.ts"],
    setupFiles: ["test/setup-env.ts"],
    globalSetup: ["test/global-setup.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
