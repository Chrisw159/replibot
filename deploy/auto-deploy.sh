#!/bin/bash
# Auto-deploy script — runs every minute via cron.
# Pulls from GitHub; if there are new commits, rebuilds containers.
# Designed to be silent on no-op, verbose on actual deploys.

set -e
cd /opt/replibot

LOCK=/tmp/replibot-deploy.lock
if [ -e "$LOCK" ]; then
  # Previous deploy still running — skip this tick
  exit 0
fi
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT

LOG=/var/log/replibot-deploy.log

BEFORE=$(git rev-parse HEAD)
git fetch origin main --quiet
AFTER=$(git rev-parse origin/main)

if [ "$BEFORE" = "$AFTER" ]; then
  exit 0
fi

echo "================ $(date -u +%Y-%m-%dT%H:%M:%SZ) ================" >> "$LOG"
echo "New commit detected: $BEFORE -> $AFTER" >> "$LOG"

git reset --hard origin/main >> "$LOG" 2>&1
docker-compose down >> "$LOG" 2>&1 || true
docker-compose up -d --build >> "$LOG" 2>&1
echo "Deploy complete." >> "$LOG"
