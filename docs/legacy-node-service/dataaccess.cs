public DataSet SaveBorrowersToDb(SimplifiedLend model)
{
    // UPDATED: Now returns a raw DataSet directly to the Manager layer 
    // to capture the identity columns returned by the Stored Procedure's OUTPUT clause.
    using (var cmd = this.MSSqlDatabase.Connection.CreateCommand() as SqlCommand)
    {
        cmd.CommandText = "SaveBorrowers";
        cmd.CommandType = CommandType.StoredProcedure;
        cmd.Parameters.AddWithValue("@JsonData", model.Json);

        using (SqlDataAdapter da = new SqlDataAdapter(cmd))
        {
            da.SelectCommand.CommandTimeout = 120; // 2 minutes timeout budget
            DataSet ds = new DataSet();
            da.Fill(ds);
            return ds;
        }
    }
}

public void SaveLatestLoanToDb(string loanJson, string repaymentJson, int borrowerInternalId, string branchId, int borrowerId)
{
    using (var cmd = MSSqlDatabase.Connection.CreateCommand() as SqlCommand)
    {
        cmd.CommandText = "SaveLatestBorrowerLoan";
        cmd.CommandType = CommandType.StoredProcedure;

        // 1. Core loan string data
        cmd.Parameters.AddWithValue("@JsonData", (object)loanJson ?? DBNull.Value);

        // 2. FIXED: Corrected parameter name to match SQL definition and added DBNull fallback safety
        cmd.Parameters.AddWithValue("@PaymentJsonData", (object)repaymentJson ?? DBNull.Value);

        // 3. Identity and mapping metrics
        cmd.Parameters.AddWithValue("@BorrowerInternalId", borrowerInternalId);
        cmd.Parameters.AddWithValue("@BranchId", branchId);
        cmd.Parameters.AddWithValue("@BorrowerId", borrowerId);

        if (MSSqlDatabase.Connection.State != ConnectionState.Open)
        {
            MSSqlDatabase.Connection.Open();
        }

        int affectedRows = cmd.ExecuteNonQuery();
    }
}