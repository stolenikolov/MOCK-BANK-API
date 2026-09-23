/**
 * Payroll allocation, kept pure so it can be unit-tested without a database.
 *
 * Rule (confirmed with BiznisMk): one employee's salary is never split across
 * two accounts. If no single account can cover an employee in full, the whole
 * run is rejected rather than partially paid.
 */

export interface PayrollPayment {
  employeeId: string;
  employeeName: string;
  amount: number;
}

export interface AllocatableAccount {
  iban: string;
  balance: number;
  currency: string;
}

export interface AllocationEntry {
  employeeId: string;
  employeeName: string;
  amount: number;
  iban: string;
}

export interface AccountTotal {
  iban: string;
  currency: string;
  balanceBefore: number;
  totalDebited: number;
  balanceAfter: number;
  paymentCount: number;
}

export interface UncoveredPayment {
  employeeId: string;
  employeeName: string;
  amount: number;
}

export type AllocationResult =
  | { ok: true; allocation: AllocationEntry[]; accountTotals: AccountTotal[] }
  | { ok: false; uncovered: UncoveredPayment[] };

/** Money here is minor-unit-safe: all comparisons happen in cents. */
const toCents = (value: number): number => Math.round(value * 100);
const fromCents = (value: number): number => Math.round(value) / 100;

export function allocatePayroll(
  payments: PayrollPayment[],
  accounts: AllocatableAccount[],
): AllocationResult {
  // Sort by balance descending; ties keep their input order so the result is
  // deterministic for a given request.
  const pots = accounts
    .map((account, index) => ({
      iban: account.iban,
      currency: account.currency,
      balanceBefore: toCents(account.balance),
      remaining: toCents(account.balance),
      debited: 0,
      paymentCount: 0,
      index,
    }))
    .sort((a, b) => b.remaining - a.remaining || a.index - b.index);

  const allocation: AllocationEntry[] = [];
  const uncovered: UncoveredPayment[] = [];

  for (const payment of payments) {
    const amount = toCents(payment.amount);
    const pot = pots.find((candidate) => candidate.remaining >= amount);

    if (!pot) {
      uncovered.push({
        employeeId: payment.employeeId,
        employeeName: payment.employeeName,
        amount: payment.amount,
      });
      continue;
    }

    pot.remaining -= amount;
    pot.debited += amount;
    pot.paymentCount += 1;

    allocation.push({
      employeeId: payment.employeeId,
      employeeName: payment.employeeName,
      amount: payment.amount,
      iban: pot.iban,
    });
  }

  if (uncovered.length > 0) {
    return { ok: false, uncovered };
  }

  const accountTotals: AccountTotal[] = pots
    .filter((pot) => pot.paymentCount > 0)
    .map((pot) => ({
      iban: pot.iban,
      currency: pot.currency,
      balanceBefore: fromCents(pot.balanceBefore),
      totalDebited: fromCents(pot.debited),
      balanceAfter: fromCents(pot.remaining),
      paymentCount: pot.paymentCount,
    }));

  return { ok: true, allocation, accountTotals };
}
