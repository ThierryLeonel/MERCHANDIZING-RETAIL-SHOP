import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { from, Observable, of, switchMap, tap, catchError, throwError } from "rxjs";
import { conflict, invalid } from "./errors";
import { PrismaService } from "./prisma.service";
import { toJSONSafe } from "./money";

export const IDEMPOTENT = "idempotent";
/** Marks a critical mutation: requires an Idempotency-Key header and replays the stored response on retry. */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private reflector: Reflector, private prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(IDEMPOTENT, ctx.getHandler())) return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const key: string | undefined = req.headers["idempotency-key"];
    if (!key || key.length < 8 || key.length > 80) throw invalid("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header (8-80 chars) is required");
    const route = `${req.method} ${req.route?.path ?? req.path}`;
    const hash = createHash("sha256").update(JSON.stringify(req.body ?? {}) + JSON.stringify(req.params ?? {})).digest("hex");
    const userId = req.auth.userId as string;
    const db = this.prisma.client;

    return from(
      (async () => {
        const existing = await db.idempotencyRecord.findUnique({ where: { user_id_key_route: { user_id: userId, key, route } } });
        if (existing) {
          if (existing.request_hash !== hash) throw invalid("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
          if (existing.status_code == null) throw conflict("REQUEST_IN_PROGRESS", "An identical request is still being processed");
          return { replay: existing };
        }
        try {
          await db.idempotencyRecord.create({ data: { user_id: userId, key, route, request_hash: hash } });
        } catch {
          throw conflict("REQUEST_IN_PROGRESS", "An identical request is being processed");
        }
        return { replay: null };
      })(),
    ).pipe(
      switchMap(({ replay }) => {
        if (replay) {
          res.status(replay.status_code!);
          res.setHeader("Idempotent-Replay", "true");
          return of(replay.response_body);
        }
        return next.handle().pipe(
          tap(async (body) => {
            await db.idempotencyRecord.update({
              where: { user_id_key_route: { user_id: userId, key, route } },
              data: { status_code: res.statusCode ?? 200, response_body: toJSONSafe(body ?? null) as any },
            });
          }),
          catchError((err) => {
            // Failed requests may be retried with the same key.
            return from(db.idempotencyRecord.delete({ where: { user_id_key_route: { user_id: userId, key, route } } }).catch(() => null)).pipe(
              switchMap(() => throwError(() => err)),
            );
          }),
        );
      }),
    );
  }
}
