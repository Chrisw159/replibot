#!/bin/sh
# REPLIBOT — Hetzner first-time setup script
# Run this on your Hetzner server after copying the project files

set -e

echo "=== REPLIBOT Setup ==="

# Check Docker is installed
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Installing..."
  curl -fsSL https://get.docker.com | sh
  echo "Docker installed. You may need to log out and back in if you want to run Docker without sudo."
fi

# Check .env exists
if [ ! -f .env ]; then
  cp deploy/.env.production.example .env
  echo ""
  echo "Created .env file. Please edit it now with your credentials:"
  echo ""
  echo "  nano .env"
  echo ""
  echo "Then run: docker compose up -d --build"
  exit 0
fi

echo "Building and starting REPLIBOT..."
docker compose up -d --build

echo ""
echo "=== Done! ==="
echo "REPLIBOT is running at http://$(hostname -I | awk '{print $1}')"
echo ""
echo "View logs:  docker compose logs -f api"
echo "Stop:       docker compose down"
echo "Update:     git pull && docker compose up -d --build"
