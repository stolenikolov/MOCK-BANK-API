import { HttpException, HttpStatus } from '@nestjs/common';

/** Every error leaving this service serializes as { errorCode, message, ...details }. */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly errorCode: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super({ errorCode, message, ...(details ?? {}) }, status);
  }

  static badRequest(errorCode: string, message: string, details?: Record<string, unknown>) {
    return new ApiError(HttpStatus.BAD_REQUEST, errorCode, message, details);
  }

  static unauthorized(message = 'Missing or invalid API key') {
    return new ApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', message);
  }

  static notFound(errorCode: string, message: string, details?: Record<string, unknown>) {
    return new ApiError(HttpStatus.NOT_FOUND, errorCode, message, details);
  }

  static conflict(errorCode: string, message: string, details?: Record<string, unknown>) {
    return new ApiError(HttpStatus.CONFLICT, errorCode, message, details);
  }

  static unprocessable(errorCode: string, message: string, details?: Record<string, unknown>) {
    return new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, errorCode, message, details);
  }
}
