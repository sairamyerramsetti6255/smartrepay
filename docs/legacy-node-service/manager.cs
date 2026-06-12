private readonly Dictionary<string, string> _allBranches = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
{
    { "SimplifiedLending", "18279" },
    //{ "E&S", "26281" },
    //{ "SBDC", "16209" },
    //{ "SL_BusinessLoan", "36198" },
    //{ "SL Business loan", "36198" },
    //{ "LegacyBranch", "51238" }
};



public async Task<APIResponse> GetAllBorrowersRawAsync(BorrowerSearchRequest request)
{
    try
    {
        _logger.LogInformation("GetAllBorrowersRawAsync called - Filtering Active Borrowers via Native API POST Search Engine");

        var flatBorrowersList = new ConcurrentBag<BorrowerDto>();
        List<string> allBranchIds = _allBranches.Values.ToList();

        // =========================================================================
        // STEP 1: CONCURRENT STEP TO FETCH ALL BORROWERS ACROSS BRANCHES
        // =========================================================================
        var fetchTasks = allBranchIds.Select(async branchId =>
        {
            try
            {
                string branchName = _allBranches.FirstOrDefault(x => x.Value == branchId).Key;
                string searchUrl = $"https://api-main.loandisk.com/{_publicKey}/{branchId}/advanced_search_borrowers";

                var searchPayload = new LoandiskSearchPayload();
                string payloadJson = JsonConvert.SerializeObject(searchPayload);
                byte[] postBodyBytes = Encoding.UTF8.GetBytes(payloadJson);

                var borrowerResponseBytes = await SendLoandiskPostRequestAsync(searchUrl, postBodyBytes);
                if (borrowerResponseBytes == null) return;

                var jsonBorrowers = Encoding.UTF8.GetString(borrowerResponseBytes);
                var apiResponse = JsonConvert.DeserializeObject<LoandiskApiResponse>(jsonBorrowers);

                if (apiResponse?.Response?.Results != null)
                {
                    foreach (var innerList in apiResponse.Response.Results)
                    {
                        foreach (var borrower in innerList)
                        {
                            borrower.BranchId = branchId;
                            borrower.BranchName = branchName;
                            flatBorrowersList.Add(borrower);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to execute advanced search query on branch {BranchId}", branchId);
            }
        });

        await Task.WhenAll(fetchTasks);

        if (!flatBorrowersList.Any())
        {
            return new APIResponse(ResponseCode.SUCCESS, "No active (Current) records were returned by the server filters.", null);
        }

        // =========================================================================
        // STEP 2: BULK PERSISTENCE OF BORROWERS AND RETRIEVAL OF INTERNAL IDENTITY KEYS
        // =========================================================================
        string bulkJsonData = JsonConvert.SerializeObject(flatBorrowersList);

        var dbModel = new SimplifiedLend
        {
            Json = bulkJsonData,
            Condition = "SYNC",
            Type = "BULK_INSERT"
        };

        DataSet dbStatus = DataAccess.SaveBorrowersToDb(dbModel);
        bool isSuccess = dbStatus?.Tables[0]?.Rows.Count > 0 && dbStatus.Tables[0].Columns.Contains("InternalId");

        if (!isSuccess)
        {
            _logger.LogError("Database persistence failed or did not return operational mapping keys.");
            return new APIResponse(ResponseCode.ERROR, "Data fetched but borrower database identity pipeline failed.", null);
        }

        _logger.LogInformation("Successfully mapped {Count} borrowers to database table. Initiating dual-stage extraction pipeline...", dbStatus.Tables[0].Rows.Count);

        int processedLoansCount = 0;

        // =========================================================================
        // STEP 3: SEQUENTIAL MULTI-STAGE INTEGRATION LOOP (LOANS & REPAYMENTS)
        // =========================================================================
        using (var apiClient = new HttpClient())
        {
            apiClient.DefaultRequestHeaders.Clear();
            apiClient.DefaultRequestHeaders.Add("Authorization", "Basic " + _authToken);

            foreach (DataRow row in dbStatus.Tables[0].Rows)
            {
                int internalSno = Convert.ToInt32(row["InternalId"]);
                string branchId = row["BranchId"].ToString();
                int borrowerId = Convert.ToInt32(row["BorrowerId"]);

                try
                {
                    // 3A. Request precisely count/1 and enforce DESCENDING ID sort to catch the newest loan layout
                    string loanUrl = $"https://api-main.loandisk.com/{_publicKey}/{branchId}/loan/borrower/{borrowerId}/from/1/count/1?sort_by=loan_id&sort_direction=desc";

                    var loanResponse = await apiClient.GetAsync(loanUrl);
                    if (!loanResponse.IsSuccessStatusCode)
                    {
                        _logger.LogWarning("Failed to fetch loans for BorrowerId {BorrowerId} on Branch {BranchId}. Status: {Status}", borrowerId, branchId, loanResponse.StatusCode);
                        continue;
                    }

                    string loanJson = await loanResponse.Content.ReadAsStringAsync();

                    // Edge-Case Defense: Skip parsing execution if this borrower profile possesses no loan listings
                    if (string.IsNullOrWhiteSpace(loanJson) || loanJson.Contains("\"Results\":[]") || loanJson.Contains("\"Results\":null") || loanJson.Contains("\"Results\": null"))
                    {
                        continue;
                    }

                    // 3B. Dynamic Parsing to pull the active loan ID directly out of the raw text response
                    int extractedLoanId = ParseLoanIdFromRawPayload(loanJson);
                    string repaymentJson = null;

                    if (extractedLoanId > 0)
                    {
                        // 3C. Query the separate Repayments collection to capture the top ledger record line item
                        string repaymentUrl = $"https://api-main.loandisk.com/{_publicKey}/{branchId}/repayment/loan/{extractedLoanId}/from/1/count/1?sort_by=repayment_id&sort_direction=desc";

                        var repaymentResponse = await apiClient.GetAsync(repaymentUrl);
                        if (repaymentResponse.IsSuccessStatusCode)
                        {
                            string rawRepaymentText = await repaymentResponse.Content.ReadAsStringAsync();

                            // Ensure a payment event actually exists for this loan before passing data downward
                            if (!string.IsNullOrWhiteSpace(rawRepaymentText) &&
                                !rawRepaymentText.Contains("\"Results\":[]") &&
                                !rawRepaymentText.Contains("\"Results\":null") &&
                                !rawRepaymentText.Contains("\"Results\": null"))
                            {
                                repaymentJson = rawRepaymentText;
                            }
                        }
                    }

                    // 3D. Persist both independent JSON payload profiles safely to the database tier
                    DataAccess.SaveLatestLoanToDb(loanJson, repaymentJson, internalSno, branchId, borrowerId);
                    processedLoansCount++;
                }
                catch (Exception loanEx)
                {
                    // Fault Isolation Core Principle: Log contextual detail, isolate the failure, and keep running
                    _logger.LogError(loanEx, "Error processing multi-stage loan/payment sync loop for BorrowerId: {BorrowerId}", borrowerId);
                }
            }
        }

        return new APIResponse(ResponseCode.SUCCESS, $"Successfully synchronized {flatBorrowersList.Count} borrowers and updated {processedLoansCount} target account records with granular verification ledger details.", null);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Error executing GetAllBorrowersRawAsync workflow");
        return new APIResponse(ResponseCode.ERROR, $"An internal exception occurred: {ex.Message}", null);
    }
}

public async Task<byte[]> SendLoandiskPostRequestAsync(string url, byte[] payloadBytes)
{
    using (var client = new HttpClient())
    {
        client.DefaultRequestHeaders.Clear();
        client.DefaultRequestHeaders.Add("Authorization", "Basic " + _authToken);

        using (var content = new ByteArrayContent(payloadBytes))
        {
            content.Headers.ContentType = new MediaTypeHeaderValue("application/json");

            var response = await client.PostAsync(url, content);
            if (response.IsSuccessStatusCode)
            {
                return await response.Content.ReadAsByteArrayAsync();
            }

            _logger.LogError("Loandisk Advanced Search Error: Status code {StatusCode} received from {Url}", response.StatusCode, url);
            return null;
        }
    }
}

/// <summary>
/// Lightweight structural mapping block to safely read the root API collection value
/// </summary>
private int ParseLoanIdFromRawPayload(string rawJson)
{
    try
    {
        if (string.IsNullOrWhiteSpace(rawJson)) return 0;

        // Parse into a dynamic LINQ-to-JSON object
        var jObj = JObject.Parse(rawJson);

        // Safely navigate the nested multi-dimensional structure: response -> Results -> first array -> first object
        var firstResultArray = jObj["response"]?["Results"]?.FirstOrDefault();
        var firstLoanObject = firstResultArray?.FirstOrDefault();

        if (firstLoanObject != null && firstLoanObject["loan_id"] != null)
        {
            return firstLoanObject["loan_id"].Value<int>();
        }
    }
    catch (Exception ex)
    {
        // Log if needed, or suppress to isolate processing faults as before
        _logger.LogError(ex, "Failed to extract loan_id from raw JSON payload text stream.");
    }
    return 0;
}