import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseScoreName,
  inferScore,
  estimateMinute,
  chooseEntryLine,
  layLockSettlementProfit,
  betfairTickFloor,
  restingLayHasEnoughTradedVolume,
  tradedVolumeAtPrice,
  immediateLayFill,
  ouLineFromMarketType,
  firstHalfGoalLineFromMarketType,
  isEligibleFirstHalfEntry,
  entryStakeForOdds,
  fixedOffsetLayTarget,
  equalStakeCombinedProfit,
  remainingEqualLayStake,
  addEqualLayFill,
  compatibleLayAggregate,
  fallbackDelayElapsed,
  fallbackRetryWindowElapsed,
  fallbackRetryWindowClosed,
  isFallbackPriceWithinCap,
  isFallbackLayEligible,
  maximumLayOddsForFlatLoss,
} from "./soccerHelpers";

// ── parseScoreName ───────────────────────────────────────────────────────────

describe("parseScoreName", () => {
  it("parses standard 'N - N' format", () => {
    expect(parseScoreName("2 - 0")).toEqual({ home: 2, away: 0 });
  });

  it("parses compact 'N-N' format", () => {
    expect(parseScoreName("2-0")).toEqual({ home: 2, away: 0 });
  });

  it("parses 0-0", () => {
    expect(parseScoreName("0 - 0")).toEqual({ home: 0, away: 0 });
  });

  it("parses high-scoring 4-3", () => {
    expect(parseScoreName("4 - 3")).toEqual({ home: 4, away: 3 });
  });

  it("returns null for 'Any Other Home Win'", () => {
    expect(parseScoreName("Any Other Home Win")).toBeNull();
  });

  it("returns null for 'Any Other Away Win'", () => {
    expect(parseScoreName("Any Other Away Win")).toBeNull();
  });

  it("returns null for 'Any Other Draw'", () => {
    expect(parseScoreName("Any Other Draw")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseScoreName("")).toBeNull();
  });

  it("returns null for partial score '2-'", () => {
    expect(parseScoreName("2-")).toBeNull();
  });
});

describe("first-half entry rules", () => {
  it("accepts a two-goal lead at minute 35", () => {
    expect(isEligibleFirstHalfEntry(35, 2)).toBe(true);
  });

  it("rejects entries before minute 35", () => {
    expect(isEligibleFirstHalfEntry(34, 3)).toBe(false);
  });

  it("rejects entries after the first-half window", () => {
    expect(isEligibleFirstHalfEntry(46, 3)).toBe(false);
  });

  it("rejects a one-goal lead", () => {
    expect(isEligibleFirstHalfEntry(40, 1)).toBe(false);
  });

  it("honours configured entry and gap limits", () => {
    expect(isEligibleFirstHalfEntry(38, 3, 38, 3)).toBe(true);
    expect(isEligibleFirstHalfEntry(37, 3, 38, 3)).toBe(false);
  });

  it("parses Betfair first-half goal market lines", () => {
    expect(firstHalfGoalLineFromMarketType("FIRST_HALF_GOALS_25")).toBe(2.5);
    expect(firstHalfGoalLineFromMarketType("FIRST_HALF_GOALS_05")).toBe(0.5);
  });

  it("rejects non-first-half market types", () => {
    expect(firstHalfGoalLineFromMarketType("OVER_UNDER_25")).toBeNull();
    expect(firstHalfGoalLineFromMarketType(undefined)).toBeNull();
  });
});

describe("first-half lay settlement", () => {
  it("uses valid Betfair ticks above 2.0", () => {
    expect(betfairTickFloor(2.57)).toBe(2.56);
    expect(betfairTickFloor(3.08)).toBe(3.05);
  });

  it("settles a fully matched next-goal outcome at breakeven", () => {
    expect(layLockSettlementProfit(50, 1.66, false, 50, 1.23)).toBe(0);
  });

  it("settles a partially matched next-goal outcome at its real exposure", () => {
    expect(layLockSettlementProfit(50, 1.66, false, 10, 1.23)).toBe(-40);
  });

  it("includes partial lay liability when no further goal is scored", () => {
    expect(layLockSettlementProfit(50, 1.66, true, 10, 1.23)).toBeCloseTo(29.165);
  });
});

// ── inferScore ───────────────────────────────────────────────────────────────

