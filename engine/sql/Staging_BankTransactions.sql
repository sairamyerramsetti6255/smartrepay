-- Unified staging table for client-uploaded transaction files
-- (bank statements + employer deduction reports, in PDF / Excel / CSV / text).
-- Only CREDIT rows are stored. EmiPaidAmount is the credited amount treated as
-- the EMI paid by the borrower. BorrowerName / NormalizedName are used to match
-- against Staging_LoandiskDueRecords.
-- Created only if missing so init-db is non-destructive (rows accumulate across
-- uploads; re-importing a file replaces only that file's rows).
IF OBJECT_ID(N'dbo.Staging_BankTransactions', N'U') IS NOT NULL
    RETURN;

CREATE TABLE dbo.Staging_BankTransactions
(
    Id              INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    FileName        NVARCHAR(260)  NOT NULL,
    FileType        VARCHAR(20)    NULL,          -- pdf | excel | csv | text
    SourceType      VARCHAR(20)    NULL,          -- bank | employer
    EmployerOrBank  NVARCHAR(255)  NULL,          -- e.g. "Bank of The Bahamas", "Cable Bahamas"
    TransDate       DATE           NULL,          -- received / transaction date
    ReferenceNo     VARCHAR(100)   NULL,
    Particulars     NVARCHAR(500)  NULL,          -- full description incl. "...|BorrowerName"
    BorrowerName    NVARCHAR(255)  NULL,          -- extracted employee/borrower name
    NormalizedName  VARCHAR(255)   NULL,          -- sorted name tokens for matching
    EmiPaidAmount   DECIMAL(18,2)  NULL,          -- credit amount = EMI paid
    UploadedDate    DATETIME       NULL,          -- when the client uploaded the file
    ImportedAt      DATETIME       NOT NULL CONSTRAINT DF_Staging_BankTransactions_ImportedAt DEFAULT (GETUTCDATE())
);

CREATE INDEX IX_Staging_BankTransactions_NormalizedName ON dbo.Staging_BankTransactions (NormalizedName);
CREATE INDEX IX_Staging_BankTransactions_BorrowerName  ON dbo.Staging_BankTransactions (BorrowerName);
CREATE INDEX IX_Staging_BankTransactions_FileName      ON dbo.Staging_BankTransactions (FileName);
