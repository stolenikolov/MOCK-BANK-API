import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** Normalizes every thrown error into { errorCode, message, ... }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const body = this.toBody(exception, status);

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} -> ${status} ${body.errorCode}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${request.method} ${request.originalUrl} -> ${status} ${body.errorCode}`);
    }

    response.status(status).json(body);
  }

  private toBody(exception: unknown, status: number): { errorCode: string; message: string } & Record<string, unknown> {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();

      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;

        // Already in our shape.
        if (typeof record.errorCode === 'string') {
          return record as { errorCode: string; message: string };
        }

        // class-validator / built-in Nest exceptions: { statusCode, message, error }
        const message = Array.isArray(record.message)
          ? (record.message as string[]).join('; ')
          : String(record.message ?? exception.message);

        return {
          errorCode: defaultErrorCode(status),
          message,
          ...(Array.isArray(record.message) ? { validationErrors: record.message } : {}),
        };
      }

      return { errorCode: defaultErrorCode(status), message: String(payload) };
    }

    return {
      errorCode: 'INTERNAL_ERROR',
      message: exception instanceof Error ? exception.message : 'Unexpected error',
    };
  }
}

function defaultErrorCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'UNPROCESSABLE_ENTITY';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  }
}
