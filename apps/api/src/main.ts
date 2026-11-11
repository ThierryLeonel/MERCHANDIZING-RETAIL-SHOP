import { Logger } from "@nestjs/common";
import express from "express";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./bootstrap";
import { config } from "./config";
import { startWorkerLoop } from "./worker/main";

async function main() {
  const app = await createApp();
  // Single-service deployment: serve the built web app from the same origin as /api
  // (required for the SameSite refresh cookie). Disable with SERVE_WEB=false.
  const webDist = resolve(process.env.WEB_DIST_DIR ?? join(__dirname, "..", "..", "web", "dist"));
  if (process.env.SERVE_WEB !== "false" && existsSync(join(webDist, "index.html"))) {
    const server = app.getHttpAdapter().getInstance();
    server.use(express.static(webDist, { index: false, maxAge: "1h" }));
    server.get(/^(?!\/api\/).*/, (req: any, res: any, next: () => void) => {
      if (req.method !== "GET" || !req.accepts("html")) return next();
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(join(webDist, "index.html"));
    });
    Logger.log(`Serving web app from ${webDist}`, "Bootstrap");
  }
  await app.listen(config.port, "0.0.0.0");
  Logger.log(`API listening on port ${config.port} (/api/v1, docs /api/docs)`, "Bootstrap");
  if (process.env.RUN_WORKER !== "false") {
    const worker = startWorkerLoop(app);
    process.on("SIGTERM", () => void worker.stop());
  }
}
main().catch((e) => { Logger.error(e?.message ?? e, e?.stack, "Bootstrap"); process.exit(1); });
