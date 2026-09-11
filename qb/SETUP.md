# QuickBooks Desktop integration setup

This integration targets **QuickBooks Desktop on Windows**, matching the original requirement. It does not use a QuickBooks Online API key. Desktop runs through the Intuit SDK on the PC that can access the company file. Conversational AI uses a separate OpenRouter key.

## Implemented

- Authenticated QuickBooks UI and accounting/admin-only mutation endpoints.
- Deterministic validation, unique borrower/loan linking (including missing middle names), preservation of source account splits, and configurable confidence-based approval.
- Bounded AI tool calling with argument validation, per-role tools, timeouts and persisted action results. Chat can reject all editable records on an explicit user instruction, with accounting permissions and an audit trail. It never rejects exported records or Desktop deliveries, invents splits, or enables posting.
- Optional hourly/daily scheduler; one pipeline at a time.
- Durable delivery queue, a Windows SDK worker, company-name verification, account inventory, and server acknowledgements containing actual QuickBooks transaction IDs.
- Idempotent acknowledgements, an on-disk worker receipt journal, and no automatic retry of an uncertain SDK write.
- Excel/IIF review downloads preserve original line accounts and amounts. File generation is distinct from QuickBooks posting.

## Server configuration

Set these in the server environment (not browser config or `dist/config.production.json`):

```dotenv
# Required for the Desktop worker; generate a long random secret yourself.
QB_DESKTOP_CONNECTOR_TOKEN=replace-with-a-random-secret-of-at-least-32-characters
QB_DESKTOP_COMPANY_NAME=Exact company name shown in QuickBooks
QB_DESKTOP_CURRENCY=BSD

# Optional conversational AI. Choose a model supporting tools.
OPENROUTER_API_KEY=your-openrouter-key
QB_AGENT_MODEL=openai/gpt-4o-mini

# Optional automatic schedules. Also enable automatic approval and select a
# schedule in the UI. Leave false until the sample-company test passes.
QB_RPA_SCHEDULER_ENABLED=false

# Optional server folder for generated review packages.
QB_EXPORT_DIR=data/exports
```

Restart SmartRepay to apply environment settings and the additive database migration. Existing records and matching thresholds are retained. Desktop posting starts disabled. Missing AI credentials leave deterministic pipeline processing available.

The application roles `accounting`, `system_owner`, `admin`, and `system_admin` can mutate QuickBooks records. Other roles can inspect records and use read-only chat tools. Connector credentials only reach heartbeat/claim/ack endpoints; they are not user-session credentials.

## Windows PC configuration

1. Install QuickBooks Desktop and the Intuit QuickBooks Desktop SDK / Request Processor. Install Python 3.10+ with a COM architecture compatible with the installed SDK, then `py -m pip install pywin32`.
2. Use a sample/test company first. Ensure its home currency is the configured currency. This implementation handles positive, single-currency deposits and checks; it does not perform exchange-rate conversion.
3. Create the bank and line accounts and borrower/payee entities in QuickBooks. Names must match the SmartRepay account/customer fields exactly, including parent/subaccount paths. The worker reads accounts and refuses missing/inactive mappings. It does not silently create customers or accounts.
4. Download `quickbooks_worker.py` from QuickBooks Data → RPA Automation. Configure these environment variables in the Windows session running it:

```powershell
$env:SMARTREPAY_CONNECTOR_URL = "https://your-smartrepay-server/api/quickbooks-connector"
$env:QB_DESKTOP_CONNECTOR_TOKEN = "same-secret-as-server"
$env:QB_DESKTOP_COMPANY_NAME = "same-exact-company-name"
$env:QB_DESKTOP_CURRENCY = "BSD"
$env:QB_COMPANY_FILE = "C:\QuickBooks\Company.qbw"
py .\quickbooks_worker.py
```

5. Open the company as its administrator and grant the SmartRepay integration permission when QuickBooks prompts. The worker uses `QBXMLRP2.RequestProcessor`, `OpenConnection2`, `BeginSession`, and `ProcessRequest`; it verifies the connected company name before claiming work.
6. Wait until the UI shows the worker connected and the correct company. Keep **Allow worker posting** off while reviewing the test record. Approve a balanced test entry, queue it, then enable posting for the sample company.
7. Confirm one Deposit or Check appears in QuickBooks with the expected amount, accounts, date and borrower/payee. Confirm the UI records its QuickBooks transaction ID. Repeat queueing; there must be no second posting.
8. Once tested, configure the production company and authorization. Run the worker persistently in the authorized Windows user session (for example, Windows Task Scheduler configured for that session). Do not run two workers with different journal locations against the same company.

