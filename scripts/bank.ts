/* eslint-disable no-console */
/**
 * Human-friendly console for the mock bank, so scenarios can be triggered
 * without curl and without memorising IBANs:
 *
 *   deposit 1234567890 stopanska 5000
 *
 * Run it once for an interactive prompt (npm run bank), or pass a command
 * directly (npm run bank -- deposit 1234567890 stopanska 5000).
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BANK_SHORT_NAMES, PRIMARY_ALIASES, bankCodeFromAlias, isBankAlias } from './banks';

loadEnvFile();

const BASE_URL = (process.env.MOCK_BANK_URL ?? 'http://localhost:' + (process.env.PORT ?? '4000')).replace(/\/$/, '');
const API_KEY = process.env.API_KEY ?? 'dev-mock-bank-key';

interface ApiAccount {
  iban: string;
  bankName: string;
  bankCode: string;
  accountHolderName: string | null;
  companyId: string | null;
  currency: string;
  balance: number;
  status: string;
  creditLine: CreditLine | null;
  lastSyncedAt: string;
}

interface CreditLine {
  creditAmount: number;
  remainingBalance: number;
  nextPaymentDate: string;
  installmentAmount: number;
  totalInstallments: number;
  installmentsPaid: number;
}

/** Every command aborts by throwing this; the REPL keeps running afterwards. */
class UserError extends Error {}

// ---------------------------------------------------------------- entry point

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length > 0) {
    await runCommand(argv);
    return;
  }

  await repl();
}

async function repl(): Promise<void> {
  console.log('');
  console.log(bold('Mock Bank') + '  ' + dim(BASE_URL));
  console.log(dim('Пиши команда (пр. deposit 1234567890 stopanska 5000). "help" за список, "exit" за излез.'));
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'банка> ' });
  rl.prompt();

  for await (const line of rl) {
    const args = splitArgs(line.trim());

    if (args.length > 0) {
      const command = args[0].toLowerCase();
      if (command === 'exit' || command === 'quit' || command === 'izlez') break;

      try {
        await runCommand(args);
      } catch (error) {
        printError(error);
      }
    }

    console.log('');
    rl.prompt();
  }

  rl.close();
  console.log(dim('Чао.'));
}

