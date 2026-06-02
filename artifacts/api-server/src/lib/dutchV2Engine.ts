// Dutch V2 paper-trading variants.
//
// Two variants, both ALWAYS paper-trading, that run the v2 strategy filters
// derived from the 13-day quant review (220 settled bets, 13-25 May 2026):
//   • Skip Hurdle races (lost £127 / -8.9% ROI)
//   • Skip NHF / Bumper races (lost £130 / -16.5% ROI)
//   • BACK_FAV (fav 2.0-2.5) only — skip 8-9 runner fields (-£233)
//   • LAY_FAV (fav 3.0-3.6) only when ≥8 runners (-£80 in smaller fields)
//   • LAY_TOP2 (fav ≥ 5.0) unchanged
//
// Variants differ ONLY in stake size + lock thresholds:
//   Premium      → stake £75, profit-lock £150, loss-stop £160 → backtest +£710
//   Conservative → stake £75, profit-lock £120, loss-stop £150 → backtest +£635
//
// Architecture mirrors dutchEngine.ts but is intentionally simpler: no
// schedule table, no Racing Post going lookup, no result-recovery for races
// we didn't bet on. Just scan → filter → place paper bet → settle.

import { logger } from "./logger";
import { db, betsTable, botLogsTable, botConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  getSession,
  listMarkets,
  getMarketDetail,
  getMarketSettlement,
  loginWithEnvCredentials,
} from "./betfair";

const MIN_MINS_BEFORE_START = 1;
const MAX_MINS_BEFORE_START = 4;
const MIN_BET_SIZE = 2.0;

const NON_WIN_PATTERN =
  /each.?way|forecast|\(f\/c\)|\bFC\b|\bRFC\b|reverse\s|straight\s+f|combination\s+f|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|trained\s+winner|named\s+fav|jockey.*champion|specials|scorecast|wincast/i;

// V2-specific race-type filters (case-insensitive)
const HURDLE_PATTERN = /\bhrd\b|hurdle/i;
const NHF_PATTERN    = /\bnhf\b|bumper/i;
const LAY_FAV_RACE_BLOCKLIST = /\b(Grp|Group|Listed)\b/i;

// V2 odds bands
const BACK_FAV_MIN = 2.0;
const BACK_FAV_MAX = 2.5;
const LAY_FAV_MIN  = 3.0;
const LAY_FAV_MAX  = 3.6;
const LAY_TOP2_MIN_FAV = 5.0;
const MAX_LAY_ODDS = 8.0;

// V2 runner-count filters
const BACK_FAV_BAD_RUNNERS_LO = 8;
const BACK_FAV_BAD_RUNNERS_HI = 9;
const LAY_FAV_MIN_RUNNERS = 8;

const MIN_LIQUIDITY = 3000;
const MIN_RUNNERS   = 5;
const MAX_RUNNERS   = 15;
const COUNTRY_CODES = ["GB", "IE"];

type ComboMode = "BACK_FAV" | "LAY_FAV" | "LAY_TOP2" | "SKIP";

interface ComboBet {
  selectionId: number;
  runnerName: string;
  backPrice: number;
  side: "BACK" | "LAY";
  stake: number;
  liability: number;
  profitIfWins: number;
}

interface ComboPlan {
  mode: ComboMode;
  bets: ComboBet[];
  reason: string;
}

export type V2VariantId = "premium" | "conservative";

interface V2VariantConfig {
  id: V2VariantId;
  strategyName: string;
  label: string;
  totalOutlay: number;        // £ per race (BACK stake / LAY liability)
  profitLockGBP: number;      // daily profit lock; 0 disables
  lossStopGBP: number;        // daily loss stop (positive number, treated as -£N); 0 disables
}

const VARIANT_CONFIGS: Record<V2VariantId, V2VariantConfig> = {
  premium: {
    id: "premium",
    strategyName: "Dutch V2 Premium",
    label: "V2 Premium",
    totalOutlay: 75,
    profitLockGBP: 150,
    lossStopGBP: 160,
  },
  conservative: {
    id: "conservative",
    strategyName: "Dutch V2 Conservative",
    label: "V2 Conservative",
    totalOutlay: 75,
    profitLockGBP: 120,
    lossStopGBP: 150,
  },
};

