# REPLIBOT — Betfair AI Betting Bot

## Overview

Full-stack automated betting bot for the Betfair Exchange with AI decision-making, live market browsing, strategy management, and P&L tracking. Similar to MarketFeederPro.

## Architecture

pnpm workspace monorepo with:
- **`artifacts/betbot`** — React + Vite frontend (port 22499, preview path `/`)
- **`artifacts/api-server`** — Express 5 backend (port 8080)
- **`lib/db`** — PostgreSQL + Drizzle ORM schema and client
- **`lib/api-spec`** — OpenAPI spec + Orval codegen
- **`lib/api-client-react`** — Generated React Query hooks
- **`lib/api-zod`** — Generated Zod validation schemas
- **`lib/integrations-openai-ai-server`** — Replit OpenAI AI integration (server-side)

## Tech Stack

- **Monorepo**: pnpm workspaces
- **Node.js**: 24, **TypeScript**: 5.9
- **Frontend**: React 19 + Vite, shadcn/ui, Tailwind CSS, Recharts, wouter
- **Backend**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (v4), drizzle-zod
- **API codegen**: Orval (from OpenAPI spec → React Query hooks + Zod schemas)
- **AI**: OpenAI GPT via Replit AI integration (env vars: `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_OPENAI_BASE_URL`)
- **Build**: esbuild

## Database Schema

Tables (all in `lib/db/src/schema/`):
- **`strategies`** — AI betting strategies (name, odds range, stake, betType, aiPrompt, aiModel, isActive)
- **`bets`** — Bet history (marketId, selectionId, odds, stake, profit, status, aiReasoning)
- **`bot_config`** — Bot configuration (isRunning, checkInterval, dailyLossLimit, paperTradingMode)
- **`bot_logs`** — Bot activity log (level, message, metadata)

## API Routes (`/api/...`)

- `GET/POST /betfair/status|connect|account` — Betfair connection management
- `GET /markets`, `GET /markets/:marketId` — Live Betfair markets
- `GET/POST/PATCH/DELETE /strategies` — Strategy CRUD
- `GET /bets`, `GET /bets/:id` — Bet history
- `GET/PATCH /bot/config` — Bot configuration
- `POST /bot/start|stop` — Bot control
- `GET /bot/status|logs` — Bot status and activity feed
- `GET /dashboard/summary|pnl-chart|recent-bets|strategy-performance` — Dashboard data

## Frontend Pages

- `/` — Dashboard (P&L stats, cumulative chart, strategy performance, recent bets)
- `/markets` — Live Betfair market browser with odds
- `/strategies` — AI strategy CRUD (min/max odds, stake, bet type, AI prompt)
- `/bets` — Paginated bet history with status color coding
- `/bot` — Bot control panel (start/stop, paper trading, config, system console)
- `/bookiebot` — Bookie Bot (proportional lay strategy, independent start/stop, race history)
- `/settings` — Betfair exchange connection (username/password/app key form)

## Key Files

- `lib/api-spec/openapi.yaml` — Full OpenAPI spec (source of truth for all API types)
- `artifacts/api-server/src/lib/betfair.ts` — Betfair API client (login, markets, place bets)
- `artifacts/api-server/src/lib/botEngine.ts` — AI bot cycle engine (runs on interval, calls OpenAI)
- `artifacts/api-server/src/routes/` — Express route handlers per domain
- `artifacts/betbot/src/pages/` — React page components
- `artifacts/betbot/src/components/Layout.tsx` — Sidebar navigation

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate hooks/schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

## Betfair Credentials

Credentials are NOT configured. To connect:
1. Via UI: Go to Settings page and enter username/password/app key
2. Via secrets: Set `BETFAIR_USERNAME`, `BETFAIR_PASSWORD`, `BETFAIR_APP_KEY` for auto-connect

Paper trading mode is enabled by default — no real money bets will be placed until paper mode is disabled in Bot Control.

## Notes

- The bot engine auto-connects to Betfair at the start of each cycle if credentials are available as secrets
- Daily loss limits are enforced: bot pauses when daily losses exceed the configured limit
- AI model is configurable per strategy (default: `gpt-5-mini`)
