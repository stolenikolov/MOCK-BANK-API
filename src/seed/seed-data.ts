import { faker } from '@faker-js/faker';
import { AccountStatus, Prisma, TransactionType } from '@prisma/client';
import { buildMkIban } from '../common/iban';

/**
 * Pure generators for the 200 mock accounts. Kept free of database calls so the
 * distributions and the statement history can be unit-tested.
 */

export const EUR_SHARE = 0.15;
export const CREDIT_LINE_SHARE = 0.2;
export const COMPANY_LINKED_SHARE = 0.4;
export const COMPANY_COUNT = 10;

export interface SeedBank {
  name: string;
  code: string;
  accounts: number;
}

/**
 * Account counts are roughly proportional to real market size and add up to
 * 200, so the bigger banks hold the most accounts.
 */
export const BANKS: SeedBank[] = [
  { name: 'Комерцијална банка АД Скопје', code: '300', accounts: 42 },
  { name: 'Стопанска банка АД Скопје', code: '200', accounts: 38 },
  { name: 'НЛБ Банка АД Скопје', code: '210', accounts: 34 },
  { name: 'Халк Банка АД Скопје', code: '270', accounts: 22 },
  { name: 'Шпаркасе Банка Македонија АД Скопје', code: '250', accounts: 16 },
  { name: 'ProCredit Банка АД Скопје', code: '380', accounts: 14 },
  { name: 'УНИБанка АД Скопје', code: '240', accounts: 12 },
  { name: 'ТТК Банка АД Скопје', code: '290', accounts: 8 },
  { name: 'Централна кооперативна банка АД Скопје', code: '320', accounts: 6 },
  { name: 'Развојна банка на Северна Македонија АД Скопје', code: '100', accounts: 4 },
  { name: 'Silk Road Bank АД Скопје', code: '330', accounts: 4 },
];

export const TOTAL_ACCOUNTS = BANKS.reduce((sum, bank) => sum + bank.accounts, 0);

export const COMPANY_IDS = Array.from(
  { length: COMPANY_COUNT },
  (_, index) => 'company-' + String(index + 1).padStart(2, '0'),
);

const CREDIT_DESCRIPTIONS = [
  'Уплата од купувач',
  'Фактура 2026-{n}',
  'Incoming transfer',
  'Поврат на средства',
  'Client payment',
];

const DEBIT_DESCRIPTIONS = [
  'Плаќање добавувач',
  'Провизија за одржување',
  'Utility payment',
  'Аконтација на плата',
  'Card purchase',
];

export interface SeedRows {
  accounts: Prisma.AccountCreateManyInput[];
  creditLines: Prisma.CreditLineCreateManyInput[];
  transactions: Prisma.TransactionCreateManyInput[];
}

/**
 * @param bankIdByCode maps a 3-digit bank code to the persisted Bank id.
 */
export function generateSeedRows(bankIdByCode: Map<string, string>): SeedRows {
  const usedIbans = new Set<string>();
  const rows: SeedRows = { accounts: [], creditLines: [], transactions: [] };

  for (const bank of BANKS) {
    const bankId = bankIdByCode.get(bank.code);
    if (!bankId) throw new Error('Missing bank id for code ' + bank.code);

    for (let i = 0; i < bank.accounts; i += 1) {
      const id = faker.string.uuid();
      // An account is in somebody's name only while a company holds it.
      const companyId = faker.datatype.boolean({ probability: COMPANY_LINKED_SHARE })
        ? faker.helpers.arrayElement(COMPANY_IDS)
        : null;
      const currency = faker.datatype.boolean({ probability: EUR_SHARE }) ? 'EUR' : 'MKD';
      const status = pickStatus();
      const balance = openingBalance(currency);
      const createdAt = faker.date.past({ years: 4 });

      rows.accounts.push({
        id,
        bankId,
        iban: uniqueIban(bank.code, usedIbans),
        // Not all 200 are pre-assigned; unclaimed accounts can be linked later.
        companyId,
        // The holder is the owner of the company that claimed it; a free
        // account is in nobody's name yet.
        holderName: companyId ? faker.person.fullName() : null,
        currency,
        balance,
        status,
        accountType: 'TRANSACTION',
        createdAt,
        lastSyncedAt: new Date(),
      });

      if (faker.datatype.boolean({ probability: CREDIT_LINE_SHARE })) {
        rows.creditLines.push(creditLine(id, currency));
      }

      if (status !== AccountStatus.CLOSED) {
        rows.transactions.push(...buildHistory(id, currency, balance, createdAt));
      }
    }
  }

  return rows;
}

