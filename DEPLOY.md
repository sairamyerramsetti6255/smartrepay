# Deploy SmartRepay to Coolify

## 1. GitHub (done locally)

Repository: `git@github.com:sairamyerramsetti6255/smartrepay.git`

## 2. Coolify — new application

1. Open **Coolify** → **+ New Resource** → **Application**
2. **Source:** GitHub → select `sairamyerramsetti6255/smartrepay`
3. **Branch:** `main`
4. **Build pack:** **Dockerfile** (uses root `Dockerfile`)
5. **Port:** `3001`
6. **Health check path:** `/api/health` (not `/health`)
7. **App URL (Coolify-generated):** `https://sswg4o008gcgc40okk8skcw8.api.pbshope.in`

## 3. Build pack (fix `vite: not found` error)

**Recommended:** Coolify → **General** → **Build Pack** → select **Dockerfile** (uses root `Dockerfile`).

**Or Nixpacks:** uses `nixpacks.toml` which runs `NPM_CONFIG_PRODUCTION=false npm ci` so Vite installs.

**Critical:** In Coolify **Environment Variables**, for `NODE_ENV=production`:
- Uncheck **"Available at Buildtime"** (runtime only)
- If build still fails, delete `NODE_ENV` from build-time vars entirely

Build error `sh: vite: not found` = devDependencies skipped because `NODE_ENV=production` was set during build.

## 4. Environment variables (Coolify → Environment)

### Frontend (runtime — edit `config.json`, no rebuild)

After deploy, edit **`/app/dist/config.json`** (mount as persistent file) or update before redeploy:

```json
{
  "apiUrl": "/api",
  "useApi": true,
  "simplifiedApiUrl": "/simplified-api",
  "appUrl": "",
  "appName": "SmartRepay AI"
}
```

See `public/config.example.json` in the repo. The app fetches `/config.json` on load.

### Backend (runtime)

| Variable | Example | Required |
|----------|---------|----------|
| `NODE_ENV` | `production` | Yes (**runtime only**) |
| `PORT` | `3001` | Yes |
| `JWT_SECRET` | long random string | Yes |
| `LOANDISK_API_URL` | `https://simplifiedapi.meanhost.in/v1/api` | Yes |
| `LOANDISK_USERNAME` | `api_admin` | Yes |
| `LOANDISK_PASSWORD` | your password | Yes |
| `LOANDISK_BORROWER_ID` | `4617884` | Yes |
| `LOANDISK_FETCH_TIMEOUT_MS` | `180000` | Recommended |
| `OPENROUTER_API_KEY` | your key | Optional (PDF/AI ingest) |
| `RESET_APP_DATA` | `false` | Yes |

## 5. Persistent storage (SQLite)

Mount a volume in Coolify:

- **Container path:** `/app/server`
- **Purpose:** keep `smartrepay.db` across redeploys

Or mount only the DB file path if your Coolify version supports it.

## 6. Domain & HTTPS

**Use the Coolify URL** (from deploy logs / `COOLIFY_URL`):

- App: `https://sswg4o008gcgc40okk8skcw8.api.pbshope.in`
- Health: `https://sswg4o008gcgc40okk8skcw8.api.pbshope.in/api/health`

`https://smartrepay.pbshope.in` is a **different host** — it returns 404 until you add it as a **custom domain** in Coolify and point DNS to your server.

Leave `appUrl` empty in `config.json` — the app auto-detects `window.location.origin` (works on any domain).

1. Optional: Coolify → **Domains** → add `smartrepay.pbshope.in` + enable HTTPS
2. The app serves **UI + API** on one port — no separate frontend URL needed

## 7. After deploy

- Open your Coolify URL
- Login: `demo@smartrepay.local` / `demo1234` (change password in production)
- Borrowers sync automatically in the background after login
- **Ingest** → upload PDF → **Match** → **Run Matching**

## 8. Troubleshooting

| Issue | Fix |
|-------|-----|
| Build fails | Ensure `package-lock.json` exists at root and in `server/` |
| 502 / app not starting | Check logs; Node 22+ required |
| LoanDisk sync timeout | Increase `LOANDISK_FETCH_TIMEOUT_MS` |
| Data lost on redeploy | Add persistent volume for `/app/server` |

