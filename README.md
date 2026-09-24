# Mock Bank API

A standalone mock of North Macedonian open-banking behaviour, built for **BiznisMk**.
It owns 200 fake accounts across 11 real banks, answers account-verification and
sync calls, lets you trigger deposits / withdrawals / loans by hand, runs a
two-phase payroll flow, and pushes signed webhooks back to BiznisMk.

> This is a mock. IBANs look real but do not pass a MOD-97 checksum, auth is a
> single shared API key, and no money exists. Keep it in its own repo and its own
> Render service — never merge it into the BiznisMk backend.

**Stack:** NestJS 10 · TypeScript · Prisma 5 · PostgreSQL (same as BiznisMk, deployed separately).

---

## 1. Setup

```bash
npm install
cp .env.example .env        # then edit DATABASE_URL, API_KEY, webhook settings
npx prisma generate
npx prisma migrate deploy   # or: npx prisma migrate dev --name init
npm run seed                # 200 accounts across 11 banks
npm run start:dev           # http://localhost:4000
```

A local Postgres is all this needs. If you have Docker:

```bash
docker compose up -d
```

Otherwise point `DATABASE_URL` at an existing server — on this machine that is
**PostgreSQL 18 on port 5433**, not the default 5432 (5432 belongs to the
PostgreSQL 17 install, whose service is stopped). The mock bank uses its own
`mock_bank` database on that server, fully separate from BiznisMk's `biznismk`
database; `prisma migrate deploy` creates it on first run.

### Environment

| Variable | Meaning |
| --- | --- |
| `PORT` | HTTP port (default `4000`) |
| `DATABASE_URL` | Postgres connection string |
| `API_KEY` | Shared key every request must send as `X-API-Key` |
| `BIZNISMK_WEBHOOK_URL` | Where events are POSTed |
| `WEBHOOK_SIGNING_SECRET` | HMAC-SHA256 secret for `X-Signature` |
| `WEBHOOK_TIMEOUT_MS` | Per-attempt timeout (default `8000`) |
| `WEBHOOK_RETRY_BACKOFF_MS` | Retry ladder, comma separated (default `2000,10000,30000`) |

### What the seed produces

200 accounts, weighted by real market size — Комерцијална 42, Стопанска 38, НЛБ 34,
Халк 22, Шпаркасе 16, ProCredit 14, УНИБанка 12, ТТК 8, ЦКБ 6, Развојна 4, Silk Road 4.
Roughly 85% `ACTIVE` / 10% `BLOCKED` / 5% `CLOSED`, ~15% EUR, ~20% carry a credit
line, ~40% are pre-linked to one of ten mock companies (`company-01` … `company-10`)
and carry their owner name; the rest are deliberately unclaimed and therefore
in nobody's name. Every non-closed account also gets 4–14
transactions of plausible history, whose `balanceAfter` values reconcile exactly
with the current balance.

The seed is deterministic (`faker.seed(11)`) and prints five ready-to-use
IBANs when it finishes. It wipes the tables first, so re-running it is safe.

---

## 2. The `bank` console (no curl needed)

Everything below can also be driven by a small console that resolves accounts by
their account number plus a bank short name, so you never type an IBAN:

```bash
npm run bank
```

That opens a prompt where each scenario is one line:

```
банка> deposit 1234567890 stopanska 5000
✔ Уплатени 5.000,00 MKD на 1234567890 (Стопанска)
  Ново салдо: 105.000,00 MKD
```

Or run a single command without the prompt (`./bank` on bash, `bank.cmd` on
Windows, or `npm run bank -- <command>`):

```bash
./bank deposit 1234567890 stopanska 5000
```

| Command | What it does |
| --- | --- |
| `accounts [банка] [--free] [--company X]` | List accounts and their numbers |
| `show <сметка> <банка>` | Balance, status, credit line |
| `tx <сметка> <банка> [n]` | Last transactions |
| `verify <сметка> <банка> [фирма] [газда]` | The add-account check; with a company + owner it claims the account |
| `unlink <сметка> <банка> [фирма]` | Release the account for re-linking |
| `deposit <сметка> <банка> <износ> [опис]` | Deposit |
| `withdraw <сметка> <банка> <износ> [опис]` | Withdrawal |
| `loan <сметка> <банка> <износ> <рати>` | Loan + monthly installment |
| `plata <компанија> <име:износ> ...` | Payroll preview across the company's accounts |
| `plata <сметка> <банка> <име:износ> ...` | Payroll from one specific account |
| `approve` / `reject <requestId>` | Execute or cancel the payroll |
| `banks` | The bank short names |
| `failed` / `retry <id>` | Undelivered webhooks |

