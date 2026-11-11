import { Logger } from "@nestjs/common";
import { createApp } from "./bootstrap";
import { config } from "./config";

async function main() {
  const app = await createApp();
  await app.listen(config.port);
  Logger.log(`API listening on http://localhost:${config.port}/api/v1 (docs: /api/docs)`, "Bootstrap");
}
main();
