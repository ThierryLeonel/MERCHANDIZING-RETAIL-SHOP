import "reflect-metadata";
import { INestApplication, Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { AppModule } from "./app.module";
import { config } from "./config";

export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: opts.logger === false ? false : ["log", "warn", "error"], rawBody: true });
  app.setGlobalPrefix("api/v1");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.getHttpAdapter().getInstance().set("trust proxy", 1);
  // request id + access log without bodies (no sensitive data in logs)
  const log = new Logger("HTTP");
  app.use((req: any, res: any, next: () => void) => {
    req.requestId = req.headers["x-request-id"] ?? randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    const start = Date.now();
    res.on("finish", () => { if (opts.logger !== false) log.log(`${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${Date.now() - start}ms user=${req.auth?.userId ?? "-"} req=${req.requestId}`); });
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("Retail Suite API").setDescription("Integrated retail management API (v1). Money and quantities are exact decimal strings.").setVersion("1.0").addBearerAuth().build());
  SwaggerModule.setup("api/docs", app, doc, { jsonDocumentUrl: "api/docs/openapi.json" });
  app.enableShutdownHooks();
  return app;
}