async function runCommand(args: string[]): Promise<void> {
  const command = args[0].toLowerCase();
  const rest = args.slice(1);

  try {
    switch (command) {
      case 'help':
      case 'pomos':
      case 'помош':
        printHelp();
        return;
      case 'banks':
      case 'banki':
      case 'банки':
        printBanks();
        return;
      case 'accounts':
      case 'smetki':
      case 'сметки':
        return await cmdAccounts(rest);
      case 'show':
      case 'smetka':
      case 'сметка':
        return await cmdShow(rest);
      case 'tx':
      case 'transakcii':
      case 'трансакции':
        return await cmdTransactions(rest);
      case 'verify':
      case 'proveri':
      case 'провери':
        return await cmdVerify(rest);
      case 'unlink':
      case 'otkaci':
      case 'откачи':
        return await cmdUnlink(rest);
      case 'deposit':
      case 'uplata':
      case 'уплата':
        return await cmdDeposit(rest);
      case 'withdraw':
      case 'isplata':
      case 'исплата':
        return await cmdWithdraw(rest);
      case 'loan':
      case 'kredit':
      case 'кредит':
        return await cmdLoan(rest);
      case 'payroll':
      case 'plata':
      case 'plati':
      case 'плата':
        return await cmdPayroll(rest);
      case 'approve':
      case 'odobri':
      case 'одобри':
        return await cmdResolvePayroll(rest, 'approve');
      case 'reject':
      case 'odbij':
      case 'одбиј':
        return await cmdResolvePayroll(rest, 'reject');
      case 'failed':
        return await cmdFailed();
      case 'retry':
        return await cmdRetry(rest);
      default:
        throw new UserError('Непозната команда "' + command + '". Пробај "help".');
    }
  } catch (error) {
    if (process.argv.length > 2) {
      printError(error);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

// ------------------------------------------------------------------- commands

async function cmdAccounts(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);
  const bankToken = positional[0];
  const query = new URLSearchParams({ limit: '200' });

  if (bankToken) query.set('bankCode', requireBankCode(bankToken));
  if (flags.company) query.set('companyId', String(flags.company));
  if (flags.free || flags.slobodni) query.set('unclaimed', 'true');
  query.set('status', String(flags.status ?? 'ACTIVE'));
  if (flags.currency) query.set('currency', String(flags.currency));

  const result = await api<{ items: ApiAccount[]; total: number }>('GET', '/accounts?' + query.toString());

  if (result.items.length === 0) {
    throw new UserError('Нема сметки за тие филтри.');
  }

  console.log('');
  console.log(bold('Сметка       Банка          Салдо                Статус   Компанија    Сопственик'));
  for (const account of result.items.slice(0, 40)) {
    console.log(
      accountNumber(account.iban).padEnd(13) +
        shortBank(account.bankCode).padEnd(15) +
        formatMoney(account.balance, account.currency).padStart(18) +
        '  ' +
        account.status.padEnd(9) +
        (account.companyId ?? dim('слободна')).padEnd(13) +
        (account.accountHolderName ? truncate(account.accountHolderName, 30) : dim('—')),
    );
  }
  console.log('');
  console.log(dim('Прикажани ' + Math.min(result.items.length, 40) + ' од ' + result.total + '.'));
}

async function cmdShow(args: string[]): Promise<void> {
  const { account } = await resolveTarget(args, 'show <сметка> <банка>');
  printAccount(account);
}

async function cmdTransactions(args: string[]): Promise<void> {
  const { account, rest } = await resolveTarget(args, 'tx <сметка> <банка> [колку]');
  const limit = rest[0] ? Math.max(1, Math.min(200, Number(rest[0]))) : 10;

  const page = await api<{ items: Array<Record<string, string | number>> }>(
    'GET',
    '/accounts/' + account.iban + '/transactions?limit=' + limit,
  );

  if (page.items.length === 0) {
    console.log(dim('Нема трансакции на оваа сметка.'));
    return;
  }

  console.log('');
  console.log(bold('Датум             Тип      Износ            Салдо после      Опис'));
  for (const tx of page.items) {
    console.log(
      formatDateTime(String(tx.createdAt)).padEnd(18) +
        String(tx.type).padEnd(9) +
        formatMoney(Number(tx.amount), String(tx.currency)).padStart(15) +
        formatMoney(Number(tx.balanceAfter), String(tx.currency)).padStart(17) +
        '   ' +
        truncate(String(tx.description), 34),
    );
  }
}

async function cmdVerify(args: string[]): Promise<void> {
  const { account, rest } = await resolveTarget(args, 'verify <сметка> <банка> [фирма] [газда]', {
    trailingIsText: true,
  });
  const companyId = rest[0];
  const holderName = rest.slice(1).join(' ').trim();

  if (companyId && !holderName) {
    throw new UserError(
      'Кога земаш сметка за фирма, треба и име на газдата — сметката оди на негово име.\n' +
        '  пр. verify ' + accountNumber(account.iban) + ' ' + PRIMARY_ALIASES[account.bankCode] +
        ' ' + companyId + ' "Столе Николов"',
    );
  }

  const result = await api<Record<string, string | boolean | null>>('POST', '/accounts/verify', {
    iban: account.iban,
    ...(companyId ? { companyId, holderName } : {}),
  });

  console.log('');
  if (!result.exists) {
    console.log(fail('Не постои: ' + result.errorCode));
    return;
  }

  console.log(ok('Сметката постои и може да се поврзе.'));
  console.log('  IBAN:        ' + account.iban);
  console.log('  Банка:       ' + result.bankName + '  (код ' + result.bankCode + ')');
  console.log('  Сопственик:  ' + (result.accountHolderName ?? dim('нема — сметката не е земена')));
  console.log('  Статус:      ' + result.status + ' · ' + result.currency);

  if (result.linkStatus === 'CLAIMED') {
    console.log('');
    console.log(ok('Зачувана како сметка на ' + bold(String(result.companyId)) + ', на име ' + bold(String(result.accountHolderName)) + '.'));
  } else if (result.linkStatus === 'ALREADY_YOURS') {
    console.log('');
    console.log(ok('Веќе е ваша сметка (' + result.companyId + ') — ништо ново не е зачувано.'));
  } else {
    console.log(
      '  Фирма:       ' + (result.companyId ? String(result.companyId) : dim('слободна сметка')),
    );
    console.log('');
    console.log(dim('Додај фирма за да ја заземеш: verify ' + accountNumber(account.iban) + ' ' + PRIMARY_ALIASES[account.bankCode] + ' company-03'));
  }
}

async function cmdUnlink(args: string[]): Promise<void> {
  const { account, rest } = await resolveTarget(args, 'unlink <сметка> <банка> [фирма]', {
    trailingIsText: true,
  });

  const result = await api<{ linkStatus: string }>('POST', '/accounts/' + account.iban + '/unlink', {
    ...(rest[0] ? { companyId: rest[0] } : {}),
  });

  console.log(
    result.linkStatus === 'RELEASED'
      ? ok('Ослободена — нема сопственик, друга фирма може да ја земе.')
      : ok('Сметката веќе беше слободна.'),
  );
}

async function cmdDeposit(args: string[]): Promise<void> {
  const { account, rest } = await resolveTarget(args, 'deposit <сметка> <банка> <износ> [опис]');
  const amount = requireAmount(rest[0], 'износ');
  const description = rest.slice(1).join(' ') || undefined;

  const result = await api<{ newBalance: number; currency: string }>(
    'POST',
    '/accounts/' + account.iban + '/simulate/deposit',
    { amount, ...(description ? { description } : {}) },
  );

  console.log(
    ok('Уплатени ' + formatMoney(amount, result.currency) + ' на ' + accountNumber(account.iban) + ' (' + shortBank(account.bankCode) + ')'),
  );
  console.log('  Ново салдо: ' + bold(formatMoney(result.newBalance, result.currency)));
}

async function cmdWithdraw(args: string[]): Promise<void> {
  const { account, rest } = await resolveTarget(args, 'withdraw <сметка> <банка> <износ> [опис]');
  const amount = requireAmount(rest[0], 'износ');
  const description = rest.slice(1).join(' ') || undefined;

  const result = await api<{ newBalance: number; currency: string }>(
    'POST',
    '/accounts/' + account.iban + '/simulate/withdraw',
    { amount, ...(description ? { description } : {}) },
  );

  console.log(
    ok('Извадени ' + formatMoney(amount, result.currency) + ' од ' + accountNumber(account.iban) + ' (' + shortBank(account.bankCode) + ')'),
  );
  console.log('  Ново салдо: ' + bold(formatMoney(result.newBalance, result.currency)));
}

async function cmdLoan(args: string[]): Promise<void> {
  const { account, rest } = await resolveTarget(args, 'loan <сметка> <банка> <износ> <рати>');
  const amount = requireAmount(rest[0], 'износ');
  const installments = Number(rest[1]);

  if (!Number.isInteger(installments) || installments < 1) {
    throw new UserError('Бројот на рати мора да е цел број, пр. loan ' + accountNumber(account.iban) + ' ' + PRIMARY_ALIASES[account.bankCode] + ' 600000 24');
  }

  const result = await api<{ newBalance: number; currency: string; creditLine: CreditLine }>(
    'POST',
    '/accounts/' + account.iban + '/simulate/loan',
    { amount, totalInstallments: installments },
  );

  console.log(ok('Одобрен кредит ' + formatMoney(amount, result.currency) + ' на ' + installments + ' рати'));
  console.log('  Рата:         ' + bold(formatMoney(result.creditLine.installmentAmount, result.currency)) + ' месечно');
  console.log('  Прва рата:    ' + formatDate(result.creditLine.nextPaymentDate));
  console.log('  Останато:     ' + formatMoney(result.creditLine.remainingBalance, result.currency));
  console.log('  Ново салдо:   ' + bold(formatMoney(result.newBalance, result.currency)));
}

async function cmdPayroll(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);

  if (positional.length < 2) {
    throw new UserError('Форма: plata <компанија|сметка банка> <име:износ> [име:износ ...] [-y]');
  }

  let companyId: string;
  let accounts: string[];
  let payments: string[];

  if (isBankAlias(positional[1])) {
    // plata <сметка> <банка> <име:износ> ... — исплата од една конкретна сметка.
    const account = await resolveAccount(positional[0], positional[1]);
    companyId = account.companyId ?? 'company-unlinked';
    accounts = [account.iban];
    payments = positional.slice(2);
  } else {
    // plata <компанија> <име:износ> ... — банката бира од сите сметки на компанијата.
    companyId = positional[0];
    payments = positional.slice(1);
    const list = await api<{ items: ApiAccount[] }>(
      'GET',
      '/accounts?limit=200&status=ACTIVE&currency=MKD&companyId=' + encodeURIComponent(companyId),
    );

    if (list.items.length === 0) {
      throw new UserError(
        'Компанијата "' + companyId + '" нема активни MKD сметки. Провери со: accounts --company ' + companyId,
      );
    }
    accounts = list.items.map((account) => account.iban);
  }

  const parsed = payments.map((entry, index) => {
    const separator = entry.lastIndexOf(':');
    if (separator < 1) {
      throw new UserError('Работникот се пишува како име:износ, пр. "Ана Стојанова:45000" — добив "' + entry + '"');
    }
    const employeeName = entry.slice(0, separator).trim();
    const amount = requireAmount(entry.slice(separator + 1), 'плата за ' + employeeName);
    return { employeeId: 'emp-' + (index + 1), employeeName, amount };
  });

  if (parsed.length === 0) {
    throw new UserError('Нема внесени работници.');
  }

  const request = await api<{
    requestId: string;
    currency: string;
    allocation: Array<{ employeeName: string; amount: number; iban: string }>;
    accountTotals: Array<{ iban: string; totalDebited: number; balanceAfter: number; currency: string }>;
  }>('POST', '/payroll/requests', { companyId, payments: parsed, accounts });

  console.log('');
  console.log(bold('Предлог исплата') + '  ' + dim(request.requestId));
  for (const entry of request.allocation) {
    console.log(
      '  ' +
        truncate(entry.employeeName, 24).padEnd(26) +
        formatMoney(entry.amount, request.currency).padStart(14) +
        '  од  ' +
        accountNumber(entry.iban),
    );
  }
  console.log('');
  for (const total of request.accountTotals) {
    console.log(
      dim(
        '  ' +
          accountNumber(total.iban) +
          ': -' +
          formatMoney(total.totalDebited, total.currency) +
          ' → салдо ' +
          formatMoney(total.balanceAfter, total.currency),
      ),
    );
  }
  console.log('');

  if (!flags.y && !flags.yes && !flags.approve) {
    console.log(dim('Парите сè уште НЕ се исплатени. За потврда:'));
    console.log('  approve ' + request.requestId);
    console.log(dim('или за откажување: reject ' + request.requestId));
    return;
  }

  await cmdResolvePayroll([request.requestId], 'approve');
}

async function cmdResolvePayroll(args: string[], action: 'approve' | 'reject'): Promise<void> {
  const requestId = args[0];
  if (!requestId) throw new UserError('Форма: ' + action + ' <requestId>');

  const result = await api<{
    status: string;
    paymentCount?: number;
    accounts?: Array<{ iban: string; newBalance: number; currency: string; transactions: unknown[] }>;
  }>('POST', '/payroll/requests/' + requestId + '/' + action);

  if (action === 'reject') {
    console.log(ok('Исплатата е откажана. Ништо не е исплатено.'));
    return;
  }

  console.log(ok('Исплатени ' + result.paymentCount + ' плати.'));
  for (const account of result.accounts ?? []) {
    console.log(
      '  ' +
        accountNumber(account.iban) +
        ': ' +
        account.transactions.length +
        ' исплати, ново салдо ' +
        bold(formatMoney(account.newBalance, account.currency)),
    );
  }
}

async function cmdFailed(): Promise<void> {
  const result = await api<{ items: Array<Record<string, string | number>>; count: number }>(
    'GET',
    '/webhooks/failed?limit=20',
  );

  if (result.count === 0) {
    console.log(ok('Нема неиспратени webhook-и.'));
    return;
  }

  console.log('');
  for (const item of result.items) {
    console.log(
      String(item.id) + '  ' + String(item.eventType) + '  обиди: ' + item.attempts + '  ' + truncate(String(item.lastError), 50),
    );
  }
  console.log('');
  console.log(dim('Повторен обид: retry <id>'));
}

async function cmdRetry(args: string[]): Promise<void> {
  if (!args[0]) throw new UserError('Форма: retry <id>');
  const result = await api<{ delivered: boolean; lastError?: string }>(
    'POST',
    '/webhooks/failed/' + args[0] + '/retry',
  );

  console.log(result.delivered ? ok('Испратено.') : fail('Пак падна: ' + result.lastError));
}

// ------------------------------------------------------------------ resolving

/** Turns "<сметка> <банка>" (or a full IBAN) into a real account. */
async function resolveTarget(
  args: string[],
  usage: string,
  options: { trailingIsText?: boolean } = {},
): Promise<{ account: ApiAccount; rest: string[] }> {
  if (args.length === 0) throw new UserError('Форма: ' + usage);

  // A second token that is neither a bank nor a number is almost always a typo
  // in the bank name — say so instead of silently searching every bank. The
  // exception is a command like `verify <сметка> <фирма>`, where the bank may be
  // left out and the last word is free text.
  const second = args[1];
  const textAllowed = options.trailingIsText === true && args.length === 2;
  if (second !== undefined && !isBankAlias(second) && !/^[\d.,]+$/.test(second) && !textAllowed) {
    throw new UserError('Непозната банка "' + second + '". Список на кратенки: banks');
  }

  const hasBank = args.length > 1 && isBankAlias(args[1]);
  const account = await resolveAccount(args[0], hasBank ? args[1] : undefined);

  return { account, rest: args.slice(hasBank ? 2 : 1) };
}

async function resolveAccount(reference: string, bankToken?: string): Promise<ApiAccount> {
  const digits = reference.replace(/[\s-]/g, '');
  const bankCode = bankToken ? requireBankCode(bankToken) : undefined;

  const query = new URLSearchParams({ limit: '200' });
  if (bankCode) query.set('bankCode', bankCode);

  const { items } = await api<{ items: ApiAccount[] }>('GET', '/accounts?' + query.toString());

  if (/^MK\d{17}$/i.test(digits)) {
    const exact = items.find((account) => account.iban === digits.toUpperCase());
    if (!exact) throw new UserError('Нема сметка со IBAN ' + digits.toUpperCase());
    return exact;
  }

  if (!/^\d+$/.test(digits)) {
    throw new UserError('Сметката се внесува како бројки (или цел IBAN), добив "' + reference + '"');
  }

  // The account number is the middle 10 digits of the IBAN; accept any tail of it.
  const matches = items.filter((account) => accountNumber(account.iban).endsWith(digits));

  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    const where = bankCode ? ' во ' + BANK_SHORT_NAMES[bankCode] : '';
    const examples = items.slice(0, 3).map((account) => accountNumber(account.iban)).join(', ');
    throw new UserError(
      'Нема сметка што завршува на "' + digits + '"' + where + '.' +
        (examples ? ' Пробај некоја од: ' + examples + ' (цел список: accounts ' + (bankCode ? PRIMARY_ALIASES[bankCode] : '<банка>') + ')' : ''),
    );
  }

  const options = matches
    .slice(0, 8)
    .map((account) => '  ' + accountNumber(account.iban) + '  ' + shortBank(account.bankCode))
    .join('\n');
  throw new UserError('Повеќе сметки одговараат на "' + digits + '":\n' + options + '\nДодади банка или повеќе бројки.');
}

