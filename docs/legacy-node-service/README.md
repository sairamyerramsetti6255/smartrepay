# LoanDisk Sync Service (Node.js)

Optimised Node.js rewrite of the original C# reconciliation sync (`manager.cs`,
`dataaccess.cs`, `controller.cs`). It fetches borrowers, their latest loan and
their latest repayment from the LoanDisk API and persists them to SQL Server via
the existing stored procedures.

## Endpoint comparison (the biggest win)

`manager.cs` and the optimised sample in `repay.md` use **different LoanDisk
endpoints**. Picking the right endpoint matters far more than micro-tuning:

| | Legacy (`manager.cs`) | Fast path (`repay.md`) |
| --- | --- | --- |
| Endpoints | `advanced_search_borrowers` → `loan/borrower/{id}` → `repayment/loan/{id}` | `due_loans` (single) |
| API calls for N borrowers | `1 + 2N` | `ceil(total / 500)` |
| Round-trip pattern | mostly sequential | fully parallelisable |
| Data completeness | stitched from 3 responses | loan + borrower + repayment fields in one row |

For a 5,000-borrower branch that is **~10,000 calls vs ~10 calls**. The Node
service implements the `due_loans` fast path as the default (`runDueLoansSync`)
and keeps the legacy 3-stage pipeline available behind `--legacy` /
`/api/GetAllBorrowers`.

The `due_loans` request returns these fields per row, mapped to the staging table:

| API field | Staging column |
| --- | --- |
| `loan_number` | `LoanNumber` |
| `full_name` | `BorrowerFullName` |
| `amortization_due` | `ExpectedEMIAmount` |
| `principal` | `TotalLoanAmount` |
| `loan_balance` | `LoanBalanceAmount` |
| `email_address` | `BorrowerEmail` |
| `mobile` | `BorrowerPhone` |
| `last_repayment` | `EMILastPaidDate` |
| `loan_status` | `LoanStatus` |

Rows whose `loan_status` is `Closed` / `Fully Paid` / `Settled` / `2` are skipped.

## Why it is faster

The original C# spent almost all of its time in **STEP 3** of
`GetAllBorrowersRawAsync`: a sequential `foreach` over every borrower, doing two
dependent HTTP calls each (latest loan, then latest repayment) and one blocking
DB write per borrower. For *N* borrowers that is `~2N` serial network round-trips
plus `N` serial DB round-trips.

