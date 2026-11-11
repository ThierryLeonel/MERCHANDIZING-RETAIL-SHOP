import { writeFileSync } from "node:fs";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix("api/v1");
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("Retail Suite API").setVersion("1.0").addBearerAuth().build());
  const out = process.argv[2] ?? "../../documentation/architecture/openapi.json";
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`OpenAPI written to ${out} (${Object.keys(doc.paths).length} paths)`);
  await app.close();
}
main();