HTTPS is required for remote worker traffic. Local development may use `http://localhost:3001/api/quickbooks-connector`.

## What each state means

- **Approved:** reviewed/validated locally; not yet posted.
- **Queued:** frozen snapshot waiting for the worker.
- **Processing:** one worker holds the delivery claim.
- **Posted:** QuickBooks returned a transaction ID and SmartRepay saved the acknowledgement. The source row becomes exported.
- **Failed:** a definite local preflight failure or explicit SDK rejection; correct the QuickBooks setup, then use Retry. To fix source fields, cancel the unsent delivery in the UI, edit/review the source, and queue it again. Cancellation retains an audit snapshot.
- **Uncertain:** SDK communication failed, the worker crashed during a write, or acknowledgement is overdue. Never automatically resend it. Inspect QuickBooks using `SmartRepay:<delivery-id>` in Memo and preserve the worker journal.

Pausing posting prevents new claims; an already claimed write may finish. Missing acknowledgements are replayed from the worker journal without replaying the SDK write. Keep `%USERPROFILE%\.smartrepay\quickbooks-worker.db` across restarts and upgrades. A crash before the returned transaction ID was persisted needs manual reconciliation; this system deliberately stops instead of risking a duplicate.

The pipeline does not invent repayment allocations or treat AI confidence as ledger correctness. Records without a unique borrower/loan link or a confidence score remain for manual approval. Changes to queued or posted records are blocked. Manual file exports are blocked while approved records have Desktop deliveries, preventing simultaneous export paths.

## Validation before live use

```sh
cd server
npm run test:quickbooks
python3 -m unittest discover -s qb/desktop -p 'test_*.py'
```

Automated tests use in-memory SQLite and a simulated SDK/provider. They exercise actual service logic, but **do not verify a real Windows/QuickBooks installation**. The sample-company posting test above is required to establish live interoperability. QuickBooks Online OAuth, account/customer creation, multicurrency and external CRIF/MCP servers are outside this Desktop connector.

References: [Intuit Desktop SDK guide](https://static.developer.intuit.com/resources/QBSDK_ProGuide.pdf), [OpenRouter tool-calling documentation](https://openrouter.ai/docs/guides/features/tool-calling).

## Excel requests and AI billing

Chat requests such as “open and fill it in Microsoft Excel” go through the AI model, which selects the `open_excel_workbook` tool. The tool enforces accounting permissions and approved records. If AI is unavailable, chat takes no action; it does not use a keyword fallback.

When server-side Excel launching is unavailable, the browser downloads the populated workbook; open `smartrepay_review.xlsx` in Microsoft Excel. A website cannot automatically launch Excel on a remote browser user's PC.

On a trusted local Mac server with Excel installed, `QB_ALLOW_SERVER_APP_LAUNCH=true` permits opening the generated workbook on that server computer. Leave this disabled on hosted servers.

An HTTP 402 response includes the provider's credit/billing explanation. The configured server key must belong to the funded OpenRouter account/organization and have remaining credit allowance. A valid key alone does not establish paid account status. Restart the backend after replacing its environment key. Never place the key in browser or production frontend config.

## Reconciliation workspace

The RPA page includes a live execution log, a review queue, and a downloadable reconciliation report. Progress comes from persisted stage events and refreshes while a run is active; no simulated percentages are used.

Review issues are recomputed from actual validation rules. A reviewer can correct source fields and account lines, select a borrower with an active loan, and explain the supporting evidence. Corrections are audited and revalidated. Saving does not approve. Approval checks that the reviewed version is still current, and in-flight/posted records cannot be edited.

Reports filter by transaction date and show current status at generation time. Totals are grouped by currency. File exports and confirmed SDK postings are counted separately; the report includes the actual QuickBooks IDs. Downloads are limited to 5,000 records; use a narrower period for larger datasets. This is a current-state report, not an historical as-of ledger reconstruction.

The agent can use `list_reconciliation_exceptions` and `get_reconciliation_report` to answer questions using these same results. These are read-only tools.
