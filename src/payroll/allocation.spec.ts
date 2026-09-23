import { allocatePayroll } from './allocation';

const account = (iban: string, balance: number, currency = 'MKD') => ({ iban, balance, currency });
const payment = (employeeId: string, amount: number) => ({
  employeeId,
  employeeName: 'Employee ' + employeeId,
  amount,
});

describe('allocatePayroll', () => {
  it('puts every salary on the richest account while it can still cover them', () => {
    const result = allocatePayroll(
      [payment('e1', 30000), payment('e2', 25000)],
      [account('MK07300000000042425', 100000), account('MK07210000000011111', 40000)],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.map((entry) => entry.iban)).toEqual([
      'MK07300000000042425',
      'MK07300000000042425',
    ]);
    expect(result.accountTotals).toHaveLength(1);
    expect(result.accountTotals[0]).toMatchObject({
      iban: 'MK07300000000042425',
      balanceBefore: 100000,
      totalDebited: 55000,
      balanceAfter: 45000,
      paymentCount: 2,
    });
  });

  it('spills over to the next account once the first one is drained', () => {
    const result = allocatePayroll(
      [payment('e1', 60000), payment('e2', 60000)],
      [account('MK07300000000042425', 100000), account('MK07210000000011111', 80000)],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation).toEqual([
      expect.objectContaining({ employeeId: 'e1', iban: 'MK07300000000042425' }),
      expect.objectContaining({ employeeId: 'e2', iban: 'MK07210000000011111' }),
    ]);
    expect(result.accountTotals).toHaveLength(2);
  });

  it('never splits one salary across two accounts', () => {
    // 50k + 50k available, one 60k salary: combined funds are enough, but no
    // single account can cover it, so the run is rejected.
    const result = allocatePayroll(
      [payment('e1', 60000)],
      [account('MK07300000000042425', 50000), account('MK07210000000011111', 50000)],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncovered).toEqual([
      { employeeId: 'e1', employeeName: 'Employee e1', amount: 60000 },
    ]);
  });

  it('reports every uncovered employee, not just the first', () => {
    const result = allocatePayroll(
      [payment('e1', 30000), payment('e2', 90000), payment('e3', 95000)],
      [account('MK07300000000042425', 50000)],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncovered.map((item) => item.employeeId)).toEqual(['e2', 'e3']);
  });

  it('fails when there are no usable accounts at all', () => {
    const result = allocatePayroll([payment('e1', 1)], []);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncovered).toHaveLength(1);
  });

  it('handles decimal salaries without floating point drift', () => {
    const result = allocatePayroll(
      [payment('e1', 0.1), payment('e2', 0.2)],
      [account('MK07300000000042425', 0.3)],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accountTotals[0].totalDebited).toBe(0.3);
    expect(result.accountTotals[0].balanceAfter).toBe(0);
  });

  it('allows a salary exactly equal to the remaining balance', () => {
    const result = allocatePayroll(
      [payment('e1', 25000)],
      [account('MK07300000000042425', 25000)],
    );

    expect(result.ok).toBe(true);
  });

  it('is deterministic when two accounts hold the same balance', () => {
    const first = allocatePayroll(
      [payment('e1', 100)],
      [account('MK07300000000042425', 500), account('MK07210000000011111', 500)],
    );
    const second = allocatePayroll(
      [payment('e1', 100)],
      [account('MK07300000000042425', 500), account('MK07210000000011111', 500)],
    );

    expect(first).toEqual(second);
    if (!first.ok) return;
    expect(first.allocation[0].iban).toBe('MK07300000000042425');
  });

  it('returns an empty allocation for an empty payment list', () => {
    const result = allocatePayroll([], [account('MK07300000000042425', 500)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation).toEqual([]);
    expect(result.accountTotals).toEqual([]);
  });
});
