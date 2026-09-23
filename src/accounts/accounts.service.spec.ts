import { Prisma } from '@prisma/client';
import { AccountsService } from './accounts.service';

const IBAN = 'MK07300000000042425';
const OWNER = 'Столе Николов';

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc-a',
    bankId: 'bank-300',
    iban: IBAN,
    companyId: 'company-03',
    holderName: 'Test DOO',
    currency: 'MKD',
    balance: new Prisma.Decimal('100000'),
    status: 'ACTIVE',
    accountType: 'TRANSACTION',
    lastSyncedAt: new Date('2026-09-14T09:00:00.000Z'),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-14T09:00:00.000Z'),
    bank: { name: 'Комерцијална банка АД Скопје', code: '300' },
    creditLine: null,
    ...overrides,
  };
}

function buildService(found: ReturnType<typeof account> | null) {
  const tx = {
    transaction: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'tx-1',
          createdAt: new Date('2026-09-14T10:00:00.000Z'),
          ...data,
        }),
      ),
    },
    account: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...account(), ...data }),
      ),
    },
    creditLine: {
      upsert: jest.fn(({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ id: 'cl-1', createdAt: new Date(), updatedAt: new Date(), ...create }),
      ),
    },
  };

  const prisma = {
    account: {
      findUnique: jest.fn().mockResolvedValue(found),
      findMany: jest.fn().mockResolvedValue(found ? [found] : []),
      count: jest.fn().mockResolvedValue(found ? 1 : 0),
      update: jest.fn().mockResolvedValue(found),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    transaction: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((cb: (client: typeof tx) => unknown) => cb(tx)),
  };

  const webhooks = { dispatch: jest.fn() };
  const service = new AccountsService(prisma as never, webhooks as never);

  return { service, prisma, tx, webhooks };
}

