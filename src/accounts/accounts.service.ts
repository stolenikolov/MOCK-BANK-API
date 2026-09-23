import { Injectable } from '@nestjs/common';
import { AccountStatus, Prisma, Transaction, TransactionType } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ApiError } from '../common/errors';
import { isValidMkIban, normalizeIban } from '../common/iban';
import { money, toNumber } from '../common/money';
import { serializeAccount, serializeCreditLine, serializeTransaction } from '../common/serializers';
import { WebhooksService } from '../webhooks/webhooks.service';
import type { SimulateAmountDto, SimulateLoanDto } from './dto/simulate.dto';
import type { ListAccountsQueryDto } from './dto/list-accounts.dto';

const ACCOUNT_INCLUDE = {
  bank: { select: { name: true, code: true } },
  creditLine: true,
} satisfies Prisma.AccountInclude;

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
  ) {}

  /**
   * The "add card" flow. Never throws for an unknown account - BiznisMk wants a
   * yes/no answer plus the bank identity, so it can apply its own
   * one-or-two-accounts-per-bank rule before persisting the link.
   *
   * Passing a companyId also claims the account: the first company to verify a
   * free account keeps it, and anyone else gets ACCOUNT_ALREADY_LINKED. The
   * account is put in the name of that company's owner — until somebody claims
   * it, a bank account here is in nobody's name.
   */
  async verify(rawIban: string, companyId?: string, holderName?: string) {
    const iban = normalizeIban(rawIban);

    if (!isValidMkIban(iban)) {
      return { exists: false as const, errorCode: 'INVALID_IBAN_FORMAT' as const };
    }

    const account = await this.prisma.account.findUnique({
      where: { iban },
      include: { bank: { select: { name: true, code: true } } },
    });

    if (!account) {
      return { exists: false as const, errorCode: 'ACCOUNT_NOT_FOUND' as const };
    }

    const link = companyId
      ? await this.claim(account.id, iban, account.status, account.companyId, companyId, holderName)
      : {
          linkStatus: 'NOT_REQUESTED' as const,
          companyId: account.companyId,
          holderName: account.holderName,
        };

    return {
      exists: true as const,
      iban: account.iban,
      bankName: account.bank.name,
      bankCode: account.bank.code,
      // Null until a company claims the account.
      accountHolderName: link.holderName,
      status: account.status,
      currency: account.currency,
      companyId: link.companyId,
      linkStatus: link.linkStatus,
    };
  }

  /**
   * First-come-first-served, decided by the database rather than by the read
   * above: the conditional update only matches while the account is still free,
   * so two companies verifying at the same moment cannot both win.
   */
  private async claim(
    accountId: string,
    iban: string,
    status: AccountStatus,
    currentOwner: string | null,
    companyId: string,
    holderName?: string,
  ): Promise<{
    linkStatus: 'CLAIMED' | 'ALREADY_YOURS';
    companyId: string;
    holderName: string | null;
  }> {
    if (currentOwner === companyId) {
      const account = await this.prisma.account.findUnique({
        where: { id: accountId },
        select: { holderName: true },
      });
      return { linkStatus: 'ALREADY_YOURS', companyId, holderName: account?.holderName ?? null };
    }

    // Claiming puts the account in a name, so the name has to come with it.
    const holder = holderName?.trim();
    if (!holder) {
      throw ApiError.badRequest(
        'HOLDER_NAME_REQUIRED',
        'holderName is required when claiming an account: the account is put in the name of the company owner',
        { iban },
      );
    }

    if (status === AccountStatus.CLOSED) {
      throw ApiError.conflict('ACCOUNT_CLOSED', 'A closed account cannot be linked', {
        iban,
        status,
      });
    }

    if (currentOwner) {
      throw ApiError.conflict(
        'ACCOUNT_ALREADY_LINKED',
        'This account is already linked to another company',
        { iban, companyId: currentOwner },
      );
    }

    const claimed = await this.prisma.account.updateMany({
      where: { id: accountId, companyId: null },
      data: { companyId, holderName: holder, lastSyncedAt: new Date() },
    });

    if (claimed.count === 1) {
      return { linkStatus: 'CLAIMED', companyId, holderName: holder };
    }

    // Someone claimed it between the read and the update.
    const winner = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { companyId: true, holderName: true },
    });

    if (winner?.companyId === companyId) {
      return { linkStatus: 'ALREADY_YOURS', companyId, holderName: winner.holderName };
    }

    throw ApiError.conflict(
      'ACCOUNT_ALREADY_LINKED',
      'This account is already linked to another company',
      { iban, companyId: winner?.companyId ?? null },
    );
  }

  /**
   * Releases an account so it can be linked again - test convenience. The
   * holder goes with the link: a free account is back in nobody's name.
   */
  async unlink(rawIban: string, companyId?: string) {
    const account = await this.requireAccount(rawIban);

    if (!account.companyId) {
      return {
        iban: account.iban,
        companyId: null,
        accountHolderName: null,
        linkStatus: 'ALREADY_FREE' as const,
      };
    }

    if (companyId && account.companyId !== companyId) {
      throw ApiError.conflict(
        'ACCOUNT_ALREADY_LINKED',
        'This account belongs to another company',
        { iban: account.iban, companyId: account.companyId },
      );
    }

    await this.prisma.account.update({
      where: { id: account.id },
      data: { companyId: null, holderName: null, lastSyncedAt: new Date() },
    });

    return {
      iban: account.iban,
      companyId: null,
      accountHolderName: null,
      linkStatus: 'RELEASED' as const,
    };
  }

  async getState(rawIban: string) {
    const account = await this.requireAccount(rawIban);
    return serializeAccount(account);
  }

  /**
   * Directory of the mock's accounts, so tooling can find test accounts without
   * knowing an IBAN up front. Richest first, which makes "the first ACTIVE
   * account at bank X" a stable choice across calls.
   */
  async list(query: ListAccountsQueryDto) {
    const take = Math.min(Math.max(query.limit ?? 20, 1), 200);

    const where: Prisma.AccountWhereInput = {
      ...(query.bankCode ? { bank: { code: query.bankCode } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.unclaimed === 'true' ? { companyId: null } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.account.count({ where }),
      this.prisma.account.findMany({
        where,
        include: ACCOUNT_INCLUDE,
        orderBy: [{ balance: 'desc' }, { iban: 'asc' }],
        take,
        skip: query.offset ?? 0,
      }),
    ]);

    return {
      items: rows.map(serializeAccount),
      total,
      limit: take,
      offset: query.offset ?? 0,
    };
  }

  async listTransactions(rawIban: string, limit = 50, cursor?: string) {
    const account = await this.requireAccount(rawIban);
    const take = Math.min(Math.max(limit, 1), 200);

    const rows = await this.prisma.transaction.findMany({
      where: { accountId: account.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    return {
      iban: account.iban,
      items: items.map(serializeTransaction),
      limit: take,
      hasMore,
      nextCursor: hasMore && items.length > 0 ? items[items.length - 1].id : null,
    };
  }

  async deposit(rawIban: string, dto: SimulateAmountDto) {
    const account = await this.requireActiveAccount(rawIban);
    const amount = money(dto.amount);
    const newBalance = money(account.balance).plus(amount);

    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          accountId: account.id,
          type: TransactionType.CREDIT,
          amount,
          currency: account.currency,
          description: dto.description?.trim() || 'Simulated deposit',
          balanceAfter: newBalance,
        },
      });

      const updated = await tx.account.update({
        where: { id: account.id },
        data: { balance: newBalance, lastSyncedAt: new Date() },
      });

      return { transaction: created, balance: updated.balance };
    });

    return this.transactionResult(account.iban, account.currency, result.balance, result.transaction);
  }

  async withdraw(rawIban: string, dto: SimulateAmountDto) {
    const account = await this.requireActiveAccount(rawIban);
    const amount = money(dto.amount);
    const current = money(account.balance);

    if (current.lessThan(amount)) {
      throw ApiError.conflict(
        'INSUFFICIENT_FUNDS',
        'Account balance is lower than the requested withdrawal',
        {
          iban: account.iban,
          balance: toNumber(current),
          requested: toNumber(amount),
          currency: account.currency,
        },
      );
    }

    const newBalance = current.minus(amount);

    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          accountId: account.id,
          type: TransactionType.DEBIT,
          amount,
          currency: account.currency,
          description: dto.description?.trim() || 'Simulated withdrawal',
          balanceAfter: newBalance,
        },
      });

      const updated = await tx.account.update({
        where: { id: account.id },
        data: { balance: newBalance, lastSyncedAt: new Date() },
      });

      return { transaction: created, balance: updated.balance };
    });

    return this.transactionResult(account.iban, account.currency, result.balance, result.transaction);
  }

  /**
   * Disburses a loan: opens (or replaces) the account's credit line and credits
   * the principal to the balance as a normal CREDIT transaction.
   */
  async loan(rawIban: string, dto: SimulateLoanDto) {
    const account = await this.requireActiveAccount(rawIban);
    const amount = money(dto.amount);
    const installmentAmount = money(amount.dividedBy(dto.totalInstallments));
    const newBalance = money(account.balance).plus(amount);
    const nextPaymentDate = addOneMonth(new Date());

    const result = await this.prisma.$transaction(async (tx) => {
      const creditLineData = {
        creditAmount: amount,
        remainingBalance: amount,
        nextPaymentDate,
        installmentAmount,
        totalInstallments: dto.totalInstallments,
        installmentsPaid: 0,
      };

      const creditLine = await tx.creditLine.upsert({
        where: { accountId: account.id },
        create: { accountId: account.id, ...creditLineData },
        update: creditLineData,
      });

      const created = await tx.transaction.create({
        data: {
          accountId: account.id,
          type: TransactionType.CREDIT,
          amount,
          currency: account.currency,
          description: dto.description?.trim() || 'Loan disbursement',
          balanceAfter: newBalance,
        },
      });

      const updated = await tx.account.update({
        where: { id: account.id },
        data: { balance: newBalance, lastSyncedAt: new Date() },
      });

      return { creditLine, transaction: created, balance: updated.balance };
    });

    const payload = this.transactionResult(
      account.iban,
      account.currency,
      result.balance,
      result.transaction,
    );

    return { ...payload, creditLine: serializeCreditLine(result.creditLine) };
  }

  /** Shared tail of every simulate endpoint: fire the webhook, shape the response. */
  private transactionResult(
    iban: string,
    currency: string,
    balance: Prisma.Decimal,
    transaction: Transaction,
  ) {
    const serialized = serializeTransaction(transaction);
    const newBalance = toNumber(balance);

    this.webhooks.dispatch({
      eventType: 'TRANSACTION_CREATED',
      iban,
      currency,
      newBalance,
      transactions: [serialized],
      timestamp: new Date().toISOString(),
    });

    return { iban, currency, newBalance, transaction: serialized };
  }

  private async requireAccount(rawIban: string) {
    const iban = normalizeIban(rawIban);

    if (!isValidMkIban(iban)) {
      throw ApiError.badRequest('INVALID_IBAN_FORMAT', 'IBAN must be MK followed by 17 digits', {
        iban,
      });
    }

    const account = await this.prisma.account.findUnique({
      where: { iban },
      include: ACCOUNT_INCLUDE,
    });

    if (!account) {
      throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No account with IBAN ' + iban, { iban });
    }

    return account;
  }

  private async requireActiveAccount(rawIban: string) {
    const account = await this.requireAccount(rawIban);

    if (account.status !== 'ACTIVE') {
      throw ApiError.conflict(
        'ACCOUNT_NOT_ACTIVE',
        'Account is ' + account.status + ' and cannot move money',
        { iban: account.iban, status: account.status },
      );
    }

    return account;
  }
}

function addOneMonth(from: Date): Date {
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  return next;
}