function uniqueIban(bankCode: string, used: Set<string>): string {
  for (;;) {
    const iban = buildMkIban(
      bankCode,
      faker.string.numeric({ length: 10, allowLeadingZeros: true }),
      faker.string.numeric({ length: 2, allowLeadingZeros: true }),
      faker.string.numeric({ length: 2, allowLeadingZeros: true }),
    );
    if (!used.has(iban)) {
      used.add(iban);
      return iban;
    }
  }
}

function pickStatus(): AccountStatus {
  const roll = faker.number.float({ min: 0, max: 1 });
  if (roll < 0.85) return AccountStatus.ACTIVE;
  if (roll < 0.95) return AccountStatus.BLOCKED;
  return AccountStatus.CLOSED;
}

function openingBalance(currency: string): Prisma.Decimal {
  const amount =
    currency === 'EUR'
      ? faker.number.float({ min: 500, max: 60_000, fractionDigits: 2 })
      : faker.number.float({ min: 20_000, max: 3_000_000, fractionDigits: 2 });
  return new Prisma.Decimal(amount).toDecimalPlaces(2);
}

function creditLine(accountId: string, currency: string): Prisma.CreditLineCreateManyInput {
  const totalInstallments = faker.helpers.arrayElement([6, 12, 18, 24, 36, 48, 60]);
  const creditAmount = new Prisma.Decimal(
    currency === 'EUR'
      ? faker.number.float({ min: 2_000, max: 120_000, fractionDigits: 2 })
      : faker.number.float({ min: 100_000, max: 6_000_000, fractionDigits: 2 }),
  ).toDecimalPlaces(2);
  const installmentsPaid = faker.number.int({ min: 0, max: totalInstallments - 1 });
  const installmentAmount = creditAmount.dividedBy(totalInstallments).toDecimalPlaces(2);

  return {
    accountId,
    creditAmount,
    remainingBalance: installmentAmount
      .times(totalInstallments - installmentsPaid)
      .toDecimalPlaces(2),
    nextPaymentDate: faker.date.soon({ days: 30 }),
    installmentAmount,
    totalInstallments,
    installmentsPaid,
  };
}

function describeTransaction(type: TransactionType): string {
  const pool = type === TransactionType.CREDIT ? CREDIT_DESCRIPTIONS : DEBIT_DESCRIPTIONS;
  return faker.helpers
    .arrayElement(pool)
    .replace('{n}', faker.string.numeric({ length: 4, allowLeadingZeros: false }));
}

/**
 * Builds plausible statement history by walking backwards from the current
 * balance: every balanceAfter is the real balance at that moment, the newest row
 * matches the account balance, and no row ever goes negative.
 */
export function buildHistory(
  accountId: string,
  currency: string,
  currentBalance: Prisma.Decimal,
  createdAt: Date,
  now: Date = new Date(),
): Prisma.TransactionCreateManyInput[] {
  const count = faker.number.int({ min: 4, max: 14 });
  const rows: Prisma.TransactionCreateManyInput[] = [];

  let balance = currentBalance;
  let when = now;

  for (let i = 0; i < count; i += 1) {
    const max = currency === 'EUR' ? 8_000 : 250_000;
    const amount = new Prisma.Decimal(
      faker.number.float({ min: 10, max, fractionDigits: 2 }),
    ).toDecimalPlaces(2);

    // A CREDIT means the earlier balance was lower; only keep it if that stays
    // non-negative, otherwise record a DEBIT instead.
    const wantsCredit = faker.datatype.boolean({ probability: 0.45 });
    const type =
      wantsCredit && balance.greaterThanOrEqualTo(amount)
        ? TransactionType.CREDIT
        : TransactionType.DEBIT;

    rows.push({
      accountId,
      type,
      amount,
      currency,
      description: describeTransaction(type),
      balanceAfter: balance,
      createdAt: when,
    });

    balance = type === TransactionType.CREDIT ? balance.minus(amount) : balance.plus(amount);
    when = new Date(when.getTime() - faker.number.int({ min: 3, max: 96 }) * 3_600_000);

    if (when < createdAt) break;
  }

  return rows;
}
