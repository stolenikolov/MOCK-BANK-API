import { faker } from '@faker-js/faker';
import { AccountStatus, PrismaClient } from '@prisma/client';
import { BANKS, TOTAL_ACCOUNTS, generateSeedRows } from '../src/seed/seed-data';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Deterministic: the same run produces the same 200 accounts.
  faker.seed(11);

  console.log('Clearing existing data...');
  await prisma.transaction.deleteMany();
  await prisma.creditLine.deleteMany();
  await prisma.account.deleteMany();
  await prisma.bank.deleteMany();
  await prisma.payrollRequest.deleteMany();
  await prisma.failedWebhook.deleteMany();

  console.log('Seeding ' + BANKS.length + ' banks...');
  const banks = await Promise.all(
    BANKS.map((bank) => prisma.bank.create({ data: { name: bank.name, code: bank.code } })),
  );

  const rows = generateSeedRows(new Map(banks.map((bank) => [bank.code, bank.id])));

  console.log('Seeding ' + rows.accounts.length + ' of ' + TOTAL_ACCOUNTS + ' accounts...');
  await prisma.account.createMany({ data: rows.accounts });

  console.log('Seeding ' + rows.creditLines.length + ' credit lines...');
  await prisma.creditLine.createMany({ data: rows.creditLines });

  console.log('Seeding ' + rows.transactions.length + ' transactions...');
  await prisma.transaction.createMany({ data: rows.transactions });

  await report();
}

async function report(): Promise<void> {
  const [total, active, blocked, closed, eur, creditLines, linked] = await Promise.all([
    prisma.account.count(),
    prisma.account.count({ where: { status: AccountStatus.ACTIVE } }),
    prisma.account.count({ where: { status: AccountStatus.BLOCKED } }),
    prisma.account.count({ where: { status: AccountStatus.CLOSED } }),
    prisma.account.count({ where: { currency: 'EUR' } }),
    prisma.creditLine.count(),
    prisma.account.count({ where: { NOT: { companyId: null } } }),
  ]);

  console.log('');
  console.log('--- seed summary ---');
  console.log('accounts:       ' + total);
  console.log('  ACTIVE:       ' + active + ' (' + pct(active, total) + ')');
  console.log('  BLOCKED:      ' + blocked + ' (' + pct(blocked, total) + ')');
  console.log('  CLOSED:       ' + closed + ' (' + pct(closed, total) + ')');
  console.log('  EUR:          ' + eur + ' (' + pct(eur, total) + ')');
  console.log('  credit lines: ' + creditLines + ' (' + pct(creditLines, total) + ')');
  console.log('  linked:       ' + linked + ', unclaimed: ' + (total - linked));

  const sample = await prisma.account.findMany({
    where: { status: AccountStatus.ACTIVE, currency: 'MKD', NOT: { companyId: null } },
    include: { bank: { select: { name: true } } },
    orderBy: { balance: 'desc' },
    take: 5,
  });

  console.log('');
  console.log('Try these IBANs (ACTIVE, MKD, company-linked):');
  for (const account of sample) {
    console.log(
      '  ' +
        account.iban +
        '  ' +
        account.companyId +
        '  ' +
        account.balance.toFixed(2) +
        ' MKD  ' +
        account.bank.name,
    );
  }
  console.log('');
}

function pct(part: number, total: number): string {
  return total === 0 ? '0%' : Math.round((part / total) * 100) + '%';
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