/** Helper to build a minimal catalogue + book pair for inferScore tests. */
function makeFixture(
  runners: Array<{
    selectionId: number;
    name: string;
    status?: string;
    backPrice?: number;
    lastPriceTraded?: number;
  }>,
) {
  const catalogue = {
    runners: runners.map((r) => ({
      selectionId: r.selectionId,
      runnerName: r.name,
    })),
  };

  const book = {
    runners: runners.map((r) => ({
      selectionId: r.selectionId,
      status: r.status ?? "ACTIVE",
      ...(r.lastPriceTraded !== undefined
        ? { lastPriceTraded: r.lastPriceTraded }
        : {}),
      ex: {
        availableToBack:
          r.backPrice !== undefined ? [{ price: r.backPrice, size: 500 }] : [],
      },
    })),
  };

  return { catalogue, book };
}

describe("inferScore", () => {
  it("returns score:null with detail when book has no runners", () => {
    const { catalogue } = makeFixture([{ selectionId: 1, name: "2 - 0", backPrice: 1.05 }]);
    const result = inferScore(catalogue, { runners: undefined });
    expect(result.score).toBeNull();
    expect(result.detail).toBe("no book runners");
  });

  it("returns score:null with detail when catalogue has no runners", () => {
    const { book } = makeFixture([{ selectionId: 1, name: "2 - 0", backPrice: 1.05 }]);
    const result = inferScore({ runners: undefined }, book);
    expect(result.score).toBeNull();
    expect(result.detail).toBe("no catalogue runners");
  });

  it("returns score:null with detail when no runners have a price", () => {
    const catalogue = { runners: [{ selectionId: 1, runnerName: "2 - 0" }] };
    const book = { runners: [{ selectionId: 1, status: "ACTIVE", ex: { availableToBack: [] } }] };
    const result = inferScore(catalogue, book);
    expect(result.score).toBeNull();
    expect(result.detail).toBe("no priced active runners");
  });

  it("returns the score when one runner is at/below 1.15", () => {
    const { catalogue, book } = makeFixture([
      { selectionId: 1, name: "2 - 0", backPrice: 1.08 },
      { selectionId: 2, name: "2 - 1", backPrice: 8.0 },
      { selectionId: 3, name: "Any Other Home Win", backPrice: 12.0 },
    ]);
    const result = inferScore(catalogue, book);
    expect(result.score).toEqual({ home: 2, away: 0 });
    expect(result.detail).toContain("2 - 0");
  });

  it("passes the 1.15 boundary — price exactly 1.15 is decisive", () => {
    // guard is `> 1.15`, so price === 1.15 should resolve to a score
    const { catalogue, book } = makeFixture([
      { selectionId: 1, name: "1 - 0", backPrice: 1.15 },
      { selectionId: 2, name: "2 - 0", backPrice: 9.0 },
    ]);
    const result = inferScore(catalogue, book);
    expect(result.score).toEqual({ home: 1, away: 0 });
  });

  it("returns score:null when no runner is below the 1.15 threshold", () => {
    const { catalogue, book } = makeFixture([
      { selectionId: 1, name: "1 - 0", backPrice: 1.20 },
      { selectionId: 2, name: "0 - 0", backPrice: 1.35 },
      { selectionId: 3, name: "Any Other Home Win", backPrice: 4.0 },
    ]);
    const result = inferScore(catalogue, book);
    expect(result.score).toBeNull();
    expect(result.detail).toContain("market not sure");
  });

  it("returns score:null when the decisive runner is 'Any Other Home Win' (ambiguous)", () => {
    const { catalogue, book } = makeFixture([
      { selectionId: 1, name: "Any Other Home Win", backPrice: 1.05 },
      { selectionId: 2, name: "3 - 0", backPrice: 6.0 },
    ]);
    const result = inferScore(catalogue, book);
    expect(result.score).toBeNull();
    // detail should identify the runner name so operators can diagnose
    expect(result.detail).toContain("Any Other Home Win");
  });

  it("returns score:null when the decisive runner is 'Any Other Away Win'", () => {
    const { catalogue, book } = makeFixture([
      { selectionId: 1, name: "Any Other Away Win", backPrice: 1.08 },
      { selectionId: 2, name: "0 - 3", backPrice: 7.0 },
    ]);
    const result = inferScore(catalogue, book);
    expect(result.score).toBeNull();
  });

  it("skips REMOVED runners when finding the best price", () => {
    const { catalogue, book } = makeFixture([
      { selectionId: 1, name: "2 - 0", backPrice: 1.05, status: "REMOVED" },
      { selectionId: 2, name: "1 - 0", backPrice: 1.12, status: "ACTIVE" },
    ]);
    expect(inferScore(catalogue, book).score).toEqual({ home: 1, away: 0 });
  });

  it("falls back to lastPriceTraded when no back offer is available", () => {
    const catalogue = {
      runners: [
        { selectionId: 1, runnerName: "3 - 1" },
        { selectionId: 2, runnerName: "Any Other Home Win" },
      ],
    };
    const book = {
      runners: [
        {
          selectionId: 1,
          status: "ACTIVE",
          lastPriceTraded: 1.1,
          ex: { availableToBack: [] },
        },
        {
          selectionId: 2,
          status: "ACTIVE",
          lastPriceTraded: 5.0,
          ex: { availableToBack: [] },
        },
      ],
    };
    expect(inferScore(catalogue, book).score).toEqual({ home: 3, away: 1 });
  });

  it("picks the runner with the lowest back price when multiple are active", () => {
    const { catalogue, book } = makeFixture([
      { selectionId: 1, name: "1 - 0", backPrice: 1.10 },
      { selectionId: 2, name: "2 - 0", backPrice: 1.05 }, // lower → this wins
      { selectionId: 3, name: "3 - 0", backPrice: 8.0 },
    ]);
    expect(inferScore(catalogue, book).score).toEqual({ home: 2, away: 0 });
  });
});