The account can be the full IBAN, the 10-digit account number, or just its last
few digits — the bank short name (`stopanska`, `komercijalna`, `nlb`, `halk`,
`sparkase`, `procredit`, `unibanka`, `ttk`, `ckb`, `razvojna`, `silkroad`, and
their Cyrillic spellings) narrows it down. Ambiguous digits list the candidates
instead of guessing. Add `-y` to `plata` to approve in the same step. The console
talks to the same HTTP API as the curl examples below, so webhooks fire exactly
the same way; point it elsewhere with `MOCK_BANK_URL`.

---

## 3. Auth

Every endpoint except `GET /health` requires the shared key:

```bash
curl http://localhost:4000/accounts/MK07300000000042425 \
  -H "X-API-Key: dev-mock-bank-key"
```

`Authorization: Bearer <key>` also works. A missing or wrong key returns
`401 { "errorCode": "UNAUTHORIZED", ... }`.

To keep the examples below short:

```bash
export KEY="dev-mock-bank-key"
export BASE="http://localhost:4000"
export IBAN="MK07300000000042425"   # replace with one the seed printed
```

---

## 4. Account verification (the "add card" flow)

```bash
curl -X POST "$BASE/accounts/verify" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"iban":"'"$IBAN"'"}'
```

```jsonc
{
  "exists": true,
  "iban": "MK07300000000042425",
  "bankName": "Комерцијална банка АД Скопје",
  "bankCode": "300",
  // Null until a company claims it — see below.
  "accountHolderName": null,
  "status": "ACTIVE",
  "currency": "MKD",
  "companyId": null,
  "linkStatus": "NOT_REQUESTED"
}
```

Unknown or malformed IBANs answer `200` with `{ "exists": false, "errorCode": "ACCOUNT_NOT_FOUND" }`
or `{ "exists": false, "errorCode": "INVALID_IBAN_FORMAT" }` — a failed lookup is
an answer, not an error.

### Claiming the account (first company wins)

**An account is in somebody's name only while a company holds it.** A free
account at this bank has `accountHolderName: null` — nobody has taken it yet.
Claiming it puts it in the name of the owner of the claiming company, so
`companyId` and `holderName` travel together:

```bash
curl -X POST "$BASE/accounts/verify" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"iban":"'"$IBAN"'","companyId":"company-03","holderName":"Столе Николов"}'
```

Sending `companyId` without `holderName` is refused with
`400 HOLDER_NAME_REQUIRED` rather than leaving a held account nameless.
Releasing the account (`/unlink`) clears the holder again.

The response carries `companyId` plus a `linkStatus`:

| `linkStatus` | Meaning |
| --- | --- |
| `CLAIMED` | The account was free and now belongs to this company |
| `ALREADY_YOURS` | This company had already linked it — verifying again is safe |
| `NOT_REQUESTED` | No `companyId` was sent; pure lookup, nothing was written |

Another company gets `409 ACCOUNT_ALREADY_LINKED` with the current owner's
`companyId` in the body, and a `CLOSED` account cannot be linked at all
(`409 ACCOUNT_CLOSED`). A `BLOCKED` account *can* be linked, so the app can show
the blocked state — flip that in `AccountsService.claim` if you want it refused.

The claim is a conditional update (`WHERE companyId IS NULL`), so two companies
verifying the same account at the same moment cannot both win — the loser gets
the 409.

To free an account up again while testing:

```bash
curl -X POST "$BASE/accounts/$IBAN/unlink" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{}'
```

Pass `{"companyId":"company-03"}` to only unlink when that company is the owner.

**The one-or-two-accounts-per-bank rule lives in BiznisMk, not here.** This endpoint
returns `bankCode` and `bankName` precisely so BiznisMk can check them against its
own linked-accounts table before persisting the link.

---

## 5. Account state and sync

