---
name: Live droplet — access, control, and remote admin endpoint
description: How the production REPLIBOT droplet is reached, deployed, and controlled from Replit.
---

# Live droplet (production) — access & control

Production runs on a self-managed droplet at `144.126.238.76` (root), code in `/opt/replibot`,
docker compose stack (postgres + db-migrate + api + frontend). Separate from the Replit dev workspace.

## Remote admin endpoint (installed 17 Aug 2026) — primary control channel
A token-gated HTTP service runs on the droplet: `http://144.126.238.76:8844` (systemd unit
`replibot-admin`, script `/opt/replibot-admin/admin.py`, token in `/opt/replibot-admin/token`).
- `GET /health` — current commit + container status
- `POST /deploy` — git fetch/reset to origin/main + docker compose up -d --build
- `POST /exec` `{"cmd":"...","timeout":N}` — arbitrary shell (default 120s; exec timeout KILLS the command — run long builds with `nohup ... &` and poll)
Auth: `Authorization: Bearer $DROPLET_ADMIN_TOKEN` (Replit secret). **Why:** SSH keys in ~/.ssh get
wiped on workspace resets; this endpoint + secret survives.

## SSH (secondary)
Key `~/.ssh/replit_droplet` (ed25519, authorized on droplet 17 Aug 2026) — works but is wiped on
workspace reset. Re-bootstrap path if all access lost: user pastes an authorized_keys one-liner in the
DigitalOcean web console (user has console access only; the old passwords/secrets are invalid).

## Deploy pipeline (fixed 17 Aug 2026)
Push to GitHub origin/main → droplet cron (`deploy/auto-deploy.sh`, every minute) fetch/reset/rebuild,
or force it immediately via `POST /deploy`. Root causes of the historic "dead" auto-deploy, all fixed:
- docker-compose v1 crashed with `KeyError: 'ContainerConfig'` on container recreate → images rebuilt
  but old containers kept running. Fix: compose v2 plugin installed at
  /usr/local/lib/docker/cli-plugins; auto-deploy.sh now uses `docker compose`.
- Disk hit 99% (orphaned images) and builds failed with "no space left". `docker system prune -af`
  freed 15GB. Watch disk before builds: 24GB total, images are ~GB each.
**Always verify after deploying:** `GET :8844/health` must show the expected commit AND containers
recently recreated ("Up N seconds/minutes"). Compose v2 renamed containers `replibot-api-1` style.

## Workspace git quirks
- Workspace `origin` is GitHub (chrisw159/replibot). Task-agent merges also land there — expect
  divergence; pull/merge before pushing.
- A stale `.git/refs/remotes/origin/main.lock` (months old) once blocked fetches AND platform task
  merges; if fetch says "reference already exists"/lock exists with no git process, delete the lock.
