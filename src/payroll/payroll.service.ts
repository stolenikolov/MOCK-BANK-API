import { Injectable, Logger } from '@nestjs/common';
import { Account, PayrollStatus, Prisma, Transaction, TransactionType } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ApiError } from '../common/errors';
import { isValidMkIban, normalizeIban } from '../common/iban';
import { money, toNumber } from '../common/money';
import { serializeTransaction } from '../common/serializers';
import { WebhooksService } from '../webhooks/webhooks.service';
import { allocatePayroll, AccountTotal, AllocationEntry } from './allocation';
import { CreatePayrollRequestDto } from './dto/create-payroll-request.dto';

interface StoredAllocation {
  currency: string;
  entries: AllocationEntry[];
  accountTotals: AccountTotal[];
}

@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
  ) {}

  /**
   * Phase one: validate and compute the allocation. No money moves here - the
   * request is stored as PENDING_APPROVAL so BiznisMk can show a preview.
   */
  async createRequest(dto: CreatePayrollRequestDto) {
    const currency = dto.currency ?? 'MKD';
    const ibans = dedupe(dto.accounts.map(normalizeIban));

    const malformed = ibans.filter((iban) => !isValidMkIban(iban));
    if (malformed.length > 0) {
      throw ApiError.badRequest('INVALID_IBAN_FORMAT', 'One or more IBANs are malformed', {
        ibans: malformed,
      });
    }

    const accounts = await this.prisma.account.findMany({ where: { iban: { in: ibans } } });

    const found = new Set(accounts.map((account) => account.iban));
    const unknown = ibans.filter((iban) => !found.has(iban));
    if (unknown.length > 0) {
      throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'One or more accounts do not exist', {
        ibans: unknown,
      });
    }

    const eligible = accounts.filter(
      (account) => account.status === 'ACTIVE' && account.currency === currency,
    );
    const ineligible = accounts
      .filter((account) => !eligible.includes(account))
      .map((account) => ({
        iban: account.iban,
        reason: account.status !== 'ACTIVE' ? 'ACCOUNT_' + account.status : 'CURRENCY_MISMATCH',
        status: account.status,
        currency: account.currency,
      }));

    if (eligible.length === 0) {
      throw ApiError.unprocessable(
        'NO_ELIGIBLE_ACCOUNTS',
        'None of the supplied accounts are ACTIVE and in ' + currency,
        { currency, ineligible },
      );
    }

    const result = allocatePayroll(
      dto.payments,
      eligible.map((account) => ({
        iban: account.iban,
        balance: toNumber(account.balance),
        currency: account.currency,
      })),
    );

    if (!result.ok) {
      throw ApiError.unprocessable(
        'INSUFFICIENT_FUNDS',
        'No single account can cover these salaries in full',
        { currency, uncovered: result.uncovered, ineligible },
      );
    }

    const allocation: StoredAllocation = {
      currency,
      entries: result.allocation,
      accountTotals: result.accountTotals,
    };

    const request = await this.prisma.payrollRequest.create({
      data: {
        companyId: dto.companyId,
        status: PayrollStatus.PENDING_APPROVAL,
        payload: {
          companyId: dto.companyId,
          currency,
          payments: dto.payments,
          accounts: ibans,
          ineligibleAccounts: ineligible,
        } as unknown as Prisma.InputJsonValue,
        allocation: allocation as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      requestId: request.id,
      status: request.status,
      companyId: request.companyId,
      currency,
      allocation: result.allocation,
      accountTotals: result.accountTotals,
      ineligibleAccounts: ineligible,
      createdAt: request.createdAt.toISOString(),
    };
  }

  async getRequest(requestId: string) {
    const request = await this.requireRequest(requestId);
    const allocation = request.allocation as unknown as StoredAllocation;

    return {
      requestId: request.id,
      status: request.status,
      companyId: request.companyId,
      currency: allocation.currency,
      allocation: allocation.entries,
      accountTotals: allocation.accountTotals,
      payload: request.payload,
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
    };
  }

  /**
   * Phase two: execute the stored allocation. Balances are re-checked here
   * because they may have moved since the preview was computed.
   */
  async approve(requestId: string) {
    const request = await this.requirePendingRequest(requestId);
    const stored = request.allocation as unknown as StoredAllocation;
    const entries = stored.entries ?? [];

    const ibans = dedupe(entries.map((entry) => entry.iban));
    const accounts = await this.prisma.account.findMany({ where: { iban: { in: ibans } } });
    const byIban = new Map(accounts.map((account) => [account.iban, account]));

    this.assertStillExecutable(entries, byIban, stored.currency);

    const executed = await this.prisma.$transaction(async (tx) => {
      const created: Transaction[] = [];
      const balances = new Map<string, Prisma.Decimal>(
        accounts.map((account) => [account.iban, money(account.balance)]),
      );

      for (const entry of entries) {
        const account = byIban.get(entry.iban) as Account;
        const balanceAfter = (balances.get(entry.iban) as Prisma.Decimal).minus(money(entry.amount));
        balances.set(entry.iban, balanceAfter);

        created.push(
          await tx.transaction.create({
            data: {
              accountId: account.id,
              type: TransactionType.DEBIT,
              amount: money(entry.amount),
              currency: account.currency,
              description: 'Salary payment - ' + entry.employeeName,
              balanceAfter,
            },
          }),
        );
      }

      for (const [iban, balance] of balances) {
        const account = byIban.get(iban) as Account;
        await tx.account.update({
          where: { id: account.id },
          data: { balance, lastSyncedAt: new Date() },
        });
      }

      const updatedRequest = await tx.payrollRequest.update({
        where: { id: request.id },
        data: { status: PayrollStatus.COMPLETED },
      });

      return { transactions: created, balances, request: updatedRequest };
    });

    const perAccount = ibans.map((iban) => {
      const account = byIban.get(iban) as Account;
      return {
        iban,
        currency: account.currency,
        newBalance: toNumber(executed.balances.get(iban)),
        transactions: executed.transactions
          .filter((tx) => tx.accountId === account.id)
          .map(serializeTransaction),
      };
    });

    // One batched webhook for the whole run rather than one call per account.
    this.webhooks.dispatch({
      eventType: 'PAYROLL_COMPLETED',
      requestId: request.id,
      companyId: request.companyId,
      ibans,
      accounts: perAccount,
      transactions: perAccount.flatMap((entry) => entry.transactions),
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      'Payroll ' + request.id + ' completed: ' + entries.length + ' payments across ' + ibans.length + ' accounts',
    );

    return {
      requestId: request.id,
      status: executed.request.status,
      companyId: request.companyId,
      currency: stored.currency,
      accounts: perAccount,
      paymentCount: entries.length,
    };
  }

  async reject(requestId: string) {
    const request = await this.requirePendingRequest(requestId);

    const updated = await this.prisma.payrollRequest.update({
      where: { id: request.id },
      data: { status: PayrollStatus.REJECTED },
    });

    return {
      requestId: updated.id,
      status: updated.status,
      companyId: updated.companyId,
    };
  }

  /** Guards the gap between preview and approval: balances can have moved. */
  private assertStillExecutable(
    entries: AllocationEntry[],
    byIban: Map<string, Account>,
    currency: string,
  ): void {
    const remaining = new Map<string, Prisma.Decimal>();

    for (const entry of entries) {
      const account = byIban.get(entry.iban);

      if (!account) {
        throw ApiError.conflict('ACCOUNT_NOT_FOUND', 'Account ' + entry.iban + ' no longer exists', {
          iban: entry.iban,
        });
      }

      if (account.status !== 'ACTIVE') {
        throw ApiError.conflict(
          'ACCOUNT_NOT_ACTIVE',
          'Account ' + entry.iban + ' is ' + account.status,
          { iban: entry.iban, status: account.status },
        );
      }

      if (account.currency !== currency) {
        throw ApiError.conflict(
          'CURRENCY_MISMATCH',
          'Account ' + entry.iban + ' is no longer in ' + currency,
          { iban: entry.iban, currency: account.currency },
        );
      }

      const left = (remaining.get(entry.iban) ?? money(account.balance)).minus(money(entry.amount));

      if (left.isNegative()) {
        throw ApiError.conflict(
          'INSUFFICIENT_FUNDS',
          'Balance on ' + entry.iban + ' changed since the allocation was computed',
          {
            iban: entry.iban,
            balance: toNumber(account.balance),
            employeeId: entry.employeeId,
            requested: entry.amount,
          },
        );
      }

      remaining.set(entry.iban, left);
    }
  }

  private async requireRequest(requestId: string) {
    const request = await this.prisma.payrollRequest.findUnique({ where: { id: requestId } });

    if (!request) {
      throw ApiError.notFound('PAYROLL_REQUEST_NOT_FOUND', 'No payroll request with id ' + requestId);
    }

    return request;
  }

  private async requirePendingRequest(requestId: string) {
    const request = await this.requireRequest(requestId);

    if (request.status !== PayrollStatus.PENDING_APPROVAL) {
      throw ApiError.conflict(
        'PAYROLL_REQUEST_NOT_PENDING',
        'Payroll request is already ' + request.status,
        { requestId, status: request.status },
      );
    }

    return request;
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