// ── estimateMinute ───────────────────────────────────────────────────────────

describe("estimateMinute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 0 when kickOff is undefined", () => {
    expect(estimateMinute(undefined)).toBe(0);
  });

  it("returns the raw elapsed minutes in the first half", () => {
    const kickOff = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(estimateMinute(kickOff)).toBe(30);
  });

  it("caps at 45 during the first half", () => {
    const kickOff = new Date(Date.now() - 44 * 60_000).toISOString();
    expect(estimateMinute(kickOff)).toBe(44);
  });

  it("returns 45 during the half-time window (46–60 elapsed minutes)", () => {
    const kickOff = new Date(Date.now() - 52 * 60_000).toISOString();
    expect(estimateMinute(kickOff)).toBe(45);
  });

  it("accounts for the 15-min half-time gap in the second half", () => {
    // 80 elapsed real minutes = 80 - 15 = 65 match minutes
    const kickOff = new Date(Date.now() - 80 * 60_000).toISOString();
    expect(estimateMinute(kickOff)).toBe(65);
  });

  it("returns 85 when 100 elapsed minutes (85' mark)", () => {
    const kickOff = new Date(Date.now() - 100 * 60_000).toISOString();
    expect(estimateMinute(kickOff)).toBe(85);
  });

  it("caps at 90 when well past full time", () => {
    const kickOff = new Date(Date.now() - 120 * 60_000).toISOString();
    expect(estimateMinute(kickOff)).toBe(90);
  });

  it("returns 0 for a future kickoff (not yet started)", () => {
    const kickOff = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(estimateMinute(kickOff)).toBe(0);
  });
});

// ── chooseEntryLine ──────────────────────────────────────────────────────────

describe("chooseEntryLine", () => {
  const tight = { line: 2.5, odds: 1.51 };
  const insured = { line: 3.5, odds: 1.61 };

  it("prefers the one-goal-insured line above its threshold", () => {
    expect(chooseEntryLine(tight, insured, 1.5, 1.6)).toBe(insured);
  });

  it("falls back to the tight line when the insured line is below threshold", () => {
    expect(
      chooseEntryLine(tight, { line: 3.5, odds: 1.6 }, 1.5, 1.6),
    ).toBe(tight);
  });

  it("uses strict thresholds and stands aside at the exact tight-line price", () => {
    expect(
      chooseEntryLine({ line: 2.5, odds: 1.5 }, { line: 3.5, odds: 1.6 }, 1.5, 1.6),
    ).toBeNull();
  });

  it("always gives the qualifying insured line priority", () => {
    expect(chooseEntryLine({ line: 2.5, odds: 2.0 }, insured, 1.5, 1.6)).toBe(insured);
  });
});

