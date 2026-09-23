import { Prisma } from '@prisma/client';
import { PayrollService } from './payroll.service';

const IBAN_A = 'MK07300000000042425';
const IBAN_B = 'MK07210000000011111';

function account(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'acc-a',
    iban: IBAN_A,
    bankId: 'bank-300',
    companyId: 'company-03',
    holderName: 'Test DOO',
    currency: 'MKD',
    balance: new Prisma.Decimal('100000'),
    status: 'ACTIVE',
    accountType: 'TRANSACTION',
    ...overrides,
  };
}

function buildService(accounts: ReturnType<typeof account>[]) {
  const tx = {
    transaction: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'tx-' + Math.random().toString(16).slice(2),
          createdAt: new Date('2026-09-14T10:00:00.000Z'),
          ...data,
        }),
      ),
    },
    account: { update: jest.fn().mockResolvedValue({}) },
    payrollRequest: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'req-1', companyId: 'company-03', ...data }),
      ),
    },
  };

  const prisma = {
    account: { findMany: jest.fn().mockResolvedValue(accounts) },
    payrollRequest: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'req-1',
          createdAt: new Date('2026-09-14T09:00:00.000Z'),
          updatedAt: new Date('2026-09-14T09:00:00.000Z'),
          ...data,
        }),
      ),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn((cb: (client: typeof tx) => unknown) => cb(tx)),
  };

  const webhooks = { dispatch: jest.fn() };
  const service = new PayrollService(prisma as never, webhooks as never);

  return { service, prisma, tx, webhooks };
}

const payments = [
  { employeeId: 'emp-1', employeeName: 'Ана Стојанова', amount: 45000 },
  { employeeId: 'emp-2', employeeName: 'Марко Илиев', amount: 38000 },
];