describe('AccountsService.verify', () => {
  it('returns the bank identity so BiznisMk can apply its own per-bank rule', async () => {
    const { service } = buildService(account());

    await expect(service.verify(IBAN)).resolves.toEqual({
      exists: true,
      iban: IBAN,
      bankName: 'Комерцијална банка АД Скопје',
      bankCode: '300',
      accountHolderName: 'Test DOO',
      status: 'ACTIVE',
      currency: 'MKD',
      companyId: 'company-03',
      linkStatus: 'NOT_REQUESTED',
    });
  });

  it('answers, rather than throws, for an unknown account', async () => {
    const { service } = buildService(null);

    await expect(service.verify(IBAN)).resolves.toEqual({
      exists: false,
      errorCode: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('reports a malformed IBAN without hitting the database', async () => {
    const { service, prisma } = buildService(null);

    await expect(service.verify('MK123')).resolves.toEqual({
      exists: false,
      errorCode: 'INVALID_IBAN_FORMAT',
    });
    expect(prisma.account.findUnique).not.toHaveBeenCalled();
  });

  it('tolerates spaces and lower case', async () => {
    const { service, prisma } = buildService(account());

    await service.verify('mk07 3000 0000 0042 425');

    expect(prisma.account.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { iban: IBAN } }),
    );
  });
});

describe('AccountsService.deposit', () => {
  it('credits the balance and fires a TRANSACTION_CREATED webhook', async () => {
    const { service, tx, webhooks } = buildService(account());

    const result = await service.deposit(IBAN, { amount: 50000, description: 'Уплата' });

    expect(result.newBalance).toBe(150000);
    expect(result.transaction).toMatchObject({ type: 'CREDIT', amount: 50000, balanceAfter: 150000 });
    expect(new Prisma.Decimal(tx.account.update.mock.calls[0][0].data.balance as never).toNumber()).toBe(
      150000,
    );

    expect(webhooks.dispatch).toHaveBeenCalledTimes(1);
    const event = webhooks.dispatch.mock.calls[0][0];
    expect(event).toMatchObject({ eventType: 'TRANSACTION_CREATED', iban: IBAN, newBalance: 150000 });
    expect(event.transactions).toHaveLength(1);
  });

  it('refuses to touch a blocked account', async () => {
    const { service, webhooks } = buildService(account({ status: 'BLOCKED' }));

    await expect(service.deposit(IBAN, { amount: 1000 })).rejects.toMatchObject({
      errorCode: 'ACCOUNT_NOT_ACTIVE',
      status: 409,
    });
    expect(webhooks.dispatch).not.toHaveBeenCalled();
  });

  it('404s on an unknown account', async () => {
    const { service } = buildService(null);

    await expect(service.deposit(IBAN, { amount: 1000 })).rejects.toMatchObject({
      errorCode: 'ACCOUNT_NOT_FOUND',
      status: 404,
    });
  });
});

describe('AccountsService.withdraw', () => {
  it('debits the balance and fires a webhook', async () => {
    const { service, webhooks } = buildService(account());

    const result = await service.withdraw(IBAN, { amount: 12000 });

    expect(result.newBalance).toBe(88000);
    expect(result.transaction).toMatchObject({ type: 'DEBIT', amount: 12000, balanceAfter: 88000 });
    expect(webhooks.dispatch).toHaveBeenCalledTimes(1);
  });

  it('409s with the current balance when funds are short', async () => {
    const { service, tx, webhooks } = buildService(account({ balance: new Prisma.Decimal('500') }));

    await expect(service.withdraw(IBAN, { amount: 1000 })).rejects.toMatchObject({
      errorCode: 'INSUFFICIENT_FUNDS',
      status: 409,
      response: { balance: 500, requested: 1000, currency: 'MKD' },
    });

    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(webhooks.dispatch).not.toHaveBeenCalled();
  });

  it('allows withdrawing the exact balance', async () => {
    const { service } = buildService(account({ balance: new Prisma.Decimal('1000') }));

    await expect(service.withdraw(IBAN, { amount: 1000 })).resolves.toMatchObject({
      newBalance: 0,
    });
  });
});

describe('AccountsService.loan', () => {
  it('opens the credit line and credits the principal', async () => {
    const { service, tx, webhooks } = buildService(account());

    const result = await service.loan(IBAN, { amount: 600000, totalInstallments: 24 });

    expect(result.newBalance).toBe(700000);
    expect(result.transaction).toMatchObject({ type: 'CREDIT', amount: 600000 });
    expect(result.creditLine).toMatchObject({
      creditAmount: 600000,
      remainingBalance: 600000,
      installmentAmount: 25000,
      totalInstallments: 24,
      installmentsPaid: 0,
    });

    // nextPaymentDate is one month out.
    const next = new Date(result.creditLine?.nextPaymentDate as string);
    expect(next.getTime()).toBeGreaterThan(Date.now());

    expect(tx.creditLine.upsert).toHaveBeenCalledTimes(1);
    expect(webhooks.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rounds the installment to two decimals', async () => {
    const { service } = buildService(account());

    const result = await service.loan(IBAN, { amount: 1000, totalInstallments: 3 });

    expect(result.creditLine?.installmentAmount).toBe(333.33);
  });
});

describe('AccountsService.verify — claiming the account', () => {
  it('gives a free account to the first company that verifies it', async () => {
    const { service, prisma } = buildService(account({ companyId: null }));

    const result = await service.verify(IBAN, 'company-07', OWNER);

    expect(result).toMatchObject({
      exists: true,
      companyId: 'company-07',
      accountHolderName: OWNER,
      linkStatus: 'CLAIMED',
    });
    // Conditional update: it only matches while the account is still free.
    expect(prisma.account.updateMany).toHaveBeenCalledWith({
      where: { id: 'acc-a', companyId: null },
      data: expect.objectContaining({ companyId: 'company-07', holderName: OWNER }),
    });
  });

  it('is idempotent when the same company verifies again', async () => {
    const { service, prisma } = buildService(account({ companyId: 'company-07' }));

    const result = await service.verify(IBAN, 'company-07', OWNER);

    expect(result).toMatchObject({ linkStatus: 'ALREADY_YOURS', companyId: 'company-07' });
    expect(prisma.account.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an account another company already took', async () => {
    const { service, prisma } = buildService(account({ companyId: 'company-01' }));

    await expect(service.verify(IBAN, 'company-07', OWNER)).rejects.toMatchObject({
      errorCode: 'ACCOUNT_ALREADY_LINKED',
      status: 409,
      response: { companyId: 'company-01' },
    });
    expect(prisma.account.updateMany).not.toHaveBeenCalled();
  });

  it('loses the race gracefully when another company claims it first', async () => {
    const { service, prisma } = buildService(account({ companyId: null }));
    // The row was free when we read it, but not by the time we wrote.
    prisma.account.updateMany.mockResolvedValue({ count: 0 });
    prisma.account.findUnique.mockResolvedValueOnce(account({ companyId: null }));
    prisma.account.findUnique.mockResolvedValueOnce({ companyId: 'company-02' });

    await expect(service.verify(IBAN, 'company-07', OWNER)).rejects.toMatchObject({
      errorCode: 'ACCOUNT_ALREADY_LINKED',
      status: 409,
      response: { companyId: 'company-02' },
    });
  });

  it('treats a lost race against itself as success', async () => {
    const { service, prisma } = buildService(account({ companyId: null }));
    prisma.account.updateMany.mockResolvedValue({ count: 0 });
    prisma.account.findUnique.mockResolvedValueOnce(account({ companyId: null }));
    prisma.account.findUnique.mockResolvedValueOnce({ companyId: 'company-07' });

    await expect(service.verify(IBAN, 'company-07', OWNER)).resolves.toMatchObject({
      linkStatus: 'ALREADY_YOURS',
    });
  });

  it('will not link a closed account', async () => {
    const { service } = buildService(account({ companyId: null, status: 'CLOSED' }));

    await expect(service.verify(IBAN, 'company-07', OWNER)).rejects.toMatchObject({
      errorCode: 'ACCOUNT_CLOSED',
      status: 409,
    });
  });

  it('links a blocked account, so the blocked state can be shown in the app', async () => {
    const { service } = buildService(account({ companyId: null, status: 'BLOCKED' }));

    await expect(service.verify(IBAN, 'company-07', OWNER)).resolves.toMatchObject({
      linkStatus: 'CLAIMED',
      status: 'BLOCKED',
    });
  });

  it('stays a pure lookup when no company is supplied', async () => {
    const { service, prisma } = buildService(account({ companyId: null }));

    const result = await service.verify(IBAN);

    expect(result).toMatchObject({ linkStatus: 'NOT_REQUESTED', companyId: null });
    expect(prisma.account.updateMany).not.toHaveBeenCalled();
  });

  it('does not claim anything for an unknown IBAN', async () => {
    const { service, prisma } = buildService(null);

    await expect(service.verify(IBAN, 'company-07', OWNER)).resolves.toEqual({
      exists: false,
      errorCode: 'ACCOUNT_NOT_FOUND',
    });
    expect(prisma.account.updateMany).not.toHaveBeenCalled();
  });
});

describe('AccountsService.unlink', () => {
  it('releases the account so another company can take it', async () => {
    const { service, prisma } = buildService(account({ companyId: 'company-07' }));

    await expect(service.unlink(IBAN, 'company-07')).resolves.toMatchObject({
      companyId: null,
      linkStatus: 'RELEASED',
    });
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: 'acc-a' },
      data: expect.objectContaining({ companyId: null }),
    });
  });

  it('refuses to release an account that belongs to another company', async () => {
    const { service, prisma } = buildService(account({ companyId: 'company-01' }));

    await expect(service.unlink(IBAN, 'company-07')).rejects.toMatchObject({
      errorCode: 'ACCOUNT_ALREADY_LINKED',
      status: 409,
    });
    expect(prisma.account.update).not.toHaveBeenCalled();
  });

  it('is a no-op on an already free account', async () => {
    const { service, prisma } = buildService(account({ companyId: null }));

    await expect(service.unlink(IBAN)).resolves.toMatchObject({ linkStatus: 'ALREADY_FREE' });
    expect(prisma.account.update).not.toHaveBeenCalled();
  });
});

describe('AccountsService.list', () => {
  it('filters by bank, status, currency and company, richest first', async () => {
    const { service, prisma } = buildService(account());

    const result = await service.list({
      bankCode: '300',
      status: 'ACTIVE',
      currency: 'MKD',
      companyId: 'company-03',
      limit: 5,
    });

    expect(prisma.account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          bank: { code: '300' },
          status: 'ACTIVE',
          currency: 'MKD',
          companyId: 'company-03',
        },
        orderBy: [{ balance: 'desc' }, { iban: 'asc' }],
        take: 5,
        skip: 0,
      }),
    );
    expect(result.items[0]).toMatchObject({ iban: IBAN, bankCode: '300', balance: 100000 });
    expect(result.total).toBe(1);
  });

  it('can list only the accounts no company has claimed', async () => {
    const { service, prisma } = buildService(account({ companyId: null }));

    await service.list({ unclaimed: 'true' });

    expect(prisma.account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: null } }),
    );
  });

  it('caps the page size at 200', async () => {
    const { service, prisma } = buildService(account());

    await service.list({ limit: 500 });

    expect(prisma.account.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
  });
});

