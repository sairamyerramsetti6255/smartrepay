# Deploy SmartRepay to Coolify

## 1. GitHub (done locally)

Repository: `git@github.com:sairamyerramsetti6255/smartrepay.git`

## 2. Coolify — new application

1. Open **Coolify** → **+ New Resource** → **Application**
2. **Source:** GitHub → select `sairamyerramsetti6255/smartrepay`
3. **Branch:** `main`
4. **Build pack:** **Dockerfile** (uses root `Dockerfile`)
5. **Port:** `3001`
6. **Health check:** `GET /api/health`

## 3. Environment variables (Coolify → Environment)

Set these in Coolify (never commit real values to git):

| Variable | Example | Required |
|----------|---------|----------|
| `NODE_ENV` | `production` | Yes |
| `PORT` | `3001` | Yes (Coolify may inject this) |
| `JWT_SECRET` | long random string | Yes |
| `LOANDISK_API_URL` | `https://simplifiedapi.meanhost.in/v1/api` | Yes |
| `LOANDISK_USERNAME` | `api_admin` | Yes |
| `LOANDISK_PASSWORD` | your password | Yes |
| `LOANDISK_BORROWER_ID` | `4617884` | Yes |
| `LOANDISK_FETCH_TIMEOUT_MS` | `180000` | Recommended |
| `OPENROUTER_API_KEY` | your key | Optional (PDF/AI ingest) |
| `RESET_APP_DATA` | `false` | Yes |

## 4. Persistent storage (SQLite)

Mount a volume in Coolify:

- **Container path:** `/app/server`
- **Purpose:** keep `smartrepay.db` across redeploys

Or mount only the DB file path if your Coolify version supports it.

## 5. Domain & HTTPS

1. Add your domain in Coolify (e.g. `smartrepay.yourdomain.com`)
2. Enable **HTTPS** (Let's Encrypt)
3. The app serves **UI + API** on one port — no separate frontend URL needed

## 6. After deploy

- Open your Coolify URL
- Login: `demo@smartrepay.local` / `demo1234` (change password in production)
- Borrowers sync automatically in the background after login
- **Ingest** → upload PDF → **Match** → **Run Matching**

## 7. Troubleshooting

| Issue | Fix |
|-------|-----|
| Build fails | Ensure `package-lock.json` exists at root and in `server/` |
| 502 / app not starting | Check logs; Node 22+ required |
| LoanDisk sync timeout | Increase `LOANDISK_FETCH_TIMEOUT_MS` |
| Data lost on redeploy | Add persistent volume for `/app/server` |
