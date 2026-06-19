-- Add manual receipt source channel to SIL loan repayments (run once on Simplified_db)
IF COL_LENGTH('dbo.SILloanrepayments', 'ReceiptSource') IS NULL
  ALTER TABLE dbo.SILloanrepayments ADD ReceiptSource NVARCHAR(50) NULL;
GO

IF COL_LENGTH('dbo.SILloanrepayments', 'EntryType') IS NULL
  ALTER TABLE dbo.SILloanrepayments ADD EntryType NVARCHAR(20) NULL;
GO

IF COL_LENGTH('dbo.SILloanrepayments', 'Particulars') IS NULL
  ALTER TABLE dbo.SILloanrepayments ADD Particulars NVARCHAR(500) NULL;
GO

IF COL_LENGTH('dbo.SILloanrepayments', 'ReceiptFileName') IS NULL
  ALTER TABLE dbo.SILloanrepayments ADD ReceiptFileName NVARCHAR(260) NULL;
GO