describe('AccountsService.listTransactions', () => {
  it('returns a page plus a cursor when more rows exist', async () => {
    const { service, prisma } = buildService(account());
    prisma.transaction.findMany.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        id: 'tx-' + i,
        accountId: 'acc-a',
        type: 'CREDIT',
        amount: new Prisma.Decimal('100'),
        currency: 'MKD',
        description: 'test',
        balanceAfter: new Prisma.Decimal('100'),
        createdAt: new Date('2026-09-14T10:00:00.000Z'),
      })),
    );

    const page = await service.listTransactions(IBAN, 2);

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('tx-1');
  });

  it('reports the end of the list', async () => {
    const { service, prisma } = buildService(account());
    prisma.transaction.findMany.mockResolvedValue([]);

    const page = await service.listTransactions(IBAN, 10);

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe('AccountsService — an account is in a name only while it is held', () => {
  it('reports a free account as being in nobody name', async () => {
    const { service } = buildService(account({ companyId: null, holderName: null }));

    await expect(service.verify(IBAN)).resolves.toMatchObject({
      exists: true,
      companyId: null,
      accountHolderName: null,
      linkStatus: 'NOT_REQUESTED',
    });
  });

  it('puts the account in the owner name when a company claims it', async () => {
    const { service, prisma } = buildService(account({ companyId: null, holderName: null }));

    const result = await service.verify(IBAN, 'company-07', OWNER);

    expect(result).toMatchObject({ accountHolderName: OWNER, linkStatus: 'CLAIMED' });
    expect(prisma.account.updateMany).toHaveBeenCalledWith({
      where: { id: 'acc-a', companyId: null },
      data: expect.objectContaining({ companyId: 'company-07', holderName: OWNER }),
    });
  });

  it('refuses to claim without the owner name, rather than leaving it nameless', async () => {
    const { service, prisma } = buildService(account({ companyId: null, holderName: null }));

    await expect(service.verify(IBAN, 'company-07')).rejects.toMatchObject({
      errorCode: 'HOLDER_NAME_REQUIRED',
      status: 400,
    });
    expect(prisma.account.updateMany).not.toHaveBeenCalled();
  });

  it('treats a blank owner name as no name at all', async () => {
    const { service } = buildService(account({ companyId: null, holderName: null }));

    await expect(service.verify(IBAN, 'company-07', '   ')).rejects.toMatchObject({
      errorCode: 'HOLDER_NAME_REQUIRED',
    });
  });

  it('trims the stored owner name', async () => {
    const { service, prisma } = buildService(account({ companyId: null, holderName: null }));

    await service.verify(IBAN, 'company-07', '  Столе Николов  ');

    expect(prisma.account.updateMany.mock.calls[0][0].data.holderName).toBe(OWNER);
  });

  it('keeps the existing name when the same company verifies again', async () => {
    const { service, prisma } = buildService(account({ companyId: 'company-07', holderName: OWNER }));

    await expect(service.verify(IBAN, 'company-07')).resolves.toMatchObject({
      accountHolderName: OWNER,
      linkStatus: 'ALREADY_YOURS',
    });
    expect(prisma.account.updateMany).not.toHaveBeenCalled();
  });

  it('clears the name when the account is released', async () => {
    const { service, prisma } = buildService(account({ companyId: 'company-07', holderName: OWNER }));

    await expect(service.unlink(IBAN, 'company-07')).resolves.toMatchObject({
      companyId: null,
      accountHolderName: null,
      linkStatus: 'RELEASED',
    });
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: 'acc-a' },
      data: expect.objectContaining({ companyId: null, holderName: null }),
    });
  });
});
