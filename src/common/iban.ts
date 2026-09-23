/**
 * MK IBAN shape used by this mock:
 *   MK + 2 check digits + 3-digit bank code + 10-digit account number + 2 check digits = 19 chars.
 * Values look plausible but are deliberately not MOD-97 valid — this is a mock bank.
 */
export const MK_IBAN_REGEX = /^MK\d{17}$/;

export function normalizeIban(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[\s-]/g, '').toUpperCase();
}

export function isValidMkIban(raw: string | null | undefined): boolean {
  return MK_IBAN_REGEX.test(normalizeIban(raw));
}

export function bankCodeFromIban(raw: string): string {
  return normalizeIban(raw).slice(4, 7);
}

export function buildMkIban(
  bankCode: string,
  accountNumber: string,
  checkDigits: string,
  trailingDigits: string,
): string {
  return `MK${checkDigits}${bankCode}${accountNumber}${trailingDigits}`;
}
