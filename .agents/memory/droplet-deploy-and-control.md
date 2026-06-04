---
name: Live droplet — access, control, and broken auto-deploy
description: How the production REPLIBOT droplet is reached/controlled and why pushing code often does nothing.
---

# Live droplet (production) — access & control

Production runs on a self-managed droplet at `144.126.238.76` (root login), code in `/opt/replibot`,
docker-compose stack (postgres + db-migrate + api + frontend). This is SEPARATE from the Replit dev
workspace and its own Postgres.

## Pushing code to GitHub does NOT reliably deploy
The droplet is supposed to auto-deploy `origin/main` every minute (`deploy/auto-deploy.sh` cron:
git fetch → reset --hard → docker-compose up -d --build). In practice this has been DEAD — the
container ran the same image for 8+ days despite multiple pushes, and the live `/api/bot/config`
lacked fields that were merged to main long before. **Always verify the live server actually
runs new code; never assume a push deployed.** Quick check: `curl http://144.126.238.76/api/bot/config`
and look for expected new fields.

## Reaching the live server WITHOUT ssh — HTTP API is public
The droplet's API is reachable over plain HTTP at `http://144.126.238.76/api/...` with no auth.
Use this to read live state and to control the bots directly. Engines and stop endpoints (old build):
- main AI bot: `GET /api/bot/status`, `POST /api/bot/stop`, `POST /api/bot/start`
- dutch: `GET /api/dutch/status`, `POST /api/dutch/stop`
- dutch-v2: `GET /api/dutch-v2/list` (returns variants, e.g. `premium`, `conservative`),
  then `GET|POST /api/dutch-v2/<variant>/status|stop|start`
To stop ALL paper/real betting on old code (which has no data-collection gate), you must stop every
engine individually via these POSTs — there is no global kill switch in the old build.

## SSH access is ephemeral — keep the private key OUT of the workspace only at your peril
Prior sessions connected via `ssh -i /home/runner/.ssh/replibot_droplet root@144.126.238.76`.
`~/.ssh` is NOT in git and gets wiped on a workspace reset/rollback — the private key (and the
`DROPLET_PASSWORD` secret) were both erased, locking the agent out. **Why:** the only durable place
for credentials is a Replit secret, not `~/.ssh`. If re-establishing key access, store the private
key in a secret too, or expect to lose it on the next reset.
