/**
 * Pure helper functions extracted from soccerEngine.ts so they can be
 * unit-tested offline (no Betfair connection required).
 */

export const COMMISSION = 0.05; // Betfair commission on net winnings

// ── Score inference ──────────────────────────────────────────────────────────

/** Parse "2 - 0" / "2-0" correct-score runner names. Returns null for named buckets. */
export function parseScoreName(
  name: string,
): { home: number; away: number } | null {
  const m = name.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]) };
}

interface CatalogueRunner {
  selectionId: number;
  runnerName: string;
}

interface BookRunner {
  selectionId: number;
  status: string;
  lastPriceTraded?: number;
  ex?: {
    availableToBack?: Array<{ price: number; size: number }>;
  };
}

export interface InferScoreCatalogue {
  runners?: CatalogueRunner[];
}

export interface InferScoreBook {
  runners?: BookRunner[];
}

/**
 * Infer the current score from a CORRECT_SCORE market book: the runner whose
 * back price is at/below 1.15 late in the game is the current score.
 * Returns { score: null, detail } when ambiguous (named bucket like
 * "Any Other Home Win", no decisive runner, or no runners at all).
 */
export function inferScore(
  catalogue: InferScoreCatalogue,
  book: InferScoreBook,
): { score: { home: number; away: number } | null; detail: string } {
  if (!book.runners) return { score: null, detail: "no book runners" };
  if (!catalogue.runners) return { score: null, detail: "no catalogue runners" };
  const names = new Map(
    catalogue.runners.map((r) => [r.selectionId, r.runnerName]),
  );
  let best: { price: number; name: string } | null = null;
  for (const r of book.runners) {
    if (r.status !== "ACTIVE") continue;
    const price = r.ex?.availableToBack?.[0]?.price ?? r.lastPriceTraded;
    if (!price) continue;
    if (!best || price < best.price) {
      best = { price, name: names.get(r.selectionId) ?? "" };
    }
  }
  if (!best) return { score: null, detail: "no priced active runners" };
  const detail = `best "${best.name}" @ ${best.price}`;
  if (best.price > 1.15) return { score: null, detail: `${detail} — market not sure` };
  return { score: parseScoreName(best.name), detail }; // score null for "Any Other Home Win" etc.
}

// ── Minute estimation ────────────────────────────────────────────────────────

/** Estimated match minute from kick-off (adds 15-min half-time after 45'). */
export function estimateMinute(kickOff: string | undefined): number {
  if (!kickOff) return 0;
  const elapsedMin = (Date.now() - new Date(kickOff).getTime()) / 60_000;
  if (elapsedMin <= 45) return Math.max(0, Math.floor(elapsedMin));
  if (elapsedMin <= 60) return 45; // half-time interval
  return Math.min(90, Math.floor(elapsedMin - 15));
}

// ── Entry-line selection ─────────────────────────────────────────────────────

/**
 * Mirror the operator's manual entry rule:
 * 1. Prefer the one-goal-insured line when its odds are strictly above its
 *    threshold.
 * 2. Otherwise take the tight line only when it is strictly above its own
 *    threshold.
 * 3. Otherwise stand aside.
 */
export function chooseEntryLine<T extends { odds: number }>(
  tight: T | null,
  insured: T | null,
  tightMinOdds: number,
  insuredMinOdds: number,
): T | null {
  if (insured && insured.odds > insuredMinOdds) return insured;
  if (tight && tight.odds > tightMinOdds) return tight;
  return null;
}

/** Resting same-stake lay price that locks at least targetPct net if the Under wins. */
export function layLockPrice(entryOdds: number, targetPct: number): number {
  const ideal = entryOdds - (targetPct / 100) / (1 - COMMISSION);
  return Math.max(1.01, Math.floor((ideal + Number.EPSILON) * 100) / 100);
}

/** Net market profit when equal back and lay stakes both match and the Under wins. */
export function layLockWinProfit(stake: number, entryOdds: number, layOdds: number): number {
  return stake * (entryOdds - layOdds) * (1 - COMMISSION);
}

// ── O/U market line parsing ──────────────────────────────────────────────────

/** Extract the numeric line from a Betfair marketType string, e.g. "OVER_UNDER_25" → 2.5 */
export function ouLineFromMarketType(
  marketType: string | undefined,
): number | null {
  const m = marketType?.match(/^OVER_UNDER_(\d+)5$/);
  if (!m) return null;
  return Number(m[1]) + 0.5;
}

// ── Trade-out math ───────────────────────────────────────────────────────────

/**
 * Gross profit from an equal-profit hedge: back S at B; lay at O.
 * Returns S * (B/O - 1).  Commission is applied by the caller.
 */
export function hedgeProfit(
  stake: number,
  entryOdds: number,
  layOdds: number,
): number {
  return stake * (entryOdds / layOdds - 1);
}