class DutchV2Variant {
  readonly config: V2VariantConfig;
  private logPrefix: string;
  private running = false;
  private startedAt: Date | null = null;
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private settlementTimer: ReturnType<typeof setInterval> | null = null;
  private processing = new Set<string>();
  private profitLatched = false;
  private lossLatched = false;
  private latchDate: string | null = null;

  constructor(config: V2VariantConfig) {
    this.config = config;
    this.logPrefix = `[DUTCH-V2-${config.id.toUpperCase()}]`;
  }

  // ── State accessors ────────────────────────────────────────────────────
  isRunning(): boolean { return this.running; }
  getStartedAt(): Date | null { return this.startedAt; }
  getConfig(): V2VariantConfig { return { ...this.config }; }

  // ── Logging ────────────────────────────────────────────────────────────
  private log(level: string, message: string, metadata?: Record<string, unknown>): void {
    const full = `${this.logPrefix} ${message}`;
    logger.info({ level, metadata }, full);
    db.insert(botLogsTable).values({
      level,
      message: full,
      metadata: metadata ? JSON.stringify(metadata) : null,
    }).catch((err: unknown) => logger.error({ err }, `${this.logPrefix} Failed to write log`));
  }

  // ── Daily P&L locks ────────────────────────────────────────────────────
  private utcDayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async getTodaysNet(): Promise<number> {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const nextStart = new Date(start.getTime() + 24 * 60 * 60_000);
    try {
      const [row] = await db
        .select({ net: sql<string>`coalesce(sum(${betsTable.actualProfit}::numeric), 0)::text` })
        .from(betsTable)
        .where(sql`${betsTable.strategyName} = ${this.config.strategyName}
                   AND ${betsTable.settledAt} IS NOT NULL
                   AND ${betsTable.settledAt} >= ${start}
                   AND ${betsTable.settledAt} <  ${nextStart}
                   AND ${betsTable.status} IN ('WON','LOST','VOID')
                   AND ${betsTable.actualProfit} IS NOT NULL`);
      return Number(row?.net ?? 0);
    } catch (err) {
      logger.error({ err }, `${this.logPrefix} getTodaysNet failed`);
      return 0;
    }
  }

  async getLockStatus(): Promise<{
    profitLock: { locked: boolean; net: number; target: number };
    lossStop:   { stopped: boolean; net: number; threshold: number };
  }> {
    const net = await this.getTodaysNet();
    const target    = this.config.profitLockGBP;
    const threshold = this.config.lossStopGBP;
    return {
      profitLock: { locked: target > 0 && net >= target, net, target },
      lossStop:   { stopped: threshold > 0 && net <= -threshold, net, threshold },
    };
  }

  private resetLatchesForNewDay(): void {
    const today = this.utcDayKey();
    if (this.latchDate !== today) {
      if (this.profitLatched) this.log("info", `Profit lock reset for new day ${today}`);
      if (this.lossLatched)   this.log("info", `Loss stop reset for new day ${today}`);
      this.profitLatched = false;
      this.lossLatched = false;
      this.latchDate = today;
    }
  }

