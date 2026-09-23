import type { Account, CreditLine, Transaction } from '@prisma/client';
import { toNumber } from './money';
import type { WebhookTransaction } from '../webhooks/webhook.types';

export function serializeTransaction(tx: Transaction): WebhookTransaction {
  return {
    id: tx.id,
    type: tx.type,
    amount: toNumber(tx.amount),
    currency: tx.currency,
    description: tx.description,
    balanceAfter: toNumber(tx.balanceAfter),
    createdAt: tx.createdAt.toISOString(),
  };
}

export function serializeCreditLine(creditLine: CreditLine | null | undefined) {
  if (!creditLine) return null;
  return {
    creditAmount: toNumber(creditLine.creditAmount),
    remainingBalance: toNumber(creditLine.remainingBalance),
    nextPaymentDate: creditLine.nextPaymentDate.toISOString(),
    installmentAmount: toNumber(creditLine.installmentAmount),
    totalInstallments: creditLine.totalInstallments,
    installmentsPaid: creditLine.installmentsPaid,
  };
}

export function serializeAccount(
  account: Account & { bank: { name: string; code: string }; creditLine?: CreditLine | null },
) {
  return {
    iban: account.iban,
    bankName: account.bank.name,
    bankCode: account.bank.code,
    accountHolderName: account.holderName,
    companyId: account.companyId,
    currency: account.currency,
    balance: toNumber(account.balance),
    status: account.status,
    accountType: account.accountType,
    creditLine: serializeCreditLine(account.creditLine),
    lastSyncedAt: account.lastSyncedAt.toISOString(),
    createdAt: account.createdAt.toISOString(),
  };
}
