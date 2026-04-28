# Deploying REPLIBOT to Hetzner

## 1. Install Docker on your Hetzner server

SSH into your server and run:

```bash
curl -fsSL https://get.docker.com | sh
```

## 2. Copy the project to your server

From your local machine (or Replit shell), use `rsync` or `scp`:

```bash
rsync -az --exclude node_modules --exclude '*/dist' --exclude .git \
  ./ root@YOUR_SERVER_IP:/opt/replibot/
```

Or push to GitHub and `git clone` on the server.

## 3. Create your environment file

On the server:

```bash
cd /opt/replibot
cp deploy/.env.production.example .env
nano .env
```

Fill in:

| Variable | Description |
|---|---|
| `POSTGRES_PASSWORD` | Make up a strong password |
| `SESSION_SECRET` | Run `openssl rand -hex 32` to generate one |
| `OPENAI_API_KEY` | From https://platform.openai.com |
| `BETFAIR_USERNAME` | Your Betfair login email |
| `BETFAIR_PASSWORD` | Your Betfair password |
| `BETFAIR_APP_KEY` | Your live app key from Betfair Developer portal |

## 4. Start everything

```bash
cd /opt/replibot
docker compose up -d --build
```

First build takes 3–5 minutes. The app will be live at `http://YOUR_SERVER_IP`.

## 5. Push the database schema (first time only)

Once the containers are running, push the DB schema from inside the container:

```bash
docker compose exec postgres psql -U replibot replibot -c "SELECT version();"
```

Then from your **Replit environment**, run the schema push pointing at Hetzner:

```bash
DATABASE_URL="postgres://replibot:YOUR_POSTGRES_PASSWORD@YOUR_SERVER_IP:5432/replibot" \
  pnpm --filter @workspace/db run push
```

(Replace `YOUR_POSTGRES_PASSWORD` and `YOUR_SERVER_IP` with your actual values.)

After the first push, the database port (5432) can be blocked in your Hetzner firewall for security — only port 80 (or 443) needs to be open for the app to work.

---

## Useful commands

```bash
# View live logs
docker compose logs -f api

# Restart just the API (after a code update)
docker compose up -d --build api

# Stop everything
docker compose down

# Full update after code change
git pull && docker compose up -d --build
```

## Setting up HTTPS with Caddy (optional but recommended)

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy
```

Change `HOST_PORT=8888` in your `.env`, then create `/etc/caddy/Caddyfile`:

```
your-domain.com {
    reverse_proxy localhost:8888
}
```

```bash
systemctl reload caddy
docker compose up -d
```

Your app is now at `https://your-domain.com` with automatic HTTPS.
