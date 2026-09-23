import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

/** Inspection and manual replay of deliveries that exhausted their retries. */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('failed')
  async listFailed(@Query('limit') limit?: string) {
    const parsed = Number(limit);
    const take = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    const items = await this.webhooks.listFailed(take);
    return { items, count: items.length };
  }

  @Post('failed/:id/retry')
  retry(@Param('id') id: string) {
    return this.webhooks.retryFailed(id);
  }
}