```bash
curl "$BASE/accounts/$IBAN" -H "X-API-Key: $KEY"
```

```jsonc
{
  "iban": "MK07300000000042425",
  "bankName": "Комерцијална банка АД Скопје",
  "bankCode": "300",
  "accountHolderName": "Petrov Group ДООЕЛ Скопје",
  "companyId": "company-03",
  "currency": "MKD",
  "balance": 842150.25,
  "status": "ACTIVE",
  "accountType": "TRANSACTION",
  "creditLine": {
    "creditAmount": 1200000,
    "remainingBalance": 700000,
    "nextPaymentDate": "2026-10-01T00:00:00.000Z",
    "installmentAmount": 50000,
    "totalInstallments": 24,
    "installmentsPaid": 10
  },
  "lastSyncedAt": "2026-09-14T09:12:00.000Z",
  "createdAt": "2024-03-02T11:20:00.000Z"
}
```

`creditLine` is `null` on the ~80% of accounts without one.

### Finding accounts

`GET /accounts` is the directory the `bank` console uses to turn an account
number into an IBAN; it is also the quickest way to find test data by hand.
Filters: `bankCode`, `status`, `currency`, `companyId`, `unclaimed=true`,
`limit` (max 200), `offset`. Results come back richest first.

```bash
curl "$BASE/accounts?bankCode=200&status=ACTIVE&currency=MKD&limit=5" -H "X-API-Key: $KEY"
curl "$BASE/accounts?unclaimed=true&limit=5" -H "X-API-Key: $KEY"
```

### Transactions (cursor paginated, newest first)

```bash
curl "$BASE/accounts/$IBAN/transactions?limit=10" -H "X-API-Key: $KEY"
curl "$BASE/accounts/$IBAN/transactions?limit=10&cursor=<nextCursor>" -H "X-API-Key: $KEY"
```

```jsonc
{
  "iban": "MK07300000000042425",
  "items": [
    {
      "id": "0f0b...",
      "type": "CREDIT",
      "amount": 12500,
      "currency": "MKD",
      "description": "Уплата од купувач",
      "balanceAfter": 842150.25,
      "createdAt": "2026-09-13T08:41:00.000Z"
    }
  ],
  "limit": 10,
  "hasMore": true,
  "nextCursor": "0f0b..."
}
```

Keep passing `nextCursor` until `hasMore` is `false`. `limit` is capped at 200.

---

## 6. Simulation commands

These are the "trigger a scenario by hand" endpoints. All three move the balance
and fire a `TRANSACTION_CREATED` webhook. All three require the account to be
`ACTIVE` (`409 ACCOUNT_NOT_ACTIVE` otherwise).

### Deposit

```bash
curl -X POST "$BASE/accounts/$IBAN/simulate/deposit" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"amount": 50000, "description": "Уплата од купувач"}'
```

### Withdraw

```bash
curl -X POST "$BASE/accounts/$IBAN/simulate/withdraw" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"amount": 12000, "description": "Плаќање добавувач"}'
```

Returns `409 INSUFFICIENT_FUNDS` (with the current balance in the body) if the
account cannot cover it.

Both respond with:

```jsonc
{
  "iban": "MK07300000000042425",
  "currency": "MKD",
  "newBalance": 880150.25,
  "transaction": { "id": "...", "type": "CREDIT", "amount": 50000, "balanceAfter": 880150.25, "...": "..." }
}
```

### Loan

```bash
curl -X POST "$BASE/accounts/$IBAN/simulate/loan" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"amount": 600000, "totalInstallments": 24}'
```

Opens (or replaces) the credit line — `installmentAmount = amount / totalInstallments`,
`remainingBalance = amount`, `nextPaymentDate` one month out, `installmentsPaid = 0` —
and credits the principal to the account as a normal `CREDIT` transaction. The
response is the deposit shape plus the resulting `creditLine`.

---

## 7. Payroll (request → approve → execute)

### Phase 1 — preview, no money moves

```bash
curl -X POST "$BASE/payroll/requests" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "companyId": "company-03",
    "payments": [
      { "employeeId": "emp-1", "employeeName": "Ана Стојанова", "amount": 45000 },
      { "employeeId": "emp-2", "employeeName": "Марко Илиев",   "amount": 38000 }
    ],
    "accounts": ["MK07300000000042425", "MK07210000000011111"]
  }'
```

