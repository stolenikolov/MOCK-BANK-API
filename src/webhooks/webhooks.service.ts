import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { PrismaService } from '../common/prisma.service';
import { ApiError } from '../common/errors';
import type { WebhookEvent } from './webhook.types';

const DEFAULT_BACKOFF_MS = [2000, 10000, 30000];

@Injectable()
export class WebhooksService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  private shuttingDown = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleDestroy(): void {
    this.shuttingDown = true;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  /**
   * Fire-and-forget: the request that triggered the event must not wait on
   * BiznisMk being reachable. Exhausted retries land in the FailedWebhook table.
   *
   * waitUntil keeps a Vercel function alive until delivery is settled; it would
   * otherwise be frozen as soon as it answered. Off Vercel it does nothing.
   */
  dispatch(event: WebhookEvent): void {
    waitUntil(
      this.deliverWithRetries(event).catch((error) => {
        this.logger.error('Webhook dispatch crashed: ' + describe(error));
      }),
    );
  }

  /** Sign a JSON body exactly the way BiznisMk must verify it. */
  sign(body: string): string {
    const secret = this.config.get<string>('WEBHOOK_SIGNING_SECRET') ?? '';
    return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  }

  async listFailed(limit = 50) {
    return this.prisma.failedWebhook.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** Manual replay of a stored failure, through the same retry ladder. */
  async retryFailed(id: string): Promise<{ id: string; delivered: boolean; lastError?: string }> {
    const failed = await this.prisma.failedWebhook.findUnique({ where: { id } });
    if (!failed) {
      throw ApiError.notFound('WEBHOOK_NOT_FOUND', 'No failed webhook with id ' + id);
    }

    const event = failed.payload as unknown as WebhookEvent;
    const result = await this.attemptWithRetries(event);

    if (result.delivered) {
      await this.prisma.failedWebhook.delete({ where: { id } });
      return { id, delivered: true };
    }

    await this.prisma.failedWebhook.update({
      where: { id },
      data: {
        attempts: { increment: result.attempts },
        lastError: result.lastError ?? 'Unknown error',
      },
    });
    return { id, delivered: false, lastError: result.lastError };
  }

  /**
   * The scheduled replay (Vercel Cron, where no process keeps retry timers):
   * one attempt per stored failure, oldest first, so events reach BiznisMk in
   * the order they happened. Delivered ones are removed; the rest stay for the
   * next run. Stops before `budgetMs` so the function is not cut off mid-write.
   */
  async replayFailed(budgetMs = 45_000): Promise<{ delivered: number; stillFailing: number }> {
    const url = this.config.get<string>('BIZNISMK_WEBHOOK_URL');
    if (!url) return { delivered: 0, stillFailing: await this.prisma.failedWebhook.count() };

    const started = Date.now();
    const failures = await this.prisma.failedWebhook.findMany({ orderBy: { createdAt: 'asc' }, take: 50 });
    let delivered = 0;

    for (const failure of failures) {
      if (Date.now() - started > budgetMs) break;
      try {
        await this.post(url, failure.payload as unknown as WebhookEvent);
        await this.prisma.failedWebhook.delete({ where: { id: failure.id } });
        delivered += 1;
      } catch (error) {
        await this.prisma.failedWebhook.update({
          where: { id: failure.id },
          data: { attempts: { increment: 1 }, lastError: describe(error) },
        });
      }
    }

    return { delivered, stillFailing: await this.prisma.failedWebhook.count() };
  }

  private async deliverWithRetries(event: WebhookEvent): Promise<void> {
    const result = await this.attemptWithRetries(event);
    if (result.delivered) return;

    this.logger.error(
      'Webhook ' + event.eventType + ' FAILED after ' + result.attempts + ' attempts: ' + result.lastError,
    );

    await this.prisma.failedWebhook.create({
      data: {
        eventType: event.eventType,
        payload: event as unknown as object,
        lastError: result.lastError ?? 'Unknown error',
        attempts: result.attempts,
      },
    });
  }

  private async attemptWithRetries(
    event: WebhookEvent,
  ): Promise<{ delivered: boolean; attempts: number; lastError?: string }> {
    const url = this.config.get<string>('BIZNISMK_WEBHOOK_URL');
    if (!url) {
      this.logger.warn('BIZNISMK_WEBHOOK_URL is not set - storing event as failed');
      return { delivered: false, attempts: 0, lastError: 'BIZNISMK_WEBHOOK_URL is not configured' };
    }

    const backoff = this.backoffLadder();
    let attempts = 0;
    let lastError: string | undefined;

    for (let i = 0; i <= backoff.length; i += 1) {
      if (this.shuttingDown) break;
      attempts += 1;

      try {
        await this.post(url, event);
        this.logger.log('Webhook ' + event.eventType + ' delivered on attempt ' + attempts);
        return { delivered: true, attempts };
      } catch (error) {
        lastError = describe(error);
        this.logger.warn(
          'Webhook ' + event.eventType + ' attempt ' + attempts + ' failed: ' + lastError,
        );
      }

      if (i < backoff.length) await this.sleep(backoff[i]);
    }

    return { delivered: false, attempts, lastError };
  }

  private async post(url: string, event: WebhookEvent): Promise<void> {
    const body = JSON.stringify(event);
    const timeoutMs = Number(this.config.get<string>('WEBHOOK_TIMEOUT_MS') ?? 8000);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': this.sign(body),
        'X-Event-Type': event.eventType,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error('HTTP ' + response.status + ' ' + response.statusText + ' ' + text.slice(0, 200));
    }
  }

  private backoffLadder(): number[] {
    const raw = this.config.get<string>('WEBHOOK_RETRY_BACKOFF_MS');
    if (!raw) return DEFAULT_BACKOFF_MS;

    const parsed = raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0);

    return parsed.length > 0 ? parsed : DEFAULT_BACKOFF_MS;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        resolve();
      }, ms);
      this.pendingTimers.add(timer);
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name + ': ' + error.message;
  return String(error);
}