  // ── V2 strategy planner ────────────────────────────────────────────────
  private planV2(
    eligible: Array<{ selectionId: number; runnerName: string; bestBackPrice: number }>,
    runnerCount: number,
    marketName: string,
  ): ComboPlan {
    if (eligible.length === 0) return { mode: "SKIP", bets: [], reason: "No eligible runners" };
    const outlay = this.config.totalOutlay;

    const sorted = [...eligible].sort((a, b) => a.bestBackPrice - b.bestBackPrice);
    const fav = sorted[0];
    const favPrice = fav.bestBackPrice;

    // BACK heavy favourite — V2: only 2.0-2.5 band, skip 8-9 runner fields
    if (favPrice >= BACK_FAV_MIN && favPrice <= BACK_FAV_MAX) {
      if (runnerCount >= BACK_FAV_BAD_RUNNERS_LO && runnerCount <= BACK_FAV_BAD_RUNNERS_HI) {
        return {
          mode: "SKIP",
          bets: [],
          reason: `V2: BACK_FAV skipped — ${runnerCount} runners in the ${BACK_FAV_BAD_RUNNERS_LO}-${BACK_FAV_BAD_RUNNERS_HI} dead band (-£233 historically)`,
        };
      }
      const stake = Math.round(outlay * 100) / 100;
      return {
        mode: "BACK_FAV",
        bets: [{
          selectionId: fav.selectionId,
          runnerName:  fav.runnerName,
          backPrice:   favPrice,
          side:        "BACK",
          stake,
          liability:   stake,
          profitIfWins: Math.round(stake * (favPrice - 1) * 100) / 100,
        }],
        reason: `V2 BACK fav at ${favPrice}`,
      };
    }

    // LAY favourite — V2: 3.0-3.6, require ≥8 runners, skip Group/Listed
    if (favPrice >= LAY_FAV_MIN && favPrice < LAY_FAV_MAX) {
      if (LAY_FAV_RACE_BLOCKLIST.test(marketName)) {
        return { mode: "SKIP", bets: [], reason: `V2: LAY_FAV skipped — Group/Listed race "${marketName}"` };
      }
      if (runnerCount < LAY_FAV_MIN_RUNNERS) {
        return {
          mode: "SKIP",
          bets: [],
          reason: `V2: LAY_FAV skipped — ${runnerCount} runners < ${LAY_FAV_MIN_RUNNERS} (small fields lost -£80 historically)`,
        };
      }
      const layPrice  = favPrice;
      const liability = Math.round(outlay * 100) / 100;
      const stake     = Math.round((liability / (layPrice - 1)) * 100) / 100;
      return {
        mode: "LAY_FAV",
        bets: [{
          selectionId: fav.selectionId,
          runnerName:  fav.runnerName,
          backPrice:   layPrice,
          side:        "LAY",
          stake,
          liability,
          profitIfWins: -liability,
        }],
        reason: `V2 LAY fav — sweet-spot band ${LAY_FAV_MIN}-${LAY_FAV_MAX} (≥${LAY_FAV_MIN_RUNNERS} runners)`,
      };
    }

    // LAY top 2 — unchanged from current
    if (favPrice >= LAY_TOP2_MIN_FAV) {
      const top2 = sorted.slice(0, 2).filter(r => r.bestBackPrice <= MAX_LAY_ODDS);
      if (top2.length < 2) {
        return { mode: "SKIP", bets: [], reason: `V2: top-2 lay aborted — second selection above ${MAX_LAY_ODDS}` };
      }
      const liabPer = Math.round((outlay / 2) * 100) / 100;
      return {
        mode: "LAY_TOP2",
        bets: top2.map(r => {
          const stake = Math.round((liabPer / (r.bestBackPrice - 1)) * 100) / 100;
          return {
            selectionId:  r.selectionId,
            runnerName:   r.runnerName,
            backPrice:    r.bestBackPrice,
            side:         "LAY" as const,
            stake,
            liability:    liabPer,
            profitIfWins: -liabPer,
          };
        }),
        reason: `V2 LAY top 2 — open race, fav ${favPrice}`,
      };
    }

    return { mode: "SKIP", bets: [], reason: `V2: fav ${favPrice.toFixed(2)} outside all bands` };
  }

