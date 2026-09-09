-- Result of matching bank/employer credit transactions against LoanDisk due
-- loans by borrower name (first + last) and EMI amount, with an AI confidence
-- score. One row per bank transaction (upserted on BankTransactionId).
--
-- A single deposit can cover several of the same borrower's loans, so the
-- matched loan(s) are recorded in MatchedLoanNumbers / LoanCount and the
-- combined expected amount in SummedExpectedEMI.
IF OBJECT_ID(N'dbo.Staging_TransactionMatches', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Staging_TransactionMatches
    (
        Id                   INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        BankTransactionId    INT            NOT NULL,
        FileName             NVARCHAR(260)  NULL,
        BankBorrowerName     NVARCHAR(255)  NULL,
        LoanDiskBorrowerName NVARCHAR(255)  NULL,
        BorrowerId           VARCHAR(50)    NULL,
        LoanNumber           VARCHAR(100)   NULL,   -- primary / first matched loan
        MatchedLoanNumbers   VARCHAR(1000)  NULL,   -- comma list when a deposit pays many loans
        LoanCount            INT            NULL,    -- number of loans the deposit covers
        EmiPaidAmount        DECIMAL(18,2)  NULL,   -- amount deposited in the bank statement
        ExpectedEMIAmount    DECIMAL(18,2)  NULL,   -- single primary loan EMI
        SummedExpectedEMI    DECIMAL(18,2)  NULL,   -- sum of the matched loans' EMIs
        AmountDiff           DECIMAL(18,2)  NULL,   -- EmiPaid - SummedExpectedEMI
        MatchType            VARCHAR(30)    NULL,   -- name_and_amount | name_only | unmatched
        AmountMatchKind      VARCHAR(30)    NULL,   -- exact_single | sum_all | subset | partial | mismatch | none
        NameScore            INT            NULL,   -- 0-100 deterministic name similarity
        ConfidenceScore      DECIMAL(5,2)   NULL,   -- 0-100 overall confidence (AI-refined)
        MatchMethod          VARCHAR(20)    NULL,   -- deterministic | ai
        ReviewStatus         VARCHAR(20)    NULL,   -- auto_matched | needs_review | unmatched
        Reasoning            NVARCHAR(1000) NULL,   -- short explanation of the decision
        MatchedAt            DATETIME       NOT NULL CONSTRAINT DF_Staging_TransactionMatches_MatchedAt DEFAULT (GETUTCDATE())
    );

    CREATE UNIQUE INDEX UX_Staging_TransactionMatches_BankTxn ON dbo.Staging_TransactionMatches (BankTransactionId);
    CREATE INDEX IX_Staging_TransactionMatches_LoanNumber ON dbo.Staging_TransactionMatches (LoanNumber);
    CREATE INDEX IX_Staging_TransactionMatches_Review     ON dbo.Staging_TransactionMatches (ReviewStatus);
END
ELSE
BEGIN
    IF COL_LENGTH('dbo.Staging_TransactionMatches', 'BorrowerId') IS NULL
        ALTER TABLE dbo.Staging_TransactionMatches ADD BorrowerId VARCHAR(50) NULL;
    IF COL_LENGTH('dbo.Staging_TransactionMatches', 'MatchedLoanNumbers') IS NULL
        ALTER TABLE dbo.Staging_TransactionMatches ADD MatchedLoanNumbers VARCHAR(1000) NULL;
    IF COL_LENGTH('dbo.Staging_TransactionMatches', 'LoanCount') IS NULL
        ALTER TABLE dbo.Staging_TransactionMatches ADD LoanCount INT NULL;
    IF COL_LENGTH('dbo.Staging_TransactionMatches', 'SummedExpectedEMI') IS NULL
        ALTER TABLE dbo.Staging_TransactionMatches ADD SummedExpectedEMI DECIMAL(18,2) NULL;
    IF COL_LENGTH('dbo.Staging_TransactionMatches', 'AmountMatchKind') IS NULL
        ALTER TABLE dbo.Staging_TransactionMatches ADD AmountMatchKind VARCHAR(30) NULL;
    IF COL_LENGTH('dbo.Staging_TransactionMatches', 'ConfidenceScore') IS NULL
        ALTER TABLE dbo.Staging_TransactionMatches ADD ConfidenceScore DECIMAL(5,2) NULL;
    IF COL_LENGTH('dbo.Staging_TransactionMatches', 'MatchMethod') IS NULL
        ALTER TABLE dbo.Staging_TransactionMatches ADD MatchMethod VARCHAR(20) NULL;
    IF COL_LENGTH('dbo.Staging_TransactionMatches', 'ReviewStatus') IS NULL
        ALTER TABLE dbo.Staging_TransactionMatches ADD ReviewStatus VARCHAR(20) NULL;
    IF COL_LENGTH('dbo.Staging_TransactionMatches', 'Reasoning') IS NULL
        ALTER TABLE dbo.Staging_TransactionMatches ADD Reasoning NVARCHAR(1000) NULL;

    -- Ensure the upsert key exists (older versions allowed duplicates).
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Staging_TransactionMatches_BankTxn'
                   AND object_id = OBJECT_ID('dbo.Staging_TransactionMatches'))
       AND NOT EXISTS (SELECT BankTransactionId FROM dbo.Staging_TransactionMatches
                       GROUP BY BankTransactionId HAVING COUNT(*) > 1)
        CREATE UNIQUE INDEX UX_Staging_TransactionMatches_BankTxn ON dbo.Staging_TransactionMatches (BankTransactionId);
END
