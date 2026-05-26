#!/bin/bash
# One-time setup: installs the auto-deploy cron on the droplet.
# Idempotent — safe to re-run.

set -e
cd /opt/replibot

chmod +x deploy/auto-deploy.sh

# Install cron entry (replaces any existing replibot entry)
CRON_LINE="* * * * * /opt/replibot/deploy/auto-deploy.sh"
(crontab -l 2>/dev/null | grep -v "replibot/deploy/auto-deploy.sh" ; echo "$CRON_LINE") | crontab -

touch /var/log/replibot-deploy.log
chmod 666 /var/log/replibot-deploy.log

# Verify docker-compose is reachable from the path cron will use
TEST_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if env -i PATH=$TEST_PATH bash -c "command -v docker-compose" >/dev/null 2>&1; then
  echo "✓ docker-compose found in cron PATH"
else
  echo "✗ docker-compose NOT in cron PATH ($TEST_PATH) — auto-deploy will fail"
  echo "  Run: which docker-compose"
  echo "  Then symlink to /usr/local/bin, e.g.: ln -s \$(which docker-compose) /usr/local/bin/docker-compose"
  exit 1
fi

echo "Auto-deploy installed."
echo "Watch log: tail -f /var/log/replibot-deploy.log"
echo
echo "Current crontab:"
crontab -l
