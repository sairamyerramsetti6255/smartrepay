-- Manual receipt uploads (walk-in / WhatsApp / email / phone)
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Staging_ManualReceipts')
BEGIN
  CREATE TABLE dbo.Staging_ManualReceipts (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    BorrowerId VARCHAR(50) NOT NULL,
    LoanNumber NVARCHAR(100) NOT NULL,
    BranchId VARCHAR(50) NULL,
    BorrowerFullName NVARCHAR(255) NULL,
    AmountReceived DECIMAL(18,2) NOT NULL,
    Particulars NVARCHAR(500) NULL,
    SourceChannel VARCHAR(20) NOT NULL, -- walkin | whatsapp | email | phone
    EntryType VARCHAR(20) NOT NULL DEFAULT 'manual',
    CollectedDate DATE NOT NULL,
    ReceiptFileName NVARCHAR(260) NULL,
    ReceiptDocumentId VARCHAR(36) NULL,
    EnteredBy NVARCHAR(255) NULL,
    CreatedAt DATETIME NOT NULL DEFAULT GETUTCDATE()
  );
  CREATE INDEX IX_Staging_ManualReceipts_Borrower ON dbo.Staging_ManualReceipts (BorrowerId, CreatedAt DESC);
  CREATE INDEX IX_Staging_ManualReceipts_Loan ON dbo.Staging_ManualReceipts (LoanNumber, CreatedAt DESC);
END
GO
