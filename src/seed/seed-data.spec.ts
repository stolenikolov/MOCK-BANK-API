import { faker } from '@faker-js/faker';
import { Prisma, TransactionType } from '@prisma/client';
import { isValidMkIban } from '../common/iban';
import { BANKS, COMPANY_IDS, TOTAL_ACCOUNTS, buildHistory, generateSeedRows } from './seed-data';

const bankIds = new Map(BANKS.map((bank) => [bank.code, 'bank-' + bank.code]));

describe('seed data', () => {
  let rows: ReturnType<typeof generateSeedRows>;

  beforeAll(() => {
    faker.seed(11);
    rows = generateSeedRows(bankIds);
  });

  it('generates exactly 200 accounts spread over the 11 banks', () => {
    expect(TOTAL_ACCOUNTS).toBe(200);
    expect(rows.accounts).toHaveLength(200);
    expect(BANKS).toHaveLength(11);

    for (const bank of BANKS) {
      const count = rows.accounts.filter((account) => account.bankId === 'bank-' + bank.code).length;
      expect(count).toBe(bank.accounts);
    }
  });

  it('gives the biggest banks the most accounts', () => {
    const counts = BANKS.map((bank) => bank.accounts);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(BANKS[0].name).toContain('Комерцијална');
  });

  it('uses unique, well-formed 19-character MK IBANs carrying the bank code', () => {
    const ibans = rows.accounts.map((account) => account.iban);

    expect(new Set(ibans).size).toBe(ibans.length);

    for (const account of rows.accounts) {
      expect(account.iban).toHaveLength(19);
      expect(isValidMkIban(account.iban)).toBe(true);
      const code = (account.bankId as string).replace('bank-', '');
      expect(account.iban.slice(4, 7)).toBe(code);
    }
  });

  it('uses unique bank codes of 3 digits', () => {
    const codes = BANKS.map((bank) => bank.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^\d{3}$/);
  });

  it('lands close to the requested status mix (85 / 10 / 5)', () => {
    const share = (status: string) =>
      rows.accounts.filter((account) => account.status === status).length / rows.accounts.length;

    expect(share('ACTIVE')).toBeGreaterThan(0.78);
    expect(share('ACTIVE')).toBeLessThan(0.92);
    expect(share('BLOCKED')).toBeGreaterThan(0.04);
    expect(share('BLOCKED')).toBeLessThan(0.17);
    expect(share('CLOSED')).toBeGreaterThan(0.01);
    expect(share('CLOSED')).toBeLessThan(0.11);
  });

  it('lands close to 15% EUR and 20% credit lines', () => {
    const eur = rows.accounts.filter((account) => account.currency === 'EUR').length;
    expect(eur / rows.accounts.length).toBeGreaterThan(0.08);
    expect(eur / rows.accounts.length).toBeLessThan(0.23);

    expect(rows.creditLines.length / rows.accounts.length).toBeGreaterThan(0.12);
    expect(rows.creditLines.length / rows.accounts.length).toBeLessThan(0.29);
  });

  it('leaves some accounts unclaimed and links the rest to known companies', () => {
    const linked = rows.accounts.filter((account) => account.companyId !== null);
    const unclaimed = rows.accounts.length - linked.length;

    expect(linked.length).toBeGreaterThan(0);
    expect(unclaimed).toBeGreaterThan(0);
    for (const account of linked) {
      expect(COMPANY_IDS).toContain(account.companyId);
    }
  });

  it('always uses the TRANSACTION account type', () => {
    for (const account of rows.accounts) {
      expect(account.accountType).toBe('TRANSACTION');
    }
  });

  it('names an account only while a company holds it', () => {
    for (const account of rows.accounts) {
      if (account.companyId) {
        expect(String(account.holderName).length).toBeGreaterThan(2);
      } else {
        // A free account at the bank is in nobody's name yet.
        expect(account.holderName).toBeNull();
      }
    }
  });

  it('keeps credit lines internally consistent', () => {
    const accountIds = new Set(rows.accounts.map((account) => account.id));

    for (const line of rows.creditLines) {
      expect(accountIds.has(line.accountId)).toBe(true);
      expect(line.installmentsPaid as number).toBeLessThan(line.totalInstallments);
      expect(new Prisma.Decimal(line.remainingBalance as Prisma.Decimal).toNumber()).toBeGreaterThan(0);

      const expected = new Prisma.Decimal(line.installmentAmount as Prisma.Decimal)
        .times(line.totalInstallments - (line.installmentsPaid as number))
        .toDecimalPlaces(2);
      expect(new Prisma.Decimal(line.remainingBalance as Prisma.Decimal).equals(expected)).toBe(true);
    }
  });

  it('gives every credit line at most one account', () => {
    const ids = rows.creditLines.map((line) => line.accountId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('writes no history for CLOSED accounts and history for the others', () => {
    const closed = new Set(
      rows.accounts
        .filter((account) => account.status === 'CLOSED')
        .map((account) => String(account.id)),
    );
    const withHistory = new Set(rows.transactions.map((tx) => tx.accountId));

    for (const id of closed) expect(withHistory.has(id)).toBe(false);
    expect(withHistory.size).toBe(rows.accounts.length - closed.size);
  });

  it('builds history whose newest balanceAfter equals the current balance', () => {
    faker.seed(7);
    const balance = new Prisma.Decimal('125000.55');
    const history = buildHistory('acc-1', 'MKD', balance, new Date('2020-01-01'));

    expect(history.length).toBeGreaterThan(0);
    expect(new Prisma.Decimal(history[0].balanceAfter as Prisma.Decimal).equals(balance)).toBe(true);
  });

  it('builds history that reconciles step by step and never goes negative', () => {
    faker.seed(11);
    const balance = new Prisma.Decimal('90000.00');
    const history = buildHistory('acc-1', 'MKD', balance, new Date('2020-01-01'));

    // Rows are newest-first: applying a row's own amount backwards must produce
    // the balanceAfter of the row before it in time.
    for (let i = 0; i < history.length - 1; i += 1) {
      const row = history[i];
      const older = history[i + 1];
      const after = new Prisma.Decimal(row.balanceAfter as Prisma.Decimal);
      const amount = new Prisma.Decimal(row.amount as Prisma.Decimal);
      const before =
        row.type === TransactionType.CREDIT ? after.minus(amount) : after.plus(amount);

      expect(before.equals(new Prisma.Decimal(older.balanceAfter as Prisma.Decimal))).toBe(true);
      expect(before.isNegative()).toBe(false);
      expect(new Date(row.createdAt as Date).getTime()).toBeGreaterThan(
        new Date(older.createdAt as Date).getTime(),
      );
    }
  });

  it('is reproducible for a given faker seed', () => {
    faker.seed(11);
    const again = generateSeedRows(bankIds);
    expect(again.accounts.map((account) => account.iban)).toEqual(
      rows.accounts.map((account) => account.iban),
    );
  });
});
