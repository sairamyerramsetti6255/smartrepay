# Coolify — keep the API Running

Repo: `sairamyerramsetti6255/smartrepay` (this folder is the git root).

## Required Coolify settings

| Setting | Value |
|---------|--------|
| Build pack | **Dockerfile** (root `Dockerfile`) |
| Port | **3001** |
| Health check | **HTTP** · path **`/api/health`** · port **3001** |
| Storage mount | **`/app/data` only** (never `/app` or `/app/server`) |

Do **not** use a custom health command with `wget`/`curl` unless those binaries exist in the image (this Dockerfile installs both).

## After every push to `main`

1. Coolify → app → **Deploy** / **Force rebuild** (auto-deploy can lag or fail silently).
2. Wait until status is **Running** (not Restarting / Unhealthy).
3. Confirm: `https://sswg4o008gcgc40okk8skcw8.api.pbshope.in/api/health` returns JSON with `"ok":true`.

## 503 `no available server`

Traefik has **no healthy container**. Open **Logs** on the Coolify app — that line is the real crash reason. Common causes:

- Old image still on Restarting (force rebuild)
- Volume mounted at `/app` or `/app/server` shadowing `index.js`
- Wrong port / health path in Coolify UI
- Missing runtime env (`JWT_SECRET`, `PORT=3001`)
