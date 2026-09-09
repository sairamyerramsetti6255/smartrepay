-- Staging table for the due_loans fast-path sync.
-- Columns match bulkInsertStagingRecords() in src/dataAccess.js.
-- Idempotent & non-destructive: creates the table if missing, otherwise just
-- adds any new columns. The sync upserts (MERGE) into this table.
IF OBJECT_ID(N'dbo.Staging_LoandiskDueRecords', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Staging_LoandiskDueRecords
    (
        Id                 INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        LoanNumber         NVARCHAR(100)  NULL,
        BorrowerId         VARCHAR(50)    NULL,
        BorrowerFullName   NVARCHAR(255)  NULL,
        ExpectedEMIAmount  DECIMAL(18,2)  NULL,   -- amortization_due (installment due)
        PrincipalAmount    DECIMAL(18,2)  NULL,   -- loan_principal_amount
        TotalLoanAmount    DECIMAL(18,2)  NULL,   -- == PrincipalAmount (loan principal)
        InterestAmount     DECIMAL(18,2)  NULL,   -- loan_interest_amount
        InterestRate       DECIMAL(9,4)   NULL,   -- loan_interest (e.g. 18.0000)
        TotalDue           DECIMAL(18,2)  NULL,   -- total_amount_due
        TotalPaid          DECIMAL(18,2)  NULL,   -- total_paid
        LoanBalanceAmount  DECIMAL(18,2)  NULL,   -- balance_amount
        BorrowerEmail      NVARCHAR(255)  NULL,
        BorrowerPhone      NVARCHAR(50)   NULL,
        EMILastPaidDate    DATETIME       NULL,
        LoanStatus         NVARCHAR(50)   NULL,
        BranchId           VARCHAR(50)    NULL,
        BranchName         NVARCHAR(150)  NULL,
        PreviousBranchId   VARCHAR(50)    NULL,   -- prior branch when a loan is re-attributed
        PreviousBranchName NVARCHAR(150)  NULL,
        SyncedAt           DATETIME       NOT NULL CONSTRAINT DF_Staging_LoandiskDueRecords_SyncedAt DEFAULT (GETUTCDATE())
    );

    CREATE INDEX IX_Staging_LoandiskDueRecords_LoanNumber ON dbo.Staging_LoandiskDueRecords (LoanNumber);
    CREATE INDEX IX_Staging_LoandiskDueRecords_BorrowerId ON dbo.Staging_LoandiskDueRecords (BorrowerId);
END
ELSE
BEGIN
    IF COL_LENGTH('dbo.Staging_LoandiskDueRecords', 'PreviousBranchId') IS NULL
        ALTER TABLE dbo.Staging_LoandiskDueRecords ADD PreviousBranchId VARCHAR(50) NULL;
    IF COL_LENGTH('dbo.Staging_LoandiskDueRecords', 'PreviousBranchName') IS NULL
        ALTER TABLE dbo.Staging_LoandiskDueRecords ADD PreviousBranchName NVARCHAR(150) NULL;
END