| Bottleneck (C#) | Fix (Node) |
| --- | --- |
| Sequential `foreach` over borrowers | Bounded **parallel** processing (`BORROWER_CONCURRENCY`, default 20) via `mapWithConcurrency` |
| `new HttpClient()` per request → socket exhaustion + TLS handshake each call | Single shared keep-alive `fetch` client that pools sockets per origin |
| New DB connection per `SaveLatestLoanToDb` call | Shared `mssql` connection pool, writes flushed in parallel batches |
| Hardcoded public key / auth token | Loaded from `.env` (`config.js`) |
| `string.Contains("\"Results\":[]")` empty checks | Proper JSON parsing |
| One borrower error aborts nothing but blocks throughput | Per-item fault isolation; errors collected and reported |
| Single default search page | Parallel pagination over all branch pages |

Net effect: STEP 3 wall-clock time drops roughly proportional to the concurrency
factor (≈20× fewer serial waits with the default settings), matching the goals in
`repay.md`.

## Setup

```bash
cd "Node service"
npm install
cp .env.example .env   # then fill in credentials (PowerShell: copy .env.example .env)
```

Fill in `LOANDISK_PUBLIC_KEY`, `LOANDISK_AUTH_TOKEN`, `LOANDISK_BRANCHES` and the
`DB_*` SQL Server settings in `.env`.

## Run

Run the pipeline once from the CLI:

```bash
npm run sync
```

Or start the HTTP service:

```bash
npm start
```

CLI: `npm run sync` runs the fast `due_loans` path; `npm run sync -- --legacy`
runs the old 3-stage borrower pipeline.

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/due-loans/sync` | **Recommended** — fast `due_loans` fetch, wait for result |
| `POST` | `/api/reconciliation-pipeline/process` | Start the fast pipeline in the background |
| `GET`  | `/api/reconciliation-pipeline/status` | Poll background progress |
| `POST` | `/api/GetAllBorrowers` | Legacy 3-stage borrower pipeline |
| `GET`  | `/health` | Liveness probe |

## due_loans response shape & pagination

The live `due_loans` response was verified against the SimplifiedLending branch
(368 distinct due loans). Two quirks the parser handles:

1. `response.Results` is `[ { "1": {...}, "2": {...}, "N": { "total": "Total", ... } } ]`
   — an object keyed by row number, ending with a **totals/summary row** that is
   skipped (it has no `loan_id` / `loan_number`).
2. `last_repayment` is `"05/27/2026 <br>353.74"` (date `<br>` amount); only the
   date is kept for `EMILastPaidDate`.

`from` is a **1-based page number**, but the server caps page size internally and
`TotalResults` over-counts (it counts due *installments*, not distinct loans).
So the client pages **sequentially until an empty page** rather than trusting
`TotalResults` — for due_loans that is only a few calls.

## ⚠️ Environment variable precedence

`dotenv` does **not** override variables already present in the shell. If a stale
`LOANDISK_AUTH_TOKEN` is exported in your terminal it will mask the `.env` value
and cause `code 11 "Wrong access credentials"`. Clear it before running:

```powershell
Remove-Item Env:LOANDISK_AUTH_TOKEN -ErrorAction SilentlyContinue
```

Run `node scripts/debugProbe.js` to confirm the token (length should be 40) and a
successful `due_loans` call.

## Transaction ingestion & matching (multi-format)

Clients upload transaction files from different banks/employers in different
formats. The service reads **only the credit rows**, extracts the borrower name,
particulars, reference and date, treats the credited amount as the **EMI paid**,
and stores everything in `Staging_BankTransactions` — then matches it against the
LoanDisk due loans.

```bash
npm run init-db                          # creates all staging tables (non-destructive)

# Import one or more files, or a whole folder:
npm run import -- "..\docs\5550002818 (2).pdf" "..\docs\transactions_5550002818 - 8th May 2026.xlsx" "..\docs\Cable Bahamas 8 May 2026 - Part 2.pdf" "..\docs\Inline Project - May 8, 2026.pdf"

npm run match                            # match names + EMI vs Staging_LoandiskDueRecords
```

### Supported formats (`src/statementParser.js`)

| Format | Example | How credits are detected |
| --- | --- | --- |
| Bank statement **PDF** | `5550002818 (2).pdf` | multi-line blocks; a row is a credit when the running balance rises by the row amount (seeded from *Balance Brought Forward*) |
| Bank statement **Excel** | `transactions_….xlsx` | columnar; `Transaction Type = Credit` |
| Employer **PDF** | `Cable Bahamas …`, `Inline Project …` | `Name / Amount` deduction lists; salary deduction = EMI paid |
| **CSV / text** | delimited exports | header aliases; credit columns |

Borrower name is taken from the `…|BorrowerName` portion of the particulars when
present, otherwise from the beneficiary/employee/name column. Verified counts:
bank PDF **1,569** (1,524,063.72), bank Excel **71**, Cable Bahamas **3**, Inline
Project **8** — total **1,651** credit rows.

### `Staging_BankTransactions`

| Column | Meaning |
| --- | --- |
| `FileName`, `FileType`, `UploadedDate`, `ImportedAt` | upload provenance |
| `SourceType` | `bank` or `employer` |
| `EmployerOrBank` | e.g. `Bank of The Bahamas`, `Cable Bahamas Ltd.` |
| `TransDate` | received / transaction date |
| `ReferenceNo`, `Particulars` | reference + full description (incl. `…|Name`) |
| `BorrowerName` | extracted borrower/employee name |
| `NormalizedName` | sorted name tokens (for matching) |
| `EmiPaidAmount` | credited amount = EMI paid by borrower |

Imports are **idempotent per file** (re-importing a file replaces only that
file's rows); rows from other files accumulate.

### Matching (`scripts/matchTransactions.js` → `Staging_TransactionMatches`)

Each credit's `BorrowerName` is matched to `Staging_LoandiskDueRecords.BorrowerFullName`
using token-based name similarity (handles `Lastname, Firstname` vs
`Firstname Lastname`, case, punctuation, middle names). The credited
`EmiPaidAmount` is compared to `ExpectedEMIAmount`:

- `name_and_amount` — name matches **and** amount matches (±0.05 / 1%)
- `name_only` — name matches but the paid amount differs from the expected EMI

## Layout

| File | Responsibility (C# equivalent) |
| --- | --- |
| `src/config.js` | Env-based configuration (replaces hardcoded constants) |
| `src/httpClient.js` | Shared keep-alive HTTP client with retry/timeout |
| `src/concurrency.js` | Bounded parallel `map` + chunking |
| `src/loandiskClient.js` | LoanDisk API calls (`manager.cs` network code) |
| `src/dataAccess.js` | SQL Server stored-procedure calls (`dataaccess.cs`) |
| `src/reconciliationManager.js` | Pipeline orchestration (`manager.cs`) |
| `src/controller.js` | HTTP routes (`controller.cs`) |
| `server.js` | Express bootstrap |
| `src/statementParser.js` | Multi-format statement → credit rows (PDF/Excel/CSV/text) |
| `src/nameMatch.js` | Borrower-name normalization + similarity scoring |
| `scripts/runSync.js` | CLI runner (LoanDisk sync) |
| `scripts/importTransactions.js` | CLI: parse + load transaction files |
| `scripts/matchTransactions.js` | CLI: match credits vs LoanDisk due loans |
| `scripts/initDb.js` | Applies every `sql/*.sql` (creates staging tables) |

## Tuning

All knobs live in `.env`:

- `BORROWER_CONCURRENCY` — parallel borrowers in flight (raise for more speed,
  lower if the API rate-limits you).
- `REQUEST_TIMEOUT_MS`, `MAX_RETRIES` — network resiliency.
- `DB_BATCH_SIZE` — rows flushed to SQL Server per batch.

> Note: this service expects the same SQL Server stored procedures the C# used —
> `SaveBorrowers` (returns `InternalId`, `BranchId`, `BorrowerId`) and
> `SaveLatestBorrowerLoan` (`@JsonData`, `@PaymentJsonData`, `@BorrowerInternalId`,
> `@BranchId`, `@BorrowerId`).