  // ── Cycle ──────────────────────────────────────────────────────────────
  private async runCycle(): Promise<void> {
    if (!this.running) return;
    try {
      this.resetLatchesForNewDay();

      const { profitLock, lossStop } = await this.getLockStatus();
      if (profitLock.locked) {
        if (!this.profitLatched) {
          this.log("info",
            `🔒 Profit lock TRIGGERED — net £${profitLock.net.toFixed(2)} ≥ £${profitLock.target.toFixed(2)}`);
          this.profitLatched = true;
        }
        return;
      }
      if (lossStop.stopped) {
        if (!this.lossLatched) {
          this.log("warn",
            `🛑 Loss stop TRIGGERED — net £${lossStop.net.toFixed(2)} ≤ -£${lossStop.threshold.toFixed(2)}`);
          this.lossLatched = true;
        }
        return;
      }

      if (!getSession()) {
        const r = await loginWithEnvCredentials();
        if (!r.success) {
          this.log("warn", "Not connected to Betfair — skipping cycle");
          return;
        }
        this.log("info", "Auto-connected to Betfair");
      }

      const now = new Date();
      const fromMs = now.getTime() + MIN_MINS_BEFORE_START * 60_000;
      const toMs   = now.getTime() + MAX_MINS_BEFORE_START * 60_000;

      const markets = await listMarkets({
        eventTypeId:  "7",
        countryCodes: COUNTRY_CODES,
        marketType:   "WIN",
        hoursAhead:   MAX_MINS_BEFORE_START / 60,
      });

      const inWindow = markets.filter(m => {
        const startMs = new Date(m.marketStartTime).getTime();
        return startMs >= fromMs && startMs <= toMs;
      });

      const candidates = inWindow.filter(m => {
        if (this.processing.has(m.marketId)) return false;
        if (NON_WIN_PATTERN.test(m.marketName)) return false;
        // Race type markers (Hrd, NHF, Bumper) can appear in either the event
        // name (e.g. "Lingfield 25th May 14:30 Hrd 2m") or the market name —
        // check both so V2 actually excludes them.
        const raceDesc = `${m.eventName} ${m.marketName}`;
        if (HURDLE_PATTERN.test(raceDesc)) {
          this.log("info", `Skipping ${m.eventName} — Hurdle race (V2 filter)`);
          return false;
        }
        if (NHF_PATTERN.test(raceDesc)) {
          this.log("info", `Skipping ${m.eventName} — NHF/Bumper (V2 filter)`);
          return false;
        }
        return true;
      });

      const alreadyBet = candidates.length > 0
        ? await db
            .select({ marketId: betsTable.marketId })
            .from(betsTable)
            .where(
              sql`${betsTable.strategyName} = ${this.config.strategyName}
                  AND ${betsTable.marketId} = ANY(ARRAY[${sql.join(
                    candidates.map(m => sql`${m.marketId}`),
                    sql`, `,
                  )}])`,
            )
        : [];
      const alreadyIds = new Set(alreadyBet.map(r => r.marketId));
      const fresh = candidates.filter(m => !alreadyIds.has(m.marketId));

      this.log("info",
        `Cycle — ${markets.length} markets, ${inWindow.length} in window, ${fresh.length} fresh after V2 filters`);

      for (const m of fresh) {
        const recheck = await this.getLockStatus();
        if (recheck.profitLock.locked || recheck.lossStop.stopped) {
          this.log("info", "Lock triggered mid-cycle — aborting remaining markets");
          break;
        }
        this.processing.add(m.marketId);
        try {
          await this.runMarket(m.marketId, m.eventName, m.marketName);
        } catch (err) {
          this.log("error", `Error processing ${m.eventName}: ${String(err)}`);
        } finally {
          this.processing.delete(m.marketId);
        }
      }
    } catch (err) {
      this.log("error", `Cycle error: ${String(err)}`);
    }
  }