describe("same-stake lay lock", () => {
  it("uses £50 through 2.0 and £100 above 2.0", () => {
    expect(entryStakeForOdds(1.01)).toBe(50);
    expect(entryStakeForOdds(2)).toBe(50);
    expect(entryStakeForOdds(2.01)).toBe(100);
  });

  it("rejects invalid odds instead of silently choosing a stake", () => {
    expect(() => entryStakeForOdds(Number.NaN)).toThrow(RangeError);
    expect(() => entryStakeForOdds(1)).toThrow(RangeError);
  });

  it("turns a fixed offset into a valid, no-worse Betfair tick", () => {
    expect(fixedOffsetLayTarget(2.87, 0.3)).toBe(2.56);
    expect(fixedOffsetLayTarget(3.38, 0.3)).toBe(3.05);
  });

  it("caps a fixed-offset target at the exchange minimum", () => {
    expect(fixedOffsetLayTarget(1.2, 0.4)).toBe(1.01);
  });

  it("breaks even if the Under loses because both matched stakes are equal", () => {
    expect(equalStakeCombinedProfit(50, 1.8, false, 50, 1.5)).toBe(0);
    expect(equalStakeCombinedProfit(100, 2.4, false, 100, 2.0)).toBe(0);
  });

  it("settles wins with commission for either strategy's staking band", () => {
    expect(equalStakeCombinedProfit(50, 1.8, true, 50, 1.5)).toBeCloseTo(14.25);
    expect(equalStakeCombinedProfit(100, 2.4, true, 100, 2.0)).toBeCloseTo(38);
  });

  it("accounts for partial fills on both winning and losing settlement", () => {
    expect(equalStakeCombinedProfit(100, 2.4, false, 40, 2.0)).toBe(-60);
    expect(equalStakeCombinedProfit(100, 2.4, true, 40, 2.0)).toBe(95);
  });

  it("combines immediate and fallback partial fills at weighted odds", () => {
    const first = addEqualLayFill(100, 0, 0, 30, 1.5);
    const second = addEqualLayFill(
      100,
      first.matchedStake,
      first.priceStake,
      50,
      1.7,
    );
    expect(second).toEqual({
      matchedStake: 80,
      priceStake: 130,
      averageOdds: 1.625,
    });
    expect(remainingEqualLayStake(100, second.matchedStake)).toBe(20);
  });

  it("never counts fills beyond the equal-stake target", () => {
    expect(addEqualLayFill(50, 40, 60, 25, 2)).toEqual({
      matchedStake: 50,
      priceStake: 80,
      averageOdds: 1.6,
    });
  });
});

describe("fallback boundaries shared by both strategies", () => {
  it("never permits the default fallback before a full five minutes", () => {
    const enteredAt = 1_000_000;
    expect(fallbackDelayElapsed(enteredAt, enteredAt + 299_999, 300_000)).toBe(false);
    expect(fallbackDelayElapsed(enteredAt, enteredAt + 300_000, 300_000)).toBe(true);
  });

  const enteredAt = 10_000;

  it("becomes due exactly at the configured delay, not before", () => {
    expect(fallbackDelayElapsed(enteredAt, 69_999, 60_000)).toBe(false);
    expect(fallbackDelayElapsed(enteredAt, 70_000, 60_000)).toBe(true);
  });

  it("closes the retry window exactly five minutes after entry", () => {
    expect(fallbackRetryWindowElapsed(enteredAt, enteredAt + 299_999, 300_000))
      .toBe(false);
    expect(fallbackRetryWindowElapsed(enteredAt, enteredAt + 300_000, 300_000))
      .toBe(true);
  });

  it("allows timer jitter for the fifth attempt but closes stale retries", () => {
    expect(fallbackRetryWindowClosed(enteredAt, enteredAt + 300_000, 300_000, 10_000))
      .toBe(false);
    expect(fallbackRetryWindowClosed(enteredAt, enteredAt + 310_000, 300_000, 10_000))
      .toBe(false);
    expect(fallbackRetryWindowClosed(enteredAt, enteredAt + 310_001, 300_000, 10_000))
      .toBe(true);
  });

  it("accepts the odds cap itself and rejects one tick above it", () => {
    expect(isFallbackPriceWithinCap(2, 2)).toBe(true);
    expect(isFallbackPriceWithinCap(2.02, 2)).toBe(false);
  });

  it("requires elapsed time, remaining stake, and an in-cap price", () => {
    expect(isFallbackLayEligible(enteredAt, 70_000, 60_000, 50, 20, 2, 2)).toBe(true);
    expect(isFallbackLayEligible(enteredAt, 69_999, 60_000, 50, 20, 2, 2)).toBe(false);
    expect(isFallbackLayEligible(enteredAt, 70_000, 60_000, 50, 50, 2, 2)).toBe(false);
    expect(isFallbackLayEligible(enteredAt, 70_000, 60_000, 50, 20, 2.02, 2)).toBe(false);
  });
});

