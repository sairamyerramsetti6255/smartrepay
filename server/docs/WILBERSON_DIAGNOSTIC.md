# Wilberson Smith diagnostic guide

Production SQL check (requires `DB_PASSWORD` in `server/.env`):

```bash
node server/scripts/check-borrower.mjs Wilberson
node server/scripts/check-borrower.mjs 14381656
node server/scripts/check-borrower.mjs 8391195
```

## Expected root cause (code analysis)

- Bank statement: **Wilberson Smith** ($547.54)
- Loan Disk: **Wilberson Wilberforce Smith** (#14381656, loan 8391195, status Current)
- Wrong match: **Annalisa Deandra Smith** via `last_only` (shared surname `smith`, score 72)

## Fix applied

Name matching now disables `last_only` / `first_only` when the bank name has 2+ tokens, and requires first-token agreement for `token_overlap` when the bank name is first+last.

## SQL checks

1. `SILBorrowers` / `SILLoans` — borrower 14381656, loan 8391195, status current (child_status_id 18)
2. `Staging_LoandiskDueRecords` — `BorrowerFullName` like `%Wilberson%`, `ExpectedEMIAmount` ≈ 547.54
3. `Staging_TransactionMatches` — ref 2955045, inspect `NameScore`, `Reasoning`, `LoanDiskBorrowerName`
