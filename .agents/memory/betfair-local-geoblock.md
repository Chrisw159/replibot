---
name: Betfair local geo-block
description: Why Betfair-dependent code can't be exercised locally and how to verify it instead.
---

# Betfair local geo-block

The local/dev Replit server cannot reach the Betfair API — Betfair geo-blocks the US IP the
container runs from. Any code path that calls `getMarketDetail`, login, or placement will fail to
connect locally.

**How to apply:** Verify Betfair-dependent changes via `pnpm run typecheck` + architect review only.
Do NOT attempt live end-to-end testing of Betfair flows from the dev environment — it will always
fail on the network call, not on your logic. Real verification happens on the droplet
(144.126.238.76) which has a permitted IP.