function requireBankCode(token: string): string {
  const code = bankCodeFromAlias(token);
  if (!code) {
    throw new UserError('Непозната банка "' + token + '". Список: banks');
  }
  return code;
}

function requireAmount(raw: string | undefined, label: string): number {
  const amount = Number(String(raw ?? '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new UserError('Невалиден ' + label + ': "' + (raw ?? '') + '"');
  }
  return Math.round(amount * 100) / 100;
}

// ------------------------------------------------------------------- http/api

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;

  try {
    response = await fetch(BASE_URL + path, {
      method,
      headers: {
        'X-API-Key': API_KEY,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new UserError(
      'Не можам да се поврзам на ' + BASE_URL + '. Дали серверот работи? (npm run start:dev)',
    );
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    const extras = Object.entries(payload)
      .filter(([key]) => !['errorCode', 'message'].includes(key))
      .map(([key, value]) => '  ' + key + ': ' + JSON.stringify(value))
      .join('\n');

    throw new UserError(
      String(payload.errorCode ?? response.status) + ': ' + String(payload.message ?? response.statusText) +
        (extras ? '\n' + extras : ''),
    );
  }

  return payload as T;
}

// -------------------------------------------------------------------- output

function printAccount(account: ApiAccount): void {
  console.log('');
  console.log(bold(accountNumber(account.iban)) + '   ' + account.bankName);
  console.log('  IBAN:        ' + account.iban);
  console.log('  Сопственик:  ' + (account.accountHolderName ?? dim('нема — сметката не е земена')));
  console.log('  Салдо:       ' + bold(formatMoney(account.balance, account.currency)));
  console.log('  Статус:      ' + account.status);
  console.log('  Компанија:   ' + (account.companyId ?? 'слободна сметка'));

  if (account.creditLine) {
    const credit = account.creditLine;
    console.log('  Кредит:      ' + formatMoney(credit.creditAmount, account.currency));
    console.log(
      '    рата ' + formatMoney(credit.installmentAmount, account.currency) +
        ' · платени ' + credit.installmentsPaid + '/' + credit.totalInstallments +
        ' · останато ' + formatMoney(credit.remainingBalance, account.currency),
    );
    console.log('    следна рата: ' + formatDate(credit.nextPaymentDate));
  } else {
    console.log('  Кредит:      нема');
  }
}

function printHelp(): void {
  console.log('');
  console.log(bold('Команди') + dim('  (сметка = последните цифри од бројот, банка = кратенка)'));
  console.log('');
  console.log('  ' + bold('deposit') + '  <сметка> <банка> <износ> [опис]     уплата на сметка');
  console.log('  ' + bold('withdraw') + ' <сметка> <банка> <износ> [опис]     подигање од сметка');
  console.log('  ' + bold('loan') + '     <сметка> <банка> <износ> <рати>      кредит + месечна рата');
  console.log('  ' + bold('plata') + '    <компанија> <име:износ> ...          исплата на плати (преглед)');
  console.log('  ' + bold('plata') + '    <сметка> <банка> <име:износ> ...     исплата од една сметка');
  console.log('  ' + bold('approve') + '  <requestId>                          потврди ја исплатата');
  console.log('  ' + bold('reject') + '   <requestId>                          откажи ја исплатата');
  console.log('');
  console.log('  ' + bold('accounts') + ' [банка] [--free] [--company X]       список на сметки');
  console.log('  ' + bold('show') + '     <сметка> <банка>                     состојба + кредит');
  console.log('  ' + bold('tx') + '       <сметка> <банка> [колку]             последни трансакции');
  console.log('  ' + bold('verify') + '   <сметка> <банка> [фирма] [газда]      проверка + заземање на сметка');
  console.log('  ' + bold('unlink') + '   <сметка> <банка> [фирма]             ослободи ја сметката');
  console.log('  ' + bold('banks') + '                                         кратенки на банките');
  console.log('  ' + bold('failed') + ' / ' + bold('retry') + ' <id>                        неиспратени webhook-и');
  console.log('');
  console.log(dim('Пример:  deposit 1234567890 stopanska 5000'));
  console.log(dim('         loan 1234567890 komercijalna 600000 24'));
  console.log(dim('         plata company-03 "Ана Стојанова:45000" "Марко Илиев:38000"'));
  console.log('');
}

function printBanks(): void {
  console.log('');
  for (const [code, name] of Object.entries(BANK_SHORT_NAMES)) {
    console.log('  ' + PRIMARY_ALIASES[code].padEnd(14) + dim('код ' + code + '  ') + name);
  }
  console.log('');
}

function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(fail(message));
}

// -------------------------------------------------------------------- helpers

function accountNumber(iban: string): string {
  return iban.slice(7, 17);
}

function shortBank(bankCode: string): string {
  return BANK_SHORT_NAMES[bankCode] ?? bankCode;
}

/** Fixed-width 16 chars, so table columns stay aligned. */
function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    pad(date.getDate()) + '.' + pad(date.getMonth() + 1) + '.' + date.getFullYear() +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return pad(date.getDate()) + '.' + pad(date.getMonth() + 1) + '.' + date.getFullYear();
}

function formatMoney(amount: number, currency: string): string {
  return (
    new Intl.NumberFormat('mk-MK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) +
    ' ' +
    currency
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

/** Splits a REPL line, keeping "quoted values" together. */
function splitArgs(line: string): string[] {
  const matches = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^["']|["']$/g, ''));
}

function parseFlags(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }

    const name = arg.replace(/^-+/, '').toLowerCase();
    const next = args[i + 1];

    if (next && !next.startsWith('-') && !['y', 'yes', 'approve', 'free', 'slobodni'].includes(name)) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }

  return { flags, positional };
}

function loadEnvFile(): void {
  const path = join(__dirname, '..', '.env');
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

const useColor = process.stdout.isTTY;
const bold = (text: string) => (useColor ? '[1m' + text + '[0m' : text);
const dim = (text: string) => (useColor ? '[2m' + text + '[0m' : text);
const ok = (text: string) => (useColor ? '[32m✔ ' + text + '[0m' : '✔ ' + text);
const fail = (text: string) => (useColor ? '[31m✖ ' + text + '[0m' : '✖ ' + text);

void main().catch((error) => {
  printError(error);
  process.exitCode = 1;
});
