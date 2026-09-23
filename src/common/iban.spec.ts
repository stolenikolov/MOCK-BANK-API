import { bankCodeFromIban, buildMkIban, isValidMkIban, normalizeIban } from './iban';

describe('iban helpers', () => {
  it('accepts a well-formed 19-character MK iban', () => {
    expect(isValidMkIban('MK07300000000042425')).toBe(true);
  });

  it('normalizes spacing, dashes and case before validating', () => {
    expect(isValidMkIban('mk07 3000-0000 0042 425')).toBe(true);
    expect(normalizeIban('mk07 3000-0000 0042 425')).toBe('MK07300000000042425');
  });

  it('rejects wrong length, wrong country code, and non-digits', () => {
    expect(isValidMkIban('MK0730000000004242')).toBe(false);
    expect(isValidMkIban('MK073000000000424255')).toBe(false);
    expect(isValidMkIban('DE07300000000042425')).toBe(false);
    expect(isValidMkIban('MK0730000000004242X')).toBe(false);
    expect(isValidMkIban(null)).toBe(false);
  });

  it('extracts the 3-digit bank code', () => {
    expect(bankCodeFromIban('MK07300000000042425')).toBe('300');
    expect(bankCodeFromIban('mk07 3000 0000 0042 425')).toBe('300');
  });

  it('builds ibans of exactly 19 characters', () => {
    const iban = buildMkIban('210', '0123456789', '12', '34');
    expect(iban).toBe('MK12210012345678934');
    expect(iban).toHaveLength(19);
    expect(isValidMkIban(iban)).toBe(true);
  });
});
