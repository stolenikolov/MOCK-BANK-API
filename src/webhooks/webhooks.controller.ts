import { Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { Public } from '../common/public.decorator';
import { ApiError } from '../common/errors';
import { isCronCaller } from '../common/cron-auth';

/** Inspection and manual replay of deliveries that exhausted their retries. */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly config: ConfigService,
  ) {}

  @Get('failed')
  async listFailed(@Query('limit') limit?: string) {
    const parsed = Number(limit);
    const take = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    const items = await this.webhooks.listFailed(take);
    return { items, count: items.length };
  }

  /**
   * The daily replay of stored failures, for Vercel Cron. Outside the API key
   * (Vercel cannot send one) and closed by CRON_SECRET instead.
   */
  @Public()
  @Get('failed/replay')
  replayFailed(@Headers('authorization') authorization?: string) {
    if (!isCronCaller(authorization, this.config.get<string>('CRON_SECRET'))) {
      throw ApiError.unauthorized('Missing or invalid cron secret');
    }
    return this.webhooks.replayFailed();
  }

  @Post('failed/:id/retry')
  retry(@Param('id') id: string) {
    return this.webhooks.retryFailed(id);
  }
}
