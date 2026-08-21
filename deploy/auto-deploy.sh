#!/bin/bash
# Auto-deploy script — runs every minute via cron.
# Pulls from GitHub; if there are new commits, rebuilds containers.

# CRITICAL: cron runs with a stripped PATH. docker compose (v2 plugin) lives in /usr/local/bin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

cd /opt/replibot || exit 1

LOG=/var/log/replibot-deploy.log
LOCK=/tmp/replibot-deploy.lock
DEPLOY_MARKER=/var/lib/replibot-deployed-commit

# Stale-lock guard: if lock is >10 min old, force-clear it (previous run crashed)
if [ -e "$LOCK" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK") ))
  if [ "$AGE" -gt 600 ]; then
    echo "$(date -u +%FT%TZ) Clearing stale lock (age ${AGE}s)" >> "$LOG"
    rm -f "$LOCK"
  else
    exit 0
  fi
fi
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# Don't use `set -e` — we want to log failures, not silently exit
BEFORE=$(git rev-parse HEAD 2>>"$LOG")
if ! git fetch origin main 2>>"$LOG"; then
  echo "$(date -u +%FT%TZ) git fetch failed" >> "$LOG"
  exit 1
fi
AFTER=$(git rev-parse origin/main 2>>"$LOG")
DEPLOYED=$(cat "$DEPLOY_MARKER" 2>/dev/null || true)

# A successful build records its commit. If a previous run pulled the code but
# failed during compose, retry that same commit instead of treating it as done.
if [ "$BEFORE" = "$AFTER" ] && [ "$DEPLOYED" = "$AFTER" ]; then
  exit 0
fi

echo "================ $(date -u +%FT%TZ) ================" >> "$LOG"
echo "Deploying $BEFORE -> $AFTER" >> "$LOG"

if [ "$BEFORE" != "$AFTER" ]; then
  git reset --hard origin/main >> "$LOG" 2>&1 || { echo "git reset FAILED" >> "$LOG"; exit 1; }
else
  echo "Retrying previously pulled but unbuilt commit $AFTER" >> "$LOG"
fi

# Compose is a Docker subcommand, not a standalone executable.
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose NOT FOUND in PATH=$PATH" >> "$LOG"
  exit 1
fi

docker compose down >> "$LOG" 2>&1 || echo "(down had errors, continuing)" >> "$LOG"
if docker compose up -d --build >> "$LOG" 2>&1; then
  printf '%s\n' "$AFTER" > "$DEPLOY_MARKER"
  echo "Deploy complete at $(date -u +%FT%TZ)" >> "$LOG"
else
  echo "BUILD FAILED at $(date -u +%FT%TZ)" >> "$LOG"
  exit 1
fi
