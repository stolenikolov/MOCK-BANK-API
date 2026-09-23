import { Prisma } from '@prisma/client';

export type Money = Prisma.Decimal;

/** Build a 2-decimal Decimal from anything Prisma or a DTO hands us. */
export function money(value: Prisma.Decimal | number | string): Money {
  return new Prisma.Decimal(value).toDecimalPlaces(2);
}

/** Decimal columns go over the wire as JSON numbers — that is what BiznisMk expects. */
export function toNumber(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return new Prisma.Decimal(value).toDecimalPlaces(2).toNumber();
}
