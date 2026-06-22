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
		DECLARE @rv_amt DECIMAL(18,2) = TRY_CAST(JSON_VALUE(@Json,'$.EmiPaidAmount') AS DECIMAL(18,2));
		DECLARE @rv_expected DECIMAL(18,2) = TRY_CAST(JSON_VALUE(@Json,'$.ExpectedEMIAmount') AS DECIMAL(18,2));

		IF @rv_amt IS NOT NULL AND @rv_amt > 0
		BEGIN
			UPDATE dbo.Staging_BankTransactions
			SET EmiPaidAmount = @rv_amt
			WHERE Id = @rv_btid;
		END

		MERGE dbo.Staging_TransactionMatches AS T
		USING (SELECT @rv_btid AS BankTransactionId) AS S
		ON T.BankTransactionId = S.BankTransactionId
		WHEN MATCHED THEN UPDATE SET
			ReviewStatus = @rv_status,
			BorrowerId = COALESCE(@rv_bid, T.BorrowerId),
			LoanDiskBorrowerName = COALESCE(@rv_bname, T.LoanDiskBorrowerName),
			LoanNumber = COALESCE(@rv_loan, T.LoanNumber),
			ConfidenceScore = COALESCE(@rv_conf, T.ConfidenceScore),
			EmiPaidAmount = COALESCE(@rv_amt, T.EmiPaidAmount),
			ExpectedEMIAmount = COALESCE(@rv_expected, T.ExpectedEMIAmount),
			SummedExpectedEMI = COALESCE(@rv_expected, T.SummedExpectedEMI),
			AmountDiff = CASE
				WHEN @rv_amt IS NOT NULL AND @rv_expected IS NOT NULL THEN @rv_amt - @rv_expected
				ELSE T.AmountDiff
			END,
			MatchMethod = 'manual', MatchedAt = GETUTCDATE()
		WHEN NOT MATCHED BY TARGET THEN INSERT
			(BankTransactionId, ReviewStatus, BorrowerId, LoanDiskBorrowerName, LoanNumber,
			 ConfidenceScore, EmiPaidAmount, ExpectedEMIAmount, SummedExpectedEMI, AmountDiff, MatchMethod)
			VALUES (
				@rv_btid, @rv_status, @rv_bid, @rv_bname, @rv_loan, @rv_conf,
				@rv_amt, @rv_expected, @rv_expected,
				CASE WHEN @rv_amt IS NOT NULL AND @rv_expected IS NOT NULL THEN @rv_amt - @rv_expected ELSE NULL END,
				'manual'
			);

		SELECT 'True' AS Result, 'Updated' AS Message;
	END

	-- Exec CRIF_Operations '{"BorrowerId":"12345"}','Get_LoansByBorrowerId',''
	ELSE IF (@Condition = 'Get_LoansByBorrowerId')
	BEGIN
		DECLARE @rc_bid VARCHAR(50) = JSON_VALUE(@Json, '$.BorrowerId');

		SELECT 'True' AS Result, 'Details found' AS Message,
			CAST(l.LoanId AS NVARCHAR(100)) AS LoanNumber,
			CAST(l.BorrowerId AS VARCHAR(50)) AS BorrowerId,
			COALESCE(
				NULLIF(LTRIM(RTRIM(CONCAT(b.FirstName, ' ', b.LastName))), ''),
				NULLIF(LTRIM(RTRIM(b.FullName)), ''),
				CONCAT('Borrower ', l.BorrowerId)
			) AS BorrowerFullName,
			l.PrincipalAmount,
			l.PrincipalAmount AS DisbursedAmount,
			l.ReleasedDate AS DisbursedDate,
			COALESCE(
				NULLIF(CASE WHEN l.PendingDue > 0 THEN l.PendingDue END, NULL),
				CASE WHEN l.NumOfRepayments > 0 AND l.TotalAmountDue > 0
					THEN ROUND(l.TotalAmountDue / NULLIF(l.NumOfRepayments, 0), 2) END
			) AS ExpectedEMIAmount,
			l.TotalAmountDue AS TotalDue,
			l.TotalPaid,
			l.BalanceAmount AS LoanBalanceAmount,
			l.NumOfRepayments AS TotalInstallments,
			ISNULL(rc.Cnt, 0) AS InstallmentsPaid,
			lr.LastRepaymentDate AS EMILastPaidDate,
			l.BranchId,
			l.BranchName,
			CASE
				WHEN ISJSON(l.RawJson) = 1 AND JSON_VALUE(l.RawJson, '$.child_status_id') = '18' THEN 'current'
				ELSE 'active'
			END AS LoanStatus
		FROM dbo.SILLoans l
		LEFT JOIN dbo.SILBorrowers b
			ON b.BorrowerId = l.BorrowerId AND b.BranchId = l.BranchId
		OUTER APPLY (
			SELECT COUNT(*) AS Cnt
			FROM dbo.SILloanrepayments r
			WHERE r.LoanId = l.LoanId AND r.BranchId = l.BranchId
		) rc
		OUTER APPLY (
			SELECT MAX(r.RepaymentCollectedDate) AS LastRepaymentDate
			FROM dbo.SILloanrepayments r
			WHERE r.LoanId = l.LoanId AND r.BranchId = l.BranchId
		) lr
		WHERE CAST(l.BorrowerId AS VARCHAR(50)) = @rc_bid
		  AND (
			l.LoanStatusId = '1'
			OR (ISJSON(l.RawJson) = 1 AND JSON_VALUE(l.RawJson, '$.child_status_id') = '18')
		  )
		ORDER BY l.LoanId;
	END

	-- Exec CRIF_Operations '[{"BorrowerId":"1","LoanNumber":"100","AmountReceived":50,...}]','Save_ManualReceipt',''
	ELSE IF (@Condition = 'Save_ManualReceipt')
	BEGIN
		DECLARE @mr TABLE (
			BorrowerId VARCHAR(50), LoanNumber NVARCHAR(100), BranchId VARCHAR(50),
			BorrowerFullName NVARCHAR(255), AmountReceived DECIMAL(18,2), Particulars NVARCHAR(500),
			SourceChannel VARCHAR(20), EntryType VARCHAR(20), CollectedDate DATE,
			ReceiptFileName NVARCHAR(260), ReceiptDocumentId VARCHAR(36), EnteredBy NVARCHAR(255)
		);

		INSERT INTO @mr
		SELECT * FROM OPENJSON(@Json) WITH (
			BorrowerId VARCHAR(50), LoanNumber NVARCHAR(100), BranchId VARCHAR(50),
			BorrowerFullName NVARCHAR(255), AmountReceived DECIMAL(18,2), Particulars NVARCHAR(500),
			SourceChannel VARCHAR(20), EntryType VARCHAR(20), CollectedDate DATE,
			ReceiptFileName NVARCHAR(260), ReceiptDocumentId VARCHAR(36), EnteredBy NVARCHAR(255)
		);

		-- Persist the receipt to staging (this is the source of truth for the repayment history UI)
		DECLARE @insertedReceipts TABLE (
			Id INT, LoanNumber NVARCHAR(100), BranchId VARCHAR(50),
			AmountReceived DECIMAL(18,2), Particulars NVARCHAR(500), SourceChannel VARCHAR(20),
			EntryType VARCHAR(20), CollectedDate DATE, ReceiptFileName NVARCHAR(260)
		);

		INSERT INTO dbo.Staging_ManualReceipts (
			BorrowerId, LoanNumber, BranchId, BorrowerFullName, AmountReceived, Particulars,
			SourceChannel, EntryType, CollectedDate, ReceiptFileName, ReceiptDocumentId, EnteredBy
		)
		OUTPUT inserted.Id, inserted.LoanNumber, inserted.BranchId, inserted.AmountReceived,
			inserted.Particulars, inserted.SourceChannel, inserted.EntryType,
			inserted.CollectedDate, inserted.ReceiptFileName
			INTO @insertedReceipts (Id, LoanNumber, BranchId, AmountReceived, Particulars,
				SourceChannel, EntryType, CollectedDate, ReceiptFileName)
		SELECT
			BorrowerId, LoanNumber, BranchId, BorrowerFullName, AmountReceived, Particulars,
			SourceChannel, ISNULL(EntryType, 'manual'), CollectedDate, ReceiptFileName, ReceiptDocumentId, EnteredBy
		FROM @mr;

		-- Best-effort mirror into the loan repayment ledger. Wrapped so a schema
		-- mismatch can never fail the receipt save (staging already holds the row).
		IF COL_LENGTH('dbo.SILloanrepayments', 'ReceiptSource') IS NOT NULL
		BEGIN
			BEGIN TRY
				INSERT INTO dbo.SILloanrepayments (
					RepaymentId, LoanId, BranchId, RepaymentAmount, RepaymentCollectedDate,
					RepaymentDescription, RepaymentMethodId, EntryType, ReceiptSource, Particulars, ReceiptFileName
				)
				SELECT
					900000000000000 + i.Id,                         -- synthetic, collision-safe id for manual entries
					TRY_CAST(i.LoanNumber AS BIGINT),
					i.BranchId,
					i.AmountReceived,
					CONVERT(NVARCHAR(20), i.CollectedDate, 23),      -- store ISO yyyy-mm-dd
					i.Particulars,
					'manual',
					ISNULL(i.EntryType, 'manual'),
					i.SourceChannel,
					i.Particulars,
					i.ReceiptFileName
				FROM @insertedReceipts i
				WHERE TRY_CAST(i.LoanNumber AS BIGINT) IS NOT NULL;
			END TRY
			BEGIN CATCH
				-- ignore: Staging_ManualReceipts remains the source of truth for the UI
			END CATCH
		END

		SELECT 'True' AS Result, 'Saved' AS Message, (SELECT COUNT(*) FROM @mr) AS Inserted;
	END

	-- Exec CRIF_Operations '{}','Get_ManualReceipts',''
	ELSE IF (@Condition = 'Get_ManualReceipts')
	BEGIN
		SELECT 'True' AS Result, 'Details found' AS Message,
			Id, BorrowerId, LoanNumber, BranchId, BorrowerFullName, AmountReceived, Particulars,
			SourceChannel, EntryType, CollectedDate, ReceiptFileName, ReceiptDocumentId, EnteredBy, CreatedAt
		FROM dbo.Staging_ManualReceipts
		ORDER BY CreatedAt DESC, Id DESC;
	END

	-- Exec CRIF_Operations '{"LoanNumber":"100"}','Get_LoanRepayments',''
	-- Unified repayment ledger for one loan: synced LoanDisk repayments + manual
	-- receipts entered in SmartRepay. Manual rows always come from staging so a
	-- newly uploaded receipt shows up immediately, even if the SILloanrepayments
	-- mirror was skipped. Synced rows tagged 'manual' are excluded to avoid dupes.
	ELSE IF (@Condition = 'Get_LoanRepayments')
	BEGIN
		DECLARE @lr_loan NVARCHAR(100) = JSON_VALUE(@Json, '$.LoanNumber');
		DECLARE @lr_loanInt BIGINT = TRY_CAST(@lr_loan AS BIGINT);

		SELECT 'True' AS Result, 'Details found' AS Message, x.*
		FROM (
			SELECT
				CAST(r.SILRepaymentId AS NVARCHAR(50)) AS EntryId,
				'loandisk' AS Source,
				CAST(r.LoanId AS NVARCHAR(100)) AS LoanNumber,
				r.BranchId,
				r.BranchName,
				TRY_CAST(r.RepaymentCollectedDate AS DATE) AS RepaymentDate,
				r.RepaymentCollectedDate AS RepaymentDateRaw,
				r.RepaymentAmount AS Amount,
				r.PrincipalRepaymentAmount AS PrincipalAmount,
				r.InterestRepaymentAmount AS InterestAmount,
				r.FeesRepaymentAmount AS FeesAmount,
				r.PenaltyRepaymentAmount AS PenaltyAmount,
				r.RepaymentMethodId AS Method,
				r.RepaymentDescription AS Description,
				CAST(NULL AS VARCHAR(20)) AS SourceChannel,
				CAST(NULL AS NVARCHAR(500)) AS Particulars,
				CAST(NULL AS NVARCHAR(260)) AS ReceiptFileName,
				CAST(NULL AS VARCHAR(36)) AS ReceiptDocumentId,
				CAST(NULL AS NVARCHAR(255)) AS EnteredBy,
				r.SyncedAt AS CreatedAt
			FROM dbo.SILloanrepayments r
			WHERE r.LoanId = @lr_loanInt
			  AND (r.EntryType IS NULL OR r.EntryType <> 'manual')

			UNION ALL

			SELECT
				CAST(mr.Id AS NVARCHAR(50)) AS EntryId,
				'manual' AS Source,
				mr.LoanNumber,
				mr.BranchId,
				CAST(NULL AS NVARCHAR(300)) AS BranchName,
				TRY_CAST(mr.CollectedDate AS DATE) AS RepaymentDate,
				CONVERT(NVARCHAR(20), mr.CollectedDate, 23) AS RepaymentDateRaw,
				mr.AmountReceived AS Amount,
				CAST(NULL AS DECIMAL(18,2)) AS PrincipalAmount,
				CAST(NULL AS DECIMAL(18,2)) AS InterestAmount,
				CAST(NULL AS DECIMAL(18,2)) AS FeesAmount,
				CAST(NULL AS DECIMAL(18,2)) AS PenaltyAmount,
				'manual' AS Method,
				mr.Particulars AS Description,
				mr.SourceChannel,
				mr.Particulars,
				mr.ReceiptFileName,
				mr.ReceiptDocumentId,
				mr.EnteredBy,
				mr.CreatedAt
			FROM dbo.Staging_ManualReceipts mr
			WHERE mr.LoanNumber = @lr_loan
		) x
		ORDER BY x.RepaymentDate DESC, x.CreatedAt DESC;
	END