describe("full-match flat £5 fallback cap", () => {
  it.each([50, 100])(
    "uses the same £5 maximum loss for the £%i stake band",
    (stake) => {
      const entryOdds = 2;
      const maximumLayOdds = maximumLayOddsForFlatLoss(
        stake,
        entryOdds,
        0,
        0,
        5,
      );
      expect(
        equalStakeCombinedProfit(stake, entryOdds, true, stake, maximumLayOdds),
      ).toBeCloseTo(-5);
      expect(isFallbackPriceWithinCap(maximumLayOdds, maximumLayOdds)).toBe(true);
      expect(isFallbackPriceWithinCap(maximumLayOdds + 0.01, maximumLayOdds))
        .toBe(false);
    },
  );

  it("accounts for earlier partial fills when calculating the £5 cap", () => {
    const maximumLayOdds = maximumLayOddsForFlatLoss(100, 2, 25, 40, 5);
    const completedPriceStake = 40 + 75 * maximumLayOdds;
    expect(equalStakeCombinedProfit(100, 2, true, 100, completedPriceStake / 100))
      .toBeCloseTo(-5);
  });
});

describe("legacy in-flight paper trade compatibility", () => {
  it.each(["LAY_LOCK", "FIRST_HALF_LAY_LOCK"])(
    "reconstructs a pre-change HEDGED %s trade as a full equal-stake lay",
    () => {
      expect(compatibleLayAggregate("HEDGED", 50, 1.55, 0, 0, 0, 0))
        .toEqual({ matchedStake: 50, priceStake: 77.5 });
    },
  );

  it.each(["LAY_LOCK", "FIRST_HALF_LAY_LOCK"])(
    "preserves the immediate partial fill for a pre-change OPEN %s trade",
    () => {
      expect(compatibleLayAggregate("OPEN", 100, 1.8, 0, 0, 25, 44.5))
        .toEqual({ matchedStake: 25, priceStake: 44.5 });
    },
  );

  it("prefers durable aggregate values after the upgrade", () => {
    expect(compatibleLayAggregate("HEDGED", 50, 1.5, 40, 61.2, 10, 15))
      .toEqual({ matchedStake: 40, priceStake: 61.2 });
  });
});

describe("restingLayHasEnoughTradedVolume", () => {
  it("requires enough new volume to clear the queue and full stake", () => {
    expect(restingLayHasEnoughTradedVolume(169.98, 100, 20, 50)).toBe(false);
    expect(restingLayHasEnoughTradedVolume(170, 100, 20, 50)).toBe(true);
  });

  it("does not count volume traded before the resting order was created", () => {
    expect(restingLayHasEnoughTradedVolume(149, 100, 0, 50)).toBe(false);
    expect(restingLayHasEnoughTradedVolume(150, 100, 0, 50)).toBe(true);
  });
});

describe("paper resting-lay evidence", () => {
  it("counts traded volume only at the exact lay target", () => {
    expect(
      tradedVolumeAtPrice(
        [
          { price: 1.22, size: 100 },
          { price: 1.23, size: 50 },
          { price: 1.24, size: 75 },
        ],
        1.23,
      ),
    ).toBe(50);
  });

  it("consumes immediate availableToLay demand only at target or better", () => {
    expect(
      immediateLayFill(
        [
          { price: 1.22, size: 20 },
          { price: 1.23, size: 40 },
          { price: 1.24, size: 100 },
        ],
        1.23,
        50,
      ),
    ).toEqual({ matchedStake: 50, priceStake: 61.3 });
  });
});

// ── ouLineFromMarketType ─────────────────────────────────────────────────────

describe("ouLineFromMarketType", () => {
  it("parses OVER_UNDER_25 → 2.5", () => {
    expect(ouLineFromMarketType("OVER_UNDER_25")).toBe(2.5);
  });

  it("parses OVER_UNDER_45 → 4.5", () => {
    expect(ouLineFromMarketType("OVER_UNDER_45")).toBe(4.5);
  });

  it("parses OVER_UNDER_05 → 0.5", () => {
    expect(ouLineFromMarketType("OVER_UNDER_05")).toBe(0.5);
  });

  it("parses OVER_UNDER_15 → 1.5", () => {
    expect(ouLineFromMarketType("OVER_UNDER_15")).toBe(1.5);
  });

  it("returns null for undefined", () => {
    expect(ouLineFromMarketType(undefined)).toBeNull();
  });

  it("returns null for unrecognised strings", () => {
    expect(ouLineFromMarketType("MATCH_ODDS")).toBeNull();
  });

  it("returns null for a whole-number variant without trailing 5", () => {
    // e.g. "OVER_UNDER_2" doesn't match the regex
    expect(ouLineFromMarketType("OVER_UNDER_2")).toBeNull();
  });
});