describe('PayrollService.createRequest', () => {
  it('stores a PENDING_APPROVAL request with the computed allocation and moves no money', async () => {
    const { service, prisma, tx } = buildService([account()]);

    const result = await service.createRequest({
      companyId: 'company-03',
      payments,
      accounts: [IBAN_A],
    });

    expect(result.status).toBe('PENDING_APPROVAL');
    expect(result.requestId).toBe('req-1');
    expect(result.allocation).toHaveLength(2);
    expect(result.allocation.every((entry) => entry.iban === IBAN_A)).toBe(true);
    expect(result.accountTotals[0]).toMatchObject({ totalDebited: 83000, balanceAfter: 17000 });

    expect(prisma.payrollRequest.create).toHaveBeenCalledTimes(1);
    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(tx.account.update).not.toHaveBeenCalled();
  });

  it('rejects the whole run when no single account can cover an employee', async () => {
    const { service, prisma } = buildService([
      account({ balance: new Prisma.Decimal('50000') }),
      account({ id: 'acc-b', iban: IBAN_B, balance: new Prisma.Decimal('50000') }),
    ]);

    await expect(
      service.createRequest({
        companyId: 'company-03',
        payments: [{ employeeId: 'emp-1', employeeName: 'Ана', amount: 60000 }],
        accounts: [IBAN_A, IBAN_B],
      }),
    ).rejects.toMatchObject({
      errorCode: 'INSUFFICIENT_FUNDS',
      status: 422,
    });

    expect(prisma.payrollRequest.create).not.toHaveBeenCalled();
  });

  it('skips blocked accounts and reports them as ineligible', async () => {
    const { service } = buildService([
      account({ status: 'BLOCKED' }),
      account({ id: 'acc-b', iban: IBAN_B, balance: new Prisma.Decimal('200000') }),
    ]);

    const result = await service.createRequest({
      companyId: 'company-03',
      payments,
      accounts: [IBAN_A, IBAN_B],
    });

    expect(result.allocation.every((entry) => entry.iban === IBAN_B)).toBe(true);
    expect(result.ineligibleAccounts).toEqual([
      expect.objectContaining({ iban: IBAN_A, reason: 'ACCOUNT_BLOCKED' }),
    ]);
  });

  it('only uses accounts in the payroll currency', async () => {
    const { service } = buildService([account({ currency: 'EUR' })]);

    await expect(
      service.createRequest({ companyId: 'company-03', payments, accounts: [IBAN_A] }),
    ).rejects.toMatchObject({ errorCode: 'NO_ELIGIBLE_ACCOUNTS', status: 422 });
  });

  it('refuses malformed IBANs before touching the database', async () => {
    const { service, prisma } = buildService([]);

    await expect(
      service.createRequest({ companyId: 'company-03', payments, accounts: ['NOT-AN-IBAN'] }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_IBAN_FORMAT', status: 400 });

    expect(prisma.account.findMany).not.toHaveBeenCalled();
  });

  it('reports IBANs that do not exist at this bank', async () => {
    const { service } = buildService([]);

    await expect(
      service.createRequest({ companyId: 'company-03', payments, accounts: [IBAN_A] }),
    ).rejects.toMatchObject({ errorCode: 'ACCOUNT_NOT_FOUND', status: 404 });
  });
});

describe('PayrollService.approve', () => {
  const storedRequest = {
    id: 'req-1',
    companyId: 'company-03',
    status: 'PENDING_APPROVAL',
    payload: {},
    allocation: {
      currency: 'MKD',
      entries: [
        { employeeId: 'emp-1', employeeName: 'Ана Стојанова', amount: 45000, iban: IBAN_A },
        { employeeId: 'emp-2', employeeName: 'Марко Илиев', amount: 38000, iban: IBAN_A },
      ],
      accountTotals: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('debits each employee from the assigned account and completes the request', async () => {
    const { service, prisma, tx, webhooks } = buildService([account()]);
    prisma.payrollRequest.findUnique.mockResolvedValue(storedRequest);

    const result = await service.approve('req-1');

    expect(tx.transaction.create).toHaveBeenCalledTimes(2);
    const amounts = tx.transaction.create.mock.calls.map((call) => {
      const data = call[0].data as Record<string, Prisma.Decimal | string>;
      return {
        type: data.type,
        amount: new Prisma.Decimal(data.amount).toNumber(),
        balanceAfter: new Prisma.Decimal(data.balanceAfter).toNumber(),
      };
    });
    expect(amounts).toEqual([
      { type: 'DEBIT', amount: 45000, balanceAfter: 55000 },
      { type: 'DEBIT', amount: 38000, balanceAfter: 17000 },
    ]);

    // One balance write per touched account, not one per payment.
    expect(tx.account.update).toHaveBeenCalledTimes(1);
    expect(new Prisma.Decimal(tx.account.update.mock.calls[0][0].data.balance).toNumber()).toBe(17000);

    expect(tx.payrollRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { status: 'COMPLETED' },
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.accounts[0]).toMatchObject({ iban: IBAN_A, newBalance: 17000 });
  });

  it('fires exactly one batched PAYROLL_COMPLETED webhook for the run', async () => {
    const { service, prisma, webhooks } = buildService([account()]);
    prisma.payrollRequest.findUnique.mockResolvedValue(storedRequest);

    await service.approve('req-1');

    expect(webhooks.dispatch).toHaveBeenCalledTimes(1);
    const event = webhooks.dispatch.mock.calls[0][0];
    expect(event.eventType).toBe('PAYROLL_COMPLETED');
    expect(event.requestId).toBe('req-1');
    expect(event.ibans).toEqual([IBAN_A]);
    expect(event.transactions).toHaveLength(2);
    expect(event.accounts[0].newBalance).toBe(17000);
  });

  it('refuses to execute twice', async () => {
    const { service, prisma } = buildService([account()]);
    prisma.payrollRequest.findUnique.mockResolvedValue({ ...storedRequest, status: 'COMPLETED' });

    await expect(service.approve('req-1')).rejects.toMatchObject({
      errorCode: 'PAYROLL_REQUEST_NOT_PENDING',
      status: 409,
    });
  });

  it('fails if the balance dropped between preview and approval', async () => {
    const { service, prisma, tx, webhooks } = buildService([
      account({ balance: new Prisma.Decimal('50000') }),
    ]);
    prisma.payrollRequest.findUnique.mockResolvedValue(storedRequest);

    await expect(service.approve('req-1')).rejects.toMatchObject({
      errorCode: 'INSUFFICIENT_FUNDS',
      status: 409,
    });

    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(webhooks.dispatch).not.toHaveBeenCalled();
  });

  it('fails if the account was blocked between preview and approval', async () => {
    const { service, prisma } = buildService([account({ status: 'BLOCKED' })]);
    prisma.payrollRequest.findUnique.mockResolvedValue(storedRequest);

    await expect(service.approve('req-1')).rejects.toMatchObject({
      errorCode: 'ACCOUNT_NOT_ACTIVE',
      status: 409,
    });
  });

  it('404s on an unknown request id', async () => {
    const { service, prisma } = buildService([]);
    prisma.payrollRequest.findUnique.mockResolvedValue(null);

    await expect(service.approve('nope')).rejects.toMatchObject({
      errorCode: 'PAYROLL_REQUEST_NOT_FOUND',
      status: 404,
    });
  });
});

describe('PayrollService.reject', () => {
  it('marks the request REJECTED without moving money or firing a webhook', async () => {
    const { service, prisma, tx, webhooks } = buildService([account()]);
    prisma.payrollRequest.findUnique.mockResolvedValue({
      id: 'req-1',
      companyId: 'company-03',
      status: 'PENDING_APPROVAL',
      payload: {},
      allocation: { currency: 'MKD', entries: [], accountTotals: [] },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.payrollRequest.update.mockResolvedValue({
      id: 'req-1',
      companyId: 'company-03',
      status: 'REJECTED',
    });

    const result = await service.reject('req-1');

    expect(result.status).toBe('REJECTED');
    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(webhooks.dispatch).not.toHaveBeenCalled();
  });
});
