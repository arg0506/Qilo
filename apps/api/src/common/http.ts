import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { AppError, toErrorBody, type ErrorCode } from "./errors.ts";

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers["x-request-id"];
  const id = typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  (req as Request & { id?: string }).id = id;
  res.setHeader("x-request-id", id);
  next();
}

const HTTP_TO_CODE: Record<number, ErrorCode> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  413: "VALIDATION_ERROR",
  429: "RATE_LIMITED",
};

// Every error leaves the API in one envelope (spec 11.2):
// { "error": { "code", "message", "requestId" } }
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();
    let err = exception;
    if (exception instanceof HttpException && !(exception instanceof AppError)) {
      const status = exception.getStatus();
      err = new AppError(HTTP_TO_CODE[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "VALIDATION_ERROR"), status === 404 ? "Not found." : exception.message);
    } else if ((exception as { type?: string })?.type === "entity.parse.failed") {
      err = new AppError("VALIDATION_ERROR", "The request body is not valid JSON.");
    } else if ((exception as { type?: string })?.type === "entity.too.large") {
      err = new AppError("VALIDATION_ERROR", "The request body is too large.");
    }
    const { status, body } = toErrorBody(err, req.id);
    if (status >= 500) this.log.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    res.status(status).json({ error: body });
  }
}
