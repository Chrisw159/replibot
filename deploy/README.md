# Deploying REPLIBOT to Hetzner

## What you need before starting

- SSH access to your Hetzner server (the IP address + root password or SSH key)
- Your Betfair login email, password, and **live** App Key from the Betfair Developer Portal
- Your xAI API key from https://console.x.ai
- A GitHub account to transfer the code (free)

---

## Step 1 — Push the code to GitHub (from Replit)

In the Replit shell, run:

```bash
git remote add origin https://github.com/YOUR_USERNAME/replibot.git
git push -u origin main
```

---

## Step 2 — SSH into your Hetzner server

On your computer, open Terminal (Mac/Linux) or PowerShell (Windows) and run:

```bash
ssh root@YOUR_SERVER_IP
```

---

## Step 3 — Install Docker on the server

Paste this and press Enter:

```bash
curl -fsSL https://get.docker.com | sh
```

Wait about 1 minute for it to finish.

---

## Step 4 — Download the code onto your server

```bash
git clone https://github.com/YOUR_USERNAME/replibot.git /opt/replibot
cd /opt/replibot
```

---

## Step 5 — Create your settings file

```bash
cp deploy/.env.production.example .env
nano .env
```

You'll see a text file. Fill in each value:

- **POSTGRES_PASSWORD** — make up any strong password, e.g. `MyDB_Pass_2025!`
- **SESSION_SECRET** — run `openssl rand -hex 32` in a separate terminal tab and paste the result
- **XAI_API_KEY** — your key from https://console.x.ai (starts with `xai-`)
- **BETFAIR_USERNAME** — your Betfair login email
- **BETFAIR_PASSWORD** — your Betfair password
- **BETFAIR_APP_KEY** — your live app key from the Betfair Developer Portal

Save with **Ctrl+O**, then exit with **Ctrl+X**.

---

## Step 6 — Launch REPLIBOT

```bash
docker compose up -d --build
```

The first build takes **3–5 minutes**. You'll see a lot of text scrolling past — that's normal.

When it's done, open your browser and go to:

```
http://YOUR_SERVER_IP
```

You should see the REPLIBOT dashboard. The database is set up automatically on first start.

---

## Step 7 — First-time setup in the app

1. Click **Settings** in the left menu
2. Check your Betfair credentials are showing correctly
3. Check your xAI key is saved

4. Click **Markets** — you should see live UK horse racing markets loading (this is the key difference from Replit — Betfair works from your EU server)

5. Click **Bot Control** — confirm **Paper Trading** is switched ON (this means no real money is bet yet)

6. Click **Start Bot**

7. Watch the **Dashboard** — every 30 seconds you'll see log entries as the bot scans races, filters them, calls Grok, and either places paper bets or explains why it skipped a race

---

## Step 8 — Going live with real money

Once you're happy with the paper trading results over a few days:

1. Go to **Bot Control**
2. Switch off **Paper Trading**
3. Click **Start Bot**

Real bets will now be placed on Betfair through your account.

---

## Updating after a code change

Pull the latest code and rebuild:

```bash
cd /opt/replibot
git pull
docker compose up -d --build
```

---

## Useful commands

```bash
# Watch live logs from the bot
docker compose logs -f api

# Restart just the bot
docker compose restart api

# Stop everything
docker compose down

# Check what's running
docker compose ps
```

---

## Optional: HTTPS with your own domain

If you have a domain name pointing at your server:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy
```

Change `HOST_PORT=8888` in your `.env`, then edit `/etc/caddy/Caddyfile`:

```
yourdomain.com {
    reverse_proxy localhost:8888
}
```

```bash
systemctl reload caddy
docker compose up -d
```

Your app will be at `https://yourdomain.com` with a free auto-renewing SSL certificate.
