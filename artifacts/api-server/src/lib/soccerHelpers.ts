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

/** First-half entries are restricted to 35' through the live first-half window. */
export function isEligibleFirstHalfEntry(
  minute: number,
  goalGap: number,
  entryMinute = 35,
  minGoalGap = 2,
): boolean {
  return minute >= entryMinute && minute <= 45 && goalGap >= minGoalGap;
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

// ── Shared trade calculations ────────────────────────────────────────────────

/**
 * The two goals strategies use the same fixed staking bands. The 2.0 boundary
 * belongs to the lower band (and is deliberately not a truthy/falsy check).
 */
export function entryStakeForOdds(odds: number): number {
  if (!Number.isFinite(odds) || odds < 1.01) {
    throw new RangeError("odds must be finite Betfair odds of at least 1.01");
  }
  return odds <= 2 ? 50 : 100;
}

/** Greatest valid Betfair exchange tick at or below a requested price. */
export function betfairTickFloor(price: number): number {
  if (!Number.isFinite(price)) {
    throw new RangeError("price must be finite");
  }
  const target = Math.max(1.01, Math.min(1000, price));
  let tick = 1.01;
  let best = tick;
  while (tick <= 1000) {
    if (tick <= target + 0.000001) best = tick;
    else break;
    const step =
      tick < 2 ? 0.01 :
      tick < 3 ? 0.02 :
      tick < 4 ? 0.05 :
      tick < 6 ? 0.1 :
      tick < 10 ? 0.2 :
      tick < 20 ? 0.5 :
      tick < 30 ? 1 :
      tick < 50 ? 2 :
      tick < 100 ? 5 : 10;
    tick = Math.round((tick + step) * 100) / 100;
  }
  return best;
}

/**
 * A fixed-price-offset target, rounded down to a valid exchange tick. Flooring
 * is intentional: lower odds are never worse for a lay order and still achieve
 * at least the requested offset.
 */
export function fixedOffsetLayTarget(
  entryOdds: number,
  offset: number,
): number {
  if (!Number.isFinite(entryOdds) || entryOdds < 1.01) {
    throw new RangeError("entryOdds must be finite and at least 1.01");
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new RangeError("offset must be a finite non-negative number");
  }
  return betfairTickFloor(entryOdds - offset);
}

/** Resting same-stake lay price that locks at least targetPct net if the Under wins. */
export function layLockPrice(entryOdds: number, targetPct: number): number {
  const ideal = entryOdds - (targetPct / 100) / (1 - COMMISSION);
  return betfairTickFloor(ideal);
}

/** Net market profit when equal back and lay stakes both match and the Under wins. */
export function layLockWinProfit(stake: number, entryOdds: number, layOdds: number): number {
  return stake * (entryOdds - layOdds) * (1 - COMMISSION);
}

/**
 * Settle the combined back and any fully/partially matched lay stake. Betfair
 * commission is charged only when the combined market result is positive.
 */
export function layLockSettlementProfit(
  backStake: number,
  entryOdds: number,
  underWon: boolean,
  matchedLayStake: number,
  averageLayOdds: number,
): number {
  const gross = underWon
    ? backStake * (entryOdds - 1) - matchedLayStake * (averageLayOdds - 1)
    : -backStake + matchedLayStake;
  return gross > 0 ? gross * (1 - COMMISSION) : gross;
}

/**
 * Strategy-neutral name for the combined back/lay market result. The intended
 * lay size equals the back stake, but matchedLayStake may be smaller while an
 * order is partially filled.
 */
export function equalStakeCombinedProfit(
  backStake: number,
  backOdds: number,
  backedSelectionWon: boolean,
  matchedLayStake: number,
  averageLayOdds: number,
): number {
  return layLockSettlementProfit(
    backStake,
    backOdds,
    backedSelectionWon,
    matchedLayStake,
    averageLayOdds,
  );
}

/** Unmatched part of an equal-stake lay, protected against over-reported fills. */
export function remainingEqualLayStake(
  backStake: number,
  matchedLayStake: number,
): number {
  return Math.max(0, backStake - Math.max(0, matchedLayStake));
}

/**
 * Add a fill without allowing aggregate matching above the intended equal
 * stake. priceStake is retained so immediate and later fallback fills can be
 * settled at their true weighted-average odds.
 */
export function addEqualLayFill(
  backStake: number,
  matchedStake: number,
  priceStake: number,
  fillStake: number,
  fillOdds: number,
): { matchedStake: number; priceStake: number; averageOdds: number } {
  const acceptedStake = Math.min(
    remainingEqualLayStake(backStake, matchedStake),
    Math.max(0, fillStake),
  );
  const nextMatchedStake = Math.max(0, matchedStake) + acceptedStake;
  const nextPriceStake = Math.max(0, priceStake) + acceptedStake * fillOdds;
  return {
    matchedStake: nextMatchedStake,
    priceStake: nextPriceStake,
    averageOdds: nextMatchedStake > 0 ? nextPriceStake / nextMatchedStake : 0,
  };
}

/**
 * Upgrade compatibility for paper trades opened before durable aggregate fill
 * columns existed. New aggregate values win; otherwise an old HEDGED row means
 * the full same-stake lay matched, while an OPEN row retains its immediate fill.
 */
export function compatibleLayAggregate(
  status: string,
  backStake: number,
  layPrice: number,
  matchedStake: number,
  matchedPriceStake: number,
  immediateMatchedStake: number,
  immediatePriceStake: number,
): { matchedStake: number; priceStake: number } {
  if (matchedStake > 0) {
    return { matchedStake, priceStake: matchedPriceStake };
  }
  if (status === "HEDGED") {
    return { matchedStake: backStake, priceStake: backStake * layPrice };
  }
  return {
    matchedStake: Math.max(0, immediateMatchedStake),
    priceStake: Math.max(0, immediatePriceStake),
  };
}

/** The fallback wait is inclusive: it becomes due exactly on the boundary. */
export function fallbackDelayElapsed(
  enteredAtMs: number,
  nowMs: number,
  delayMs: number,
): boolean {
  return delayMs >= 0 && nowMs - enteredAtMs >= delayMs;
}

/** A fallback lay at the configured maximum odds is still permitted. */
export function isFallbackPriceWithinCap(
  layOdds: number,
  maximumLayOdds: number,
): boolean {
  return Number.isFinite(layOdds) &&
    Number.isFinite(maximumLayOdds) &&
    layOdds >= 1.01 &&
    layOdds <= maximumLayOdds;
}

/**
 * Shared fallback gate for both goals strategies. It is useful only after the
 * wait, while some equal-stake lay remains, and at or below the odds cap.
 */
export function isFallbackLayEligible(
  enteredAtMs: number,
  nowMs: number,
  delayMs: number,
  backStake: number,
  matchedLayStake: number,
  layOdds: number,
  maximumLayOdds: number,
): boolean {
  return fallbackDelayElapsed(enteredAtMs, nowMs, delayMs) &&
    remainingEqualLayStake(backStake, matchedLayStake) > 0 &&
    isFallbackPriceWithinCap(layOdds, maximumLayOdds);
}

/**
 * Highest price that can complete the remaining equal-stake lay while keeping
 * the projected loss within a flat currency amount.
 */
export function maximumLayOddsForFlatLoss(
  backStake: number,
  entryOdds: number,
  matchedLayStake: number,
  matchedLayPriceStake: number,
  maximumLoss: number,
): number {
  const remaining = remainingEqualLayStake(backStake, matchedLayStake);
  if (remaining <= 0) return 0;
  return (
    backStake * entryOdds -
    matchedLayPriceStake +
    Math.max(0, maximumLoss)
  ) / remaining;
}

/**
 * A simulated resting lay is fully matched only after post-entry traded volume
 * clears both the queue already at that price and the complete stake.
 */
export function restingLayHasEnoughTradedVolume(
  currentVolume: number,
  baselineVolume: number,
  queueAhead: number,
  stake: number,
): boolean {
  const tradedSinceEntry = currentVolume - baselineVolume;
  return tradedSinceEntry + 0.01 >= queueAhead + stake;
}

export interface PriceVolume {
  price: number;
  size: number;
}

/** Only exact-price trades can be attributed to a queued paper lay. */
export function tradedVolumeAtPrice(
  levels: PriceVolume[],
  targetPrice: number,
): number {
  return levels.reduce(
    (total, level) =>
      Math.abs(level.price - targetPrice) < 0.0001
        ? total + level.size
        : total,
    0,
  );
}

/**
 * A new lay can immediately consume availableToLay liquidity at its requested
 * odds or lower. Lower odds are a better execution for the layer.
 */
export function immediateLayFill(
  availableToLay: PriceVolume[],
  targetPrice: number,
  stake: number,
): { matchedStake: number; priceStake: number } {
  let matchedStake = 0;
  let priceStake = 0;
  const executable = [...availableToLay]
    .filter((level) => level.price <= targetPrice + 0.0001)
    .sort((a, b) => a.price - b.price);

  for (const level of executable) {
    const fill = Math.min(stake - matchedStake, level.size);
    if (fill <= 0) break;
    matchedStake += fill;
    priceStake += fill * level.price;
  }
  return { matchedStake, priceStake };
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

/** Extract a line such as 2.5 from FIRST_HALF_GOALS_25. */
export function firstHalfGoalLineFromMarketType(
  marketType: string | undefined,
): number | null {
  const match = marketType?.match(/^FIRST_HALF_GOALS_(\d+)5$/);
  return match ? Number(match[1]) + 0.5 : null;
}
