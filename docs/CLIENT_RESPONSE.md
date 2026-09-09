# Client feedback — response summary

## 1. Multiple file upload

**Yes.** You can upload multiple files in one action (e.g. bank statement + employer listing for the same date). Use **Ingest → Browse files** or drag multiple files onto the drop zone. Each file is parsed separately; **Import** stages all successful parses together.

## 2. PDF “no credit transactions”

Improvements made:

- Balance-delta credit detection retained for standard bank PDFs
- **Fallback:** if balance logic finds zero credits, positive transaction amounts are treated as credits
- Spreadsheet column labels expanded (Credit, Amount, Transaction Amount, Name, Borrower, Employer)

If a specific PDF still fails, send the file for regression testing.

## 3. Name matching (Jamaal Moss / Wilberson Smith)

**Root cause:** The engine allowed **last-name-only** matches (e.g. any “Smith”) and **subset name** matches without checking the first name (e.g. “Jamaal Moss” → “Clifford Jamaal Moss”).

**Fixes:**

- When the bank/payroll name has **first + last**, last-name-only matching is disabled
- Subset matches require the **first token** to agree (typo-tolerant)
- Tie-breaks prefer **first+last** over weaker match types
- Match grid shows **Name %** with reasoning on hover

Re-run matching after deploying to apply new rules to existing staged transactions.

## 4. Wilberson Smith

Loan Disk shows **Wilberson Wilberforce Smith** (#14381656). The issue was **wrong match** to another Smith, not missing data. See `server/docs/WILBERSON_DIAGNOSTIC.md` for SQL checks.

## 5. Weekly SQL sync

**Sync to SQL Server** on the Borrowers page pulls **active + current** loans from Loan Disk into:

- `SILBorrowers`
- `SILLoans`
- `SILloanrepayments`
- `Staging_LoandiskDueRecords` (matching index)

**Append/upsert only** — existing SQL rows are never deleted.

**Weekly schedule:** set in `server/.env`:

```env
LOANDISK_SYNC_ENABLED=true
LOANDISK_SYNC_CRON=0 2 * * 0
```

(Default: Sunday 02:00 UTC)

## 6. Matching score weights

Only **Name share** + **Amount share** must total **100%**. Other sliders (minimum name score, auto-match threshold, etc.) are separate cut-offs, not weights.