  private async runMarket(marketId: string, eventName: string, marketName: string): Promise<void> {
    // Data-collection mode: place no bets. The permanent dataset is built by the
    // primary Dutch engine's observe path, so this paper engine just stands down.
    const [cfg] = await db.select({ dataCollectionMode: botConfigTable.dataCollectionMode })
      .from(botConfigTable).limit(1);
    if (cfg?.dataCollectionMode) {
      this.log("info", `Data-collection mode — skipping ${eventName} (no bets placed)`);
      return;
    }

    const detail = await getMarketDetail(marketId);
    if (!detail) return;

    if (detail.totalMatched < MIN_LIQUIDITY) {
      this.log("info", `Skipping ${eventName} — liquidity £${detail.totalMatched.toFixed(0)} < £${MIN_LIQUIDITY}`);
      return;
    }

    const eligible = detail.runners
      .filter(r => r.status === "ACTIVE" && r.bestBackPrice != null && r.bestBackPrice >= 1.01);

    if (eligible.length < MIN_RUNNERS) {
      this.log("info", `Skipping ${eventName} — only ${eligible.length} runners (min ${MIN_RUNNERS})`);
      return;
    }
    if (eligible.length > MAX_RUNNERS) {
      this.log("info", `Skipping ${eventName} — ${eligible.length} runners exceeds max ${MAX_RUNNERS}`);
      return;
    }

    const plan = this.planV2(
      eligible.map(r => ({
        selectionId: r.selectionId,
        runnerName:  r.runnerName,
        bestBackPrice: r.bestBackPrice!,
      })),
      eligible.length,
      marketName,
    );

    if (plan.mode === "SKIP") {
      this.log("info", `Skipping ${eventName} — ${plan.reason}`);
      return;
    }

    const tooSmall = plan.bets.filter(b => b.stake < MIN_BET_SIZE);
    if (tooSmall.length > 0) {
      this.log("info", `Skipping ${eventName} — bet size < £${MIN_BET_SIZE}`);
      return;
    }

    const fullFieldJson = JSON.stringify(
      detail.runners
        .filter(r => r.status === "ACTIVE")
        .map(r => ({
          selectionId: r.selectionId,
          name: r.runnerName,
          odds: r.bestBackPrice ?? r.lastPriceTraded ?? null,
        }))
        .sort((a, b) => (a.odds ?? 999) - (b.odds ?? 999)),
    );

    const summary = plan.bets
      .map(b => `${b.side} ${b.runnerName} £${b.stake.toFixed(2)} @ ${b.backPrice} (liab £${b.liability.toFixed(2)})`)
      .join(" | ");
    this.log("info", `${plan.mode} ${eventName} — ${plan.reason} · ${summary} [PAPER]`,
      { marketId, mode: plan.mode, summary });

    for (const b of plan.bets) {
      const reasoning = `[${plan.mode}] ${b.side} £${b.stake.toFixed(2)} @ ${b.backPrice} · liab £${b.liability.toFixed(2)} · ${plan.reason}||FIELD:${fullFieldJson}`;
      await db.insert(betsTable).values({
        strategyId: null,
        strategyName: this.config.strategyName,
        marketId,
        marketName,
        eventName,
        selectionId: b.selectionId,
        selectionName: b.runnerName,
        betType: b.side,
        requestedOdds: b.backPrice.toFixed(2),
        matchedOdds: b.backPrice.toFixed(2),
        stakeAmount: b.stake.toFixed(2),
        potentialProfit: (b.side === "BACK"
          ? b.stake * (b.backPrice - 1)
          : b.stake
        ).toFixed(2),
        status: "MATCHED",
        aiReasoning: reasoning,
        betId: `DUTCH-V2-${this.config.id.toUpperCase()}-PAPER-${Date.now()}-${b.selectionId}`,
      });
    }
  }

