-- ===========================================================================
-- NEW conditions appended to dbo.CRIF_Operations for the SmartRepay reconciliation
-- UI. These are spliced in BEFORE the procedure's final END and do NOT modify any
-- existing condition. Pattern matches the rest of the proc: parse @Json, branch on
-- @Condition, return result sets with Result / Message columns.
--
-- Conditions added:
--   Get_BankTransactions    -> grid of staged bank/payroll credits
--   Get_TransactionMatches  -> grid of credits LEFT JOINed to their match row
--   Get_MatchSummary        -> tile counts (active loans / total / matched / unmatched)
--   Save_BankTransactions   -> bulk insert credits (from a JSON array)
--   Save_TransactionMatches -> bulk upsert match results (from a JSON array)
--   Update_MatchReview      -> confirm / reject / reassign a single match
-- ===========================================================================

	-- Exec CRIF_Operations '{}','Get_BankTransactions',''
	ELSE IF (@Condition = 'Get_BankTransactions')
	BEGIN
		SELECT 'True' AS Result, 'Details found' AS Message,
			Id, FileName, FileType, SourceType, EmployerOrBank, TransDate, ReferenceNo,
			Particulars, BorrowerName, NormalizedName, EmiPaidAmount, UploadedDate, ImportedAt
		FROM Staging_BankTransactions
		ORDER BY ImportedAt DESC, Id DESC;
	END

	-- Exec CRIF_Operations '{}','Get_TransactionMatches',''
	ELSE IF (@Condition = 'Get_TransactionMatches')
	BEGIN
		SELECT 'True' AS Result, 'Details found' AS Message,
			bt.Id, bt.TransDate, bt.BorrowerName, bt.EmiPaidAmount, bt.ReferenceNo,
			bt.Particulars, bt.FileName, bt.SourceType, bt.EmployerOrBank,
			m.LoanDiskBorrowerName, m.BorrowerId, m.LoanNumber, m.MatchedLoanNumbers,
			m.LoanCount, m.SummedExpectedEMI, m.AmountDiff, m.MatchType, m.AmountMatchKind,
			m.NameScore, m.ConfidenceScore, m.MatchMethod, m.ReviewStatus, m.Reasoning
		FROM Staging_BankTransactions bt
		LEFT JOIN Staging_TransactionMatches m ON m.BankTransactionId = bt.Id
		ORDER BY bt.ImportedAt DESC, bt.Id DESC;
	END

	-- Exec CRIF_Operations '{}','Get_LoandiskDueRecords','' -- Active Loans grid + matching source
	ELSE IF (@Condition = 'Get_LoandiskDueRecords')
	BEGIN
		SELECT 'True' AS Result, 'Details found' AS Message,
			Id, LoanNumber, BorrowerId, BorrowerFullName, ExpectedEMIAmount,
			PrincipalAmount, TotalLoanAmount, InterestRate, InterestAmount,
			TotalDue, TotalPaid, LoanBalanceAmount, BorrowerEmail, BorrowerPhone,
			EMILastPaidDate, LoanStatus, BranchName, SyncedAt
		FROM Staging_LoandiskDueRecords
		ORDER BY CASE WHEN BorrowerFullName IS NULL OR BorrowerFullName = '' THEN 1 ELSE 0 END,
			BorrowerFullName ASC, LoanNumber ASC;
	END

	-- Exec CRIF_Operations '{}','Get_MatchSummary',''
	ELSE IF (@Condition = 'Get_MatchSummary')
	BEGIN
		-- Matched / Unmatched are only counted once a transaction has been PROCESSED
		-- by a matching run (i.e. it has a row in Staging_TransactionMatches).
		-- Transactions with no match row yet are "Pending" — not unmatched.
		SELECT 'True' AS Result, 'Details found' AS Message,
			(SELECT COUNT(*) FROM Staging_LoandiskDueRecords) AS ActiveLoans,
			(SELECT COUNT(*) FROM Staging_BankTransactions)   AS TotalTransactions,
			(SELECT COUNT(*) FROM Staging_BankTransactions bt
			 INNER JOIN Staging_TransactionMatches m ON m.BankTransactionId = bt.Id
			 WHERE m.ReviewStatus IN ('auto_matched','confirmed')) AS Matched,
			(SELECT COUNT(*) FROM Staging_BankTransactions bt
			 INNER JOIN Staging_TransactionMatches m ON m.BankTransactionId = bt.Id
			 WHERE m.ReviewStatus = 'unmatched') AS Unmatched,
			(SELECT COUNT(*) FROM Staging_BankTransactions bt
			 LEFT JOIN Staging_TransactionMatches m ON m.BankTransactionId = bt.Id
			 WHERE m.BankTransactionId IS NULL) AS Pending;
	END

	-- Exec CRIF_Operations '[{"FileName":"x.pdf","BorrowerName":"John","EmiPaidAmount":100}]','Save_BankTransactions',''
	ELSE IF (@Condition = 'Save_BankTransactions')
	BEGIN
		INSERT INTO Staging_BankTransactions
			(FileName, FileType, SourceType, EmployerOrBank, TransDate, ReferenceNo,
			 Particulars, BorrowerName, NormalizedName, EmiPaidAmount, UploadedDate)
		SELECT
			j.FileName, j.FileType, j.SourceType, j.EmployerOrBank, j.TransDate, j.ReferenceNo,
			j.Particulars, j.BorrowerName, j.NormalizedName, j.EmiPaidAmount,
			ISNULL(j.UploadedDate, GETUTCDATE())
		FROM OPENJSON(@Json) WITH (
			FileName NVARCHAR(260), FileType VARCHAR(20), SourceType VARCHAR(20),
			EmployerOrBank NVARCHAR(255), TransDate DATE, ReferenceNo VARCHAR(100),
			Particulars NVARCHAR(500), BorrowerName NVARCHAR(255), NormalizedName VARCHAR(255),
			EmiPaidAmount DECIMAL(18,2), UploadedDate DATETIME
		) j;

		SELECT 'True' AS Result, 'Saved' AS Message, @@ROWCOUNT AS Inserted;
	END

	-- Exec CRIF_Operations '[{"BankTransactionId":1,"ReviewStatus":"auto_matched"}]','Save_TransactionMatches',''
	ELSE IF (@Condition = 'Save_TransactionMatches')
	BEGIN
		MERGE dbo.Staging_TransactionMatches AS T
		USING (
			SELECT * FROM OPENJSON(@Json) WITH (
				BankTransactionId INT, FileName NVARCHAR(260), BankBorrowerName NVARCHAR(255),
				LoanDiskBorrowerName NVARCHAR(255), BorrowerId VARCHAR(50), LoanNumber VARCHAR(100),
				MatchedLoanNumbers VARCHAR(1000), LoanCount INT, EmiPaidAmount DECIMAL(18,2),
				ExpectedEMIAmount DECIMAL(18,2), SummedExpectedEMI DECIMAL(18,2), AmountDiff DECIMAL(18,2),
				MatchType VARCHAR(30), AmountMatchKind VARCHAR(30), NameScore INT, ConfidenceScore DECIMAL(5,2),
				MatchMethod VARCHAR(20), ReviewStatus VARCHAR(20), Reasoning NVARCHAR(1000)
			)
		) AS S ON T.BankTransactionId = S.BankTransactionId
		WHEN MATCHED THEN UPDATE SET
			T.FileName = S.FileName, T.BankBorrowerName = S.BankBorrowerName,
			T.LoanDiskBorrowerName = S.LoanDiskBorrowerName, T.BorrowerId = S.BorrowerId,
			T.LoanNumber = S.LoanNumber, T.MatchedLoanNumbers = S.MatchedLoanNumbers,
			T.LoanCount = S.LoanCount, T.EmiPaidAmount = S.EmiPaidAmount,
			T.ExpectedEMIAmount = S.ExpectedEMIAmount, T.SummedExpectedEMI = S.SummedExpectedEMI,
			T.AmountDiff = S.AmountDiff, T.MatchType = S.MatchType,
			T.AmountMatchKind = S.AmountMatchKind, T.NameScore = S.NameScore,
			T.ConfidenceScore = S.ConfidenceScore, T.MatchMethod = S.MatchMethod,
			T.ReviewStatus = S.ReviewStatus, T.Reasoning = S.Reasoning, T.MatchedAt = GETUTCDATE()
		WHEN NOT MATCHED BY TARGET THEN INSERT
			(BankTransactionId, FileName, BankBorrowerName, LoanDiskBorrowerName, BorrowerId,
			 LoanNumber, MatchedLoanNumbers, LoanCount, EmiPaidAmount, ExpectedEMIAmount,
			 SummedExpectedEMI, AmountDiff, MatchType, AmountMatchKind, NameScore, ConfidenceScore,
			 MatchMethod, ReviewStatus, Reasoning)
			VALUES
			(S.BankTransactionId, S.FileName, S.BankBorrowerName, S.LoanDiskBorrowerName, S.BorrowerId,
			 S.LoanNumber, S.MatchedLoanNumbers, S.LoanCount, S.EmiPaidAmount, S.ExpectedEMIAmount,
			 S.SummedExpectedEMI, S.AmountDiff, S.MatchType, S.AmountMatchKind, S.NameScore, S.ConfidenceScore,
			 S.MatchMethod, S.ReviewStatus, S.Reasoning);

		SELECT 'True' AS Result, 'Saved' AS Message, @@ROWCOUNT AS Affected;
	END

	-- Exec CRIF_Operations '{}','Get_Documents','' -- uploaded-file list derived from staged credits
	ELSE IF (@Condition = 'Get_Documents')
	BEGIN
		SELECT 'True' AS Result, 'Details found' AS Message,
			bt.FileName AS id,
			bt.FileName AS filename,
			MAX(bt.SourceType) AS document_type,
			MAX(bt.SourceType) AS source_type,
			MAX(bt.EmployerOrBank) AS employer_or_bank,
			MIN(bt.TransDate) AS date_from,
			MAX(bt.TransDate) AS date_to,
			COUNT(*) AS total_rows,
			SUM(CASE WHEN m.ReviewStatus IN ('auto_matched','confirmed') THEN 1 ELSE 0 END) AS matched_count,
			SUM(CASE WHEN m.ReviewStatus = 'unmatched' THEN 1 ELSE 0 END) AS unmatched_count,
			MAX(bt.UploadedDate) AS created_at
		FROM Staging_BankTransactions bt
		LEFT JOIN Staging_TransactionMatches m ON m.BankTransactionId = bt.Id
		GROUP BY bt.FileName
		ORDER BY MAX(bt.ImportedAt) DESC;
	END

	-- Exec CRIF_Operations '{"FileName":"x.pdf"}','Delete_Documents','' -- removes a file's credits + matches
	ELSE IF (@Condition = 'Delete_Documents')
	BEGIN
		DECLARE @del_file NVARCHAR(260) = JSON_VALUE(@Json, '$.FileName');

		DELETE m FROM Staging_TransactionMatches m
		INNER JOIN Staging_BankTransactions bt ON bt.Id = m.BankTransactionId
		WHERE bt.FileName = @del_file;

		DELETE FROM Staging_BankTransactions WHERE FileName = @del_file;

		SELECT 'True' AS Result, 'Deleted' AS Message, @@ROWCOUNT AS Deleted;
	END

	-- Exec CRIF_Operations '{"BankTransactionId":1,"ReviewStatus":"auto_matched","BorrowerId":"123"}','Update_MatchReview',''
	ELSE IF (@Condition = 'Update_MatchReview')
	BEGIN
		DECLARE @rv_btid INT          = TRY_CAST(JSON_VALUE(@Json,'$.BankTransactionId') AS INT);
		DECLARE @rv_status VARCHAR(20)= JSON_VALUE(@Json,'$.ReviewStatus');
		DECLARE @rv_bid VARCHAR(50)   = JSON_VALUE(@Json,'$.BorrowerId');
		DECLARE @rv_bname NVARCHAR(255)= JSON_VALUE(@Json,'$.BorrowerName');
		DECLARE @rv_loan VARCHAR(100) = JSON_VALUE(@Json,'$.LoanNumber');
		DECLARE @rv_conf DECIMAL(5,2) = TRY_CAST(JSON_VALUE(@Json,'$.Confidence') AS DECIMAL(5,2));

		MERGE dbo.Staging_TransactionMatches AS T
		USING (SELECT @rv_btid AS BankTransactionId) AS S
		ON T.BankTransactionId = S.BankTransactionId
		WHEN MATCHED THEN UPDATE SET
			ReviewStatus = @rv_status,
			BorrowerId = COALESCE(@rv_bid, T.BorrowerId),
			LoanDiskBorrowerName = COALESCE(@rv_bname, T.LoanDiskBorrowerName),
			LoanNumber = COALESCE(@rv_loan, T.LoanNumber),
			ConfidenceScore = COALESCE(@rv_conf, T.ConfidenceScore),
			MatchMethod = 'manual', MatchedAt = GETUTCDATE()
		WHEN NOT MATCHED BY TARGET THEN INSERT
			(BankTransactionId, ReviewStatus, BorrowerId, LoanDiskBorrowerName, LoanNumber, ConfidenceScore, MatchMethod)
			VALUES (@rv_btid, @rv_status, @rv_bid, @rv_bname, @rv_loan, @rv_conf, 'manual');

		SELECT 'True' AS Result, 'Updated' AS Message;
	END
