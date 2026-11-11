import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { map, Observable } from "rxjs";
import { toJSONSafe } from "./money";

/** Ensures Decimal values leave the API as exact strings. */
@Injectable()
export class DecimalSerializerInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => (body === undefined || Buffer.isBuffer(body) ? body : toJSONSafe(body))));
  }
}
