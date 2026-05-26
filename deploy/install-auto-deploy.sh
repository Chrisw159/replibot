#!/bin/bash
# One-time setup: installs the auto-deploy cron on the droplet.
# Run this ONCE on the droplet as root. After that, pushes to GitHub
# auto-deploy within 60 seconds without any manual steps.

set -e
cd /opt/replibot

# Make script executable
chmod +x deploy/auto-deploy.sh

# Install cron entry (idempotent — replaces any existing one)
CRON_LINE="* * * * * /opt/replibot/deploy/auto-deploy.sh >> /var/log/replibot-deploy.log 2>&1"
(crontab -l 2>/dev/null | grep -v "replibot/deploy/auto-deploy.sh" ; echo "$CRON_LINE") | crontab -

touch /var/log/replibot-deploy.log

echo "Auto-deploy installed. Cron will pull + rebuild every minute if origin/main has new commits."
echo "Watch live log: tail -f /var/log/replibot-deploy.log"
echo
echo "Current crontab:"
crontab -l