```jsonc
{
  "requestId": "8f2c...",
  "status": "PENDING_APPROVAL",
  "companyId": "company-03",
  "currency": "MKD",
  "allocation": [
    { "employeeId": "emp-1", "employeeName": "Ана Стојанова", "amount": 45000, "iban": "MK07300000000042425" },
    { "employeeId": "emp-2", "employeeName": "Марко Илиев",   "amount": 38000, "iban": "MK07300000000042425" }
  ],
  "accountTotals": [
    { "iban": "MK07300000000042425", "currency": "MKD", "balanceBefore": 842150.25,
      "totalDebited": 83000, "balanceAfter": 759150.25, "paymentCount": 2 }
  ],
  "ineligibleAccounts": []
}
```

How the allocation is computed: accounts are sorted by balance descending, and
each salary is assigned in full to the first account that can still cover it.
**A salary is never split across two accounts** — if no single account can cover
someone, the whole run is rejected:

```jsonc
// 422
{
  "errorCode": "INSUFFICIENT_FUNDS",
  "message": "No single account can cover these salaries in full",
  "currency": "MKD",
  "uncovered": [{ "employeeId": "emp-2", "employeeName": "Марко Илиев", "amount": 38000 }],
  "ineligibleAccounts": []
}
```

Every IBAN in `accounts` must be linked to the requesting `companyId` (claimed
through `POST /accounts/verify`). One that is not — someone else's account, or
nobody's yet — gets the same `404 ACCOUNT_NOT_FOUND` as an IBAN that does not
exist, so knowing another company's IBAN is never enough to pay from it.
Ownership is checked again at approval.

Only `ACTIVE` accounts in the payroll currency are used. Pass `"currency": "EUR"`
to run a EUR payroll; the default is `MKD`. Accounts that are blocked, closed, or
in the wrong currency are skipped and listed under `ineligibleAccounts` so
BiznisMk can explain the preview to the user.

Read a stored request back at any time:

```bash
curl "$BASE/payroll/requests/<requestId>" -H "X-API-Key: $KEY"
```

### Phase 2 — approve (money moves) or reject

```bash
curl -X POST "$BASE/payroll/requests/<requestId>/approve" -H "X-API-Key: $KEY"
curl -X POST "$BASE/payroll/requests/<requestId>/reject"  -H "X-API-Key: $KEY"
```

Approve creates one `DEBIT` per employee on their assigned account, updates the
balances, marks the request `COMPLETED`, and fires **one batched
`PAYROLL_COMPLETED` webhook** covering every touched account. Balances are
re-checked at approval time — if an account drained or was blocked between
preview and approval, approval fails with `409` and the request stays
`PENDING_APPROVAL` so it can be re-previewed.

Reject marks it `REJECTED`, moves nothing, fires nothing. Approving or rejecting
an already-resolved request returns `409 PAYROLL_REQUEST_NOT_PENDING`.

---

## 8. Webhooks

Every event is POSTed to `BIZNISMK_WEBHOOK_URL` with:

| Header | Value |
| --- | --- |
| `X-Signature` | `HMAC-SHA256(rawBody, WEBHOOK_SIGNING_SECRET)`, hex |
| `X-Event-Type` | `TRANSACTION_CREATED` or `PAYROLL_COMPLETED` |

### `TRANSACTION_CREATED` — deposit, withdraw, loan

```jsonc
{
  "eventType": "TRANSACTION_CREATED",
  "iban": "MK07300000000042425",
  "companyId": "company-03", // the company the account is linked to; null while unclaimed
  "currency": "MKD",
  "newBalance": 880150.25,
  "transactions": [
    { "id": "...", "type": "CREDIT", "amount": 50000, "currency": "MKD",
      "description": "Уплата од купувач", "balanceAfter": 880150.25,
      "createdAt": "2026-09-14T10:00:00.000Z" }
  ],
  "timestamp": "2026-09-14T10:00:00.000Z"
}
```

### `PAYROLL_COMPLETED` — one call for the whole run

