import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@retail/api-contracts": fileURLToPath(new URL("../../packages/api-contracts/src/index.ts", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:3000", changeOrigin: false } } },
  preview: { port: 4173, proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:3000" } } },
});
