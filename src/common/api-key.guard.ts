import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ApiError } from './errors';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const expected = this.config.get<string>('API_KEY');
    if (!expected) {
      this.logger.error('API_KEY is not configured — refusing all requests');
      throw ApiError.unauthorized('Service is misconfigured: API_KEY is not set');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.header('x-api-key') ?? this.bearerToken(request);
    if (!header || !safeEqual(header, expected)) {
      throw ApiError.unauthorized();
    }
    return true;
  }

  private bearerToken(request: Request): string | undefined {
    const auth = request.header('authorization');
    if (!auth?.toLowerCase().startsWith('bearer ')) return undefined;
    return auth.slice(7).trim();
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
