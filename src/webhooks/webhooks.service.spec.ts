import { createHmac } from 'node:crypto';
import { WebhooksService } from './webhooks.service';
import type { TransactionCreatedEvent } from './webhook.types';

const CONFIG: Record<string, string> = {
  BIZNISMK_WEBHOOK_URL: 'https://biznismk.test/webhooks/bank',
  WEBHOOK_SIGNING_SECRET: 'test-secret',
  WEBHOOK_TIMEOUT_MS: '1000',
  // No waiting between retries in tests.
  WEBHOOK_RETRY_BACKOFF_MS: '0,0,0',
};

const event: TransactionCreatedEvent = {
  eventType: 'TRANSACTION_CREATED',
  iban: 'MK07300000000042425',
  companyId: 'company-03',
  currency: 'MKD',
  newBalance: 1500,
  transactions: [
    {
      id: 'tx-1',
      type: 'CREDIT',
      amount: 500,
      currency: 'MKD',
      description: 'Simulated deposit',
      balanceAfter: 1500,
      createdAt: '2026-09-14T10:00:00.000Z',
    },
  ],
  timestamp: '2026-09-14T10:00:00.000Z',
};

function buildService() {
  const failedWebhook = {
    create: jest.fn().mockResolvedValue({ id: 'fw-1' }),
    findUnique: jest.fn(),
    delete: jest.fn().mockResolvedValue({ id: 'fw-1' }),
    update: jest.fn().mockResolvedValue({ id: 'fw-1' }),
    findMany: jest.fn().mockResolvedValue([]),
  };

  const config = { get: (key: string) => CONFIG[key] };
  const prisma = { failedWebhook };
  const service = new WebhooksService(config as never, prisma as never);

  return { service, failedWebhook };
}

describe('WebhooksService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('signs the body with HMAC-SHA256 hex, the way BiznisMk must verify it', () => {
    const { service } = buildService();
    const body = JSON.stringify(event);

    const expected = createHmac('sha256', 'test-secret').update(body, 'utf8').digest('hex');

    expect(service.sign(body)).toBe(expected);
    expect(service.sign(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('delivers once, sends the signature header, and stores nothing', async () => {
    const { service, failedWebhook } = buildService();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    service.dispatch(event);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;

    expect(url).toBe(CONFIG.BIZNISMK_WEBHOOK_URL);
    expect(headers['X-Signature']).toBe(service.sign(init?.body as string));
    expect(headers['X-Event-Type']).toBe('TRANSACTION_CREATED');
    expect(failedWebhook.create).not.toHaveBeenCalled();
  });

  it('retries three times after a failure and then stores the event', async () => {
    const { service, failedWebhook } = buildService();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 500, statusText: 'Server Error' }));

    service.dispatch(event);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(4); // first attempt + 3 retries
    expect(failedWebhook.create).toHaveBeenCalledTimes(1);

    const stored = failedWebhook.create.mock.calls[0][0].data;
    expect(stored.eventType).toBe('TRANSACTION_CREATED');
    expect(stored.attempts).toBe(4);
    expect(stored.lastError).toContain('500');
    expect(stored.payload).toEqual(event);
  });

  it('stops retrying as soon as one attempt succeeds', async () => {
    const { service, failedWebhook } = buildService();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('nope', { status: 502, statusText: 'Bad Gateway' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    service.dispatch(event);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failedWebhook.create).not.toHaveBeenCalled();
  });

  it('drops the stored failure once a manual retry gets through', async () => {
    const { service, failedWebhook } = buildService();
    failedWebhook.findUnique.mockResolvedValue({ id: 'fw-1', payload: event });
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await expect(service.retryFailed('fw-1')).resolves.toEqual({ id: 'fw-1', delivered: true });
    expect(failedWebhook.delete).toHaveBeenCalledWith({ where: { id: 'fw-1' } });
  });

  it('keeps the stored failure and counts the attempts when a manual retry fails', async () => {
    const { service, failedWebhook } = buildService();
    failedWebhook.findUnique.mockResolvedValue({ id: 'fw-1', payload: event });
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await service.retryFailed('fw-1');

    expect(result.delivered).toBe(false);
    expect(failedWebhook.delete).not.toHaveBeenCalled();
    expect(failedWebhook.update).toHaveBeenCalledWith({
      where: { id: 'fw-1' },
      data: { attempts: { increment: 4 }, lastError: 'Error: connect ECONNREFUSED' },
    });
  });

  it('reports a missing failed webhook as 404 WEBHOOK_NOT_FOUND', async () => {
    const { service, failedWebhook } = buildService();
    failedWebhook.findUnique.mockResolvedValue(null);

    await expect(service.retryFailed('missing')).rejects.toMatchObject({
      errorCode: 'WEBHOOK_NOT_FOUND',
    });
  });
});

/** Lets the fire-and-forget dispatch chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