  // ── Settlement ─────────────────────────────────────────────────────────
  private async runSettlement(): Promise<void> {
    if (!getSession()) return;
    try {
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const unsettled = await db
        .select()
        .from(betsTable)
        .where(
          sql`${betsTable.strategyName} = ${this.config.strategyName}
              AND ${betsTable.status} IN ('MATCHED','PLACED','UNMATCHED')
              AND ${betsTable.placedAt} >= ${cutoff}`,
        );
      if (unsettled.length === 0) return;

      const byMarket = new Map<string, typeof unsettled>();
      for (const bet of unsettled) {
        const list = byMarket.get(bet.marketId) ?? [];
        list.push(bet);
        byMarket.set(bet.marketId, list);
      }

      for (const [marketId, bets] of byMarket) {
        let settlement: Awaited<ReturnType<typeof getMarketSettlement>> = null;
        try {
          settlement = await getMarketSettlement(marketId);
        } catch (err) {
          logger.warn({ err, marketId }, `${this.logPrefix} Settlement lookup failed`);
          continue;
        }
        if (!settlement?.settled) continue;

        const winnerSelectionId = settlement.winnerSelectionId;
        const settledAt = new Date();
        let raceNet = 0;
        let winnerName: string | null = null;

        if (winnerSelectionId != null) {
          for (const bet of bets) {
            const raw = bet.aiReasoning ?? "";
            const idx = raw.indexOf("||FIELD:");
            if (idx !== -1) {
              try {
                const field = JSON.parse(raw.slice(idx + 8)) as Array<{ selectionId: number; name: string }>;
                const found = field.find(r => r.selectionId === winnerSelectionId);
                if (found) { winnerName = found.name; break; }
              } catch { /* ignore */ }
            }
          }
          if (!winnerName) {
            winnerName = bets.find(b => b.selectionId === winnerSelectionId)?.selectionName ?? null;
          }
        }

        for (const bet of bets) {
          if (bet.status === "UNMATCHED") {
            await db.update(betsTable)
              .set({ status: "VOID", actualProfit: "0", settledAt })
              .where(eq(betsTable.id, bet.id));
            continue;
          }
          const selectionWon = bet.selectionId === winnerSelectionId;
          const odds = Number(bet.matchedOdds ?? bet.requestedOdds);
          const stake = Number(bet.stakeAmount);
          const isLay = bet.betType === "LAY";
          const actualProfit = isLay
            ? (selectionWon ? -(stake * (odds - 1)) :  stake)
            : (selectionWon ?  (stake * (odds - 1)) : -stake);
          const ourBetWon = isLay ? !selectionWon : selectionWon;
          raceNet += actualProfit;

          const winnerTag = winnerName ? `||WINNER:${winnerName}` : "";
          const baseReasoning = (bet.aiReasoning ?? "").replace(/\|\|WINNER:[^|]*$/, "");

          await db.update(betsTable).set({
            status: ourBetWon ? "WON" : "LOST",
            actualProfit: actualProfit.toFixed(2),
            settledAt,
            aiReasoning: baseReasoning + winnerTag,
          }).where(eq(betsTable.id, bet.id));
        }

        this.log(
          raceNet >= 0 ? "info" : "warn",
          `Settled ${marketId} — race net ${raceNet >= 0 ? "+" : ""}£${raceNet.toFixed(2)}`,
          { marketId, raceNet },
        );
      }
    } catch (err) {
      this.log("error", `Settlement error: ${String(err)}`);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = new Date();
    this.log("info",
      `${this.config.label} started — stake £${this.config.totalOutlay} · profit-lock £${this.config.profitLockGBP} · loss-stop -£${this.config.lossStopGBP} [PAPER]`);
    const loop = async () => {
      if (!this.running) return;
      await this.runCycle();
      if (this.running) this.cycleTimer = setTimeout(() => { void loop(); }, 60_000);
    };
    void loop();
    this.settlementTimer = setInterval(() => { void this.runSettlement(); }, 30_000);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.startedAt = null;
    if (this.cycleTimer) { clearTimeout(this.cycleTimer); this.cycleTimer = null; }
    if (this.settlementTimer) { clearInterval(this.settlementTimer); this.settlementTimer = null; }
    this.log("info", `${this.config.label} stopped`);
  }
}

// ── Module-level singletons ──────────────────────────────────────────────
const variants: Record<V2VariantId, DutchV2Variant> = {
  premium:      new DutchV2Variant(VARIANT_CONFIGS.premium),
  conservative: new DutchV2Variant(VARIANT_CONFIGS.conservative),
};

export function getV2Variant(id: string): DutchV2Variant | null {
  return (id === "premium" || id === "conservative") ? variants[id] : null;
}

export function listV2Variants(): DutchV2Variant[] {
  return [variants.premium, variants.conservative];
}

export function getV2StrategyName(id: V2VariantId): string {
  return variants[id].getConfig().strategyName;
}

export async function autoResumeDutchV2Bots(): Promise<void> {
  // V2 variants are paper-only test bots — no DB-backed persistence of
  // running state. Operators must start them manually after each restart.
  // (Trivial to add later via two boolean columns if desired.)
  logger.info("[DUTCH-V2] Paper variants do not auto-resume — start manually from UI");
}
