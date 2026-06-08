# SmartRepay AI

Loan repayment reconciliation for Simplified Lending Bahamas — ingest statements, match borrowers, resolve exceptions, reconcile, and export to LoanDisk.

## Stack

- **Frontend:** React 19, Vite, Tailwind CSS
- **Backend:** Node.js, Express, SQLite (local — no cloud required)
- **Matching:** Fuse.js fuzzy name/employer matching with confidence scores

## Quick start

```bash
# Install frontend + backend deps
npm install
npm install --prefix server

# Run API (port 3001) + UI (port 5173)
npm run dev
```

Open http://localhost:5173

**Demo login:** `demo@smartrepay.local` / `demo1234` (system_owner)

## Workflow

1. Sign in → click **Load demo data** on the dashboard
2. **Match** → Run Matching → confirm high-confidence matches
3. **Exceptions** → Review queue → confirm / reassign / reject
4. **Reconcile** → Approve posts → Export LoanDisk CSV

## Routes

| Path | Feature |
|------|---------|
| `/` | Dashboard KPIs, charts, SLA, activity |
| `/ingest` | CSV / Excel / PDF upload — PDF extracts credit transactions with pipe-delimited names |
| `/match` | AI matching engine |
| `/exceptions` | Exception queue + SLA buckets |
| `/reconcile` | Bank vs posted, human post approval |
| `/audit` | Searchable audit log |
| `/borrowers` | Borrower CRUD |
| `/settings/sla` | SLA thresholds (system_owner) |
| `/settings/rules` | Matching rules (system_owner) |
| `/reports/daily` | Daily reconciliation summary |

## API

Backend runs at `http://localhost:3001/api`

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `POST /auth/signin` | Login |
| `POST /auth/signup` | Register |
| `GET /borrowers` | List borrowers |
| `GET /transactions` | List transactions |
| `POST /matching/run` | Run batch matching |
| `POST /demo/seed` | Load demo data |
| `POST /ingest/parse` | Parse CSV/Excel statement (multipart `file`) |

Database file: `server/smartrepay.db` (auto-created)

### Excel ingest + AI mapping

Copy `server/.env.example` → `server/.env` and set `OPENROUTER_API_KEY` for non-standard bank column layouts. Standard Bahamas bank exports (Beneficiary, Reference Number, BSD amounts) parse without AI.

**If upload fails:** restart the API so it picks up the latest routes — `npm run dev` (or stop anything else on port 3001).

## Optional Supabase

The app previously used Supabase. It now defaults to the local Node API. To use Supabase again, set `VITE_USE_API=false` and configure `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, then run migration SQL in `supabase/migrations/`.

## Roles

`collections` · `mid_office` · `accounting` · `system_owner`

Settings pages require `system_owner`. Posting on Reconcile requires `accounting` or `system_owner`.