```jsonc
{
  "eventType": "PAYROLL_COMPLETED",
  "requestId": "8f2c...",
  "companyId": "company-03",
  "ibans": ["MK07300000000042425"],
  "accounts": [
    { "iban": "MK07300000000042425", "currency": "MKD", "newBalance": 759150.25,
      "transactions": [ /* one DEBIT per employee paid from this account */ ] }
  ],
  "transactions": [ /* the same transactions, flattened */ ],
  "timestamp": "2026-09-14T10:05:00.000Z"
}
```

### Verifying the signature on the BiznisMk side

Compare against the **raw** body, before JSON parsing:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function isValidSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### Delivery and retries

Delivery is fire-and-forget: the HTTP call that triggered the event never waits
on BiznisMk. A non-2xx response or a timeout is retried **3 times** after the
first attempt with a `2s / 10s / 30s` backoff. If all four attempts fail, the
event is written to the `FailedWebhook` table — nothing is lost — and can be
inspected or replayed:

```bash
curl "$BASE/webhooks/failed?limit=20" -H "X-API-Key: $KEY"
curl -X POST "$BASE/webhooks/failed/<id>/retry" -H "X-API-Key: $KEY"
```

A successful replay deletes the row; a failed one bumps `attempts` and updates
`lastError`.

---

## 9. Errors

Every error has the same shape, plus context fields where useful:

```jsonc
{ "errorCode": "INSUFFICIENT_FUNDS", "message": "Account balance is lower than the requested withdrawal",
  "iban": "MK07...", "balance": 1200, "requested": 5000, "currency": "MKD" }
```

| Code | Status | When |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | Missing or wrong `X-API-Key` |
| `INVALID_IBAN_FORMAT` | 400 | IBAN is not `MK` + 17 digits |
| `ACCOUNT_NOT_FOUND` | 404 | No such account |
| `ACCOUNT_NOT_ACTIVE` | 409 | Account is `BLOCKED` or `CLOSED` |
| `ACCOUNT_ALREADY_LINKED` | 409 | Another company already linked this account |
| `ACCOUNT_CLOSED` | 409 | A closed account cannot be linked |
| `HOLDER_NAME_REQUIRED` | 400 | Claiming an account without the owner name |
| `INSUFFICIENT_FUNDS` | 409 / 422 | 409 on withdraw and on approval; 422 on payroll preview |
| `NO_ELIGIBLE_ACCOUNTS` | 422 | No supplied account is `ACTIVE` in the payroll currency |
| `CURRENCY_MISMATCH` | 409 | Account currency changed between preview and approval |
| `PAYROLL_REQUEST_NOT_FOUND` | 404 | Unknown `requestId` |
| `PAYROLL_REQUEST_NOT_PENDING` | 409 | Already approved or rejected |
| `WEBHOOK_NOT_FOUND` | 404 | Unknown failed-webhook id |
| `BAD_REQUEST` | 400 | Validation failure (details in `validationErrors`) |

Requests are logged one line each: `POST /accounts/MK07.../simulate/deposit 201 14ms`.

---

## 10. Deployment

### Vercel (current)

`vercel.json` runs the whole API as one function (`api/index.js` →
`src/serverless.ts`) in Frankfurt, next to its Neon database. The build
(`scripts/vercel-build.js`) generates the Prisma client, applies migrations on
production deploys only (over `DATABASE_URL_UNPOOLED`), and builds.

There is no process to keep retry timers in, so: a webhook's retry ladder runs
inside the request that fired it (kept alive with `waitUntil`, so keep
`WEBHOOK_RETRY_BACKOFF_MS` short), and whatever still fails is replayed once a
day by Vercel Cron calling `GET /webhooks/failed/replay`, which takes
`Authorization: Bearer $CRON_SECRET` instead of the API key.

### Render (alternative)

`render.yaml` provisions the web service and its Postgres. Set `API_KEY`,
`BIZNISMK_WEBHOOK_URL` and `WEBHOOK_SIGNING_SECRET` in the dashboard; the build
runs `prisma generate` and `prisma migrate deploy`. Seed once after the first
deploy with `npm run seed` from a Render shell.

## 11. Tests

```bash
npm test        # allocation, IBAN, webhook retry/signing, module wiring
npm run typecheck
```

The payroll allocator and the webhook retry ladder are covered directly — those
are the two places where a mistake would be expensive for BiznisMk.
