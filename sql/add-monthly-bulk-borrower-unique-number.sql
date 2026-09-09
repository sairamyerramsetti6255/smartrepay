-- Add borrowerUniqueNumber to MonthlyBulk staging tables (LoanDisk borrower_unique_number).
-- Safe to re-run.

IF COL_LENGTH('dbo.MonthlyBulkSubjectData', 'borrowerUniqueNumber') IS NULL
BEGIN
    ALTER TABLE dbo.MonthlyBulkSubjectData
    ADD borrowerUniqueNumber VARCHAR(30) NULL;
END
GO

IF COL_LENGTH('dbo.MonthlyBulkContractData', 'borrowerUniqueNumber') IS NULL
BEGIN
    ALTER TABLE dbo.MonthlyBulkContractData
    ADD borrowerUniqueNumber VARCHAR(30) NULL;
END
GO

-- Backfill from stored LoanDisk JSON payloads.
UPDATE dbo.MonthlyBulkSubjectData
SET borrowerUniqueNumber = NULLIF(LTRIM(RTRIM(JSON_VALUE(RawBorrowerJson, '$.borrower_unique_number'))), '')
WHERE (borrowerUniqueNumber IS NULL OR LTRIM(RTRIM(borrowerUniqueNumber)) = '')
  AND RawBorrowerJson IS NOT NULL
  AND ISJSON(RawBorrowerJson) = 1
  AND JSON_VALUE(RawBorrowerJson, '$.borrower_unique_number') IS NOT NULL;
GO

UPDATE dbo.MonthlyBulkContractData
SET borrowerUniqueNumber = NULLIF(LTRIM(RTRIM(JSON_VALUE(RawLoanJson, '$.borrower_unique_number'))), '')
WHERE (borrowerUniqueNumber IS NULL OR LTRIM(RTRIM(borrowerUniqueNumber)) = '')
  AND RawLoanJson IS NOT NULL
  AND ISJSON(RawLoanJson) = 1
  AND JSON_VALUE(RawLoanJson, '$.borrower_unique_number') IS NOT NULL;
GO
