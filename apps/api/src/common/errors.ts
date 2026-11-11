import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { redact } from "./redact";

/** Business-rule failure with a stable machine-readable code. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = HttpStatus.UNPROCESSABLE_ENTITY,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = (what: string) => new DomainError("NOT_FOUND", `${what} not found`, HttpStatus.NOT_FOUND);
export const forbidden = (msg = "You do not have permission to perform this action") => new DomainError("FORBIDDEN", msg, HttpStatus.FORBIDDEN);
export const conflict = (code: string, msg: string, details?: unknown) => new DomainError(code, msg, HttpStatus.CONFLICT, details);
export const invalid = (code: string, msg: string, details?: unknown) => new DomainError(code, msg, HttpStatus.UNPROCESSABLE_ENTITY, details);

/** Thrown when the request is valid but needs an approval first; the UI opens the supervisor dialog. */
export class ApprovalRequiredError extends DomainError {
  constructor(type: string, message: string, details: Record<string, unknown>) {
    super("APPROVAL_REQUIRED", message, 409, { approval_type: type, ...details });
  }
}

/** Pluggable error reporter (wire Sentry or similar here; default logs). */
export const errorReporter = {
  report(err: unknown, context: Record<string, unknown>) {
    Logger.error(`${(err as Error)?.message ?? err} ${JSON.stringify(redact(context))}`, (err as Error)?.stack, "ErrorReporter");
  },
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = req.requestId ?? randomUUID();
    let status = 500;
    let body: { code: string; message: string; details?: unknown };

    const e = exception as any;
    if (exception instanceof DomainError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      const message = Array.isArray(r?.message) ? "Validation failed" : (r?.message ?? exception.message);
      body = {
        code: status === 400 ? "VALIDATION_FAILED" : status === 429 ? "RATE_LIMITED" : (r?.error ?? "HTTP_ERROR").toUpperCase().replace(/\s+/g, "_"),
        message,
        details: Array.isArray(r?.message) ? r.message : undefined,
      };
    } else if (e?.code === "P2002") {
      status = 409;
      body = { code: "DUPLICATE", message: "A record with the same unique value already exists", details: e.meta?.target ?? e.meta };
    } else if (e?.code === "P2025") {
      status = 404;
      body = { code: "NOT_FOUND", message: "Record not found" };
    } else if (e?.code === "P2034") {
      status = 409;
      body = { code: "CONCURRENT_UPDATE", message: "The record was changed by another transaction; please retry" };
    } else if (/check_violation|restrict_violation|23514|unbalanced|immutable|append-only|closed/i.test(String(e?.message ?? "")) && e?.name !== "TypeError") {
      status = 422;
      body = { code: "INTEGRITY_RULE", message: String(e.message).split("\n").pop()!.slice(0, 300) };
    } else {
      errorReporter.report(exception, { path: req.url, method: req.method, requestId });
      body = { code: "INTERNAL_ERROR", message: "An unexpected error occurred" };
    }
    res.status(status).json({ error: body, requestId });
  }
}
