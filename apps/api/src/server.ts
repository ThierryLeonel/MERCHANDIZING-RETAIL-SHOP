import { Logger } from "@nestjs/common";
import express from "express";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./bootstrap";
import { config } from "./config";
import { startWorkerLoop } from "./worker/main";

/**
 * Boots the API. With `httpServer` (already listening, opened by main.ts), the
 * app is initialised without binding a new port and its request handler is
 * returned for main.ts to install; otherwise the app listens on config.port.
 */
export async function startServer(httpServer?: Server): Promise<(req: IncomingMessage, res: ServerResponse) => void> {
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
  const instance = app.getHttpAdapter().getInstance();
  if (httpServer) {
    await app.init();
    process.once("SIGTERM", () => httpServer.close());
  } else {
    await app.listen(config.port); // Node default: all IPv6 + IPv4 addresses where available
  }
  Logger.log(`API ready on port ${config.port} (/api/v1, docs /api/docs)`, "Bootstrap");
  if (process.env.RUN_WORKER !== "false") {
    const worker = startWorkerLoop(app);
    process.on("SIGTERM", () => void worker.stop());
  }
  return instance;
}
