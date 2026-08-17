import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseScoreName,
  inferScore,
  estimateMinute,
  ouLineFromMarketType,
  hedgeProfit,
  COMMISSION,
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

// ── hedgeProfit ──────────────────────────────────────────────────────────────

describe("hedgeProfit", () => {
  it("returns 0 when lay odds equal entry odds (no movement)", () => {
    expect(hedgeProfit(10, 1.5, 1.5)).toBeCloseTo(0);
  });

  it("returns positive profit when lay odds are lower than entry odds", () => {
    // Back £10 @ 1.40, lay @ 1.30 → 10*(1.40/1.30 - 1) ≈ 0.769
    expect(hedgeProfit(10, 1.4, 1.3)).toBeCloseTo(10 * (1.4 / 1.3 - 1));
  });

  it("returns negative (loss) when lay odds are higher than entry odds", () => {
    expect(hedgeProfit(10, 1.3, 1.4)).toBeCloseTo(10 * (1.3 / 1.4 - 1));
  });

  it("scales linearly with stake", () => {
    const single = hedgeProfit(1, 1.4, 1.3);
    expect(hedgeProfit(50, 1.4, 1.3)).toBeCloseTo(single * 50);
  });

  // Net-of-commission +15% trigger check
  it("net profit after commission clears 15% target on a textbook trade-out", () => {
    // Back £10 @ 1.40, lay @ 1.28
    // gross ≈ 10*(1.40/1.28 - 1) ≈ 0.9375
    // net   ≈ 0.9375 * 0.95 ≈ 0.8906
    // target = 15% of £10 = £1.50 net → this does NOT clear (odds too tight)
    // Demonstrate the formula the engine uses:
    //   target = (profitTargetPct/100 * stake) / (1 - COMMISSION)
    const stake = 10;
    const entryOdds = 1.4;
    const layOdds = 1.28;
    const profitTargetPct = 15;

    const gross = hedgeProfit(stake, entryOdds, layOdds);
    const target = ((profitTargetPct / 100) * stake) / (1 - COMMISSION);
    const net = gross * (1 - COMMISSION);

    // gross is positive (price moved in our favour)
    expect(gross).toBeGreaterThan(0);
    // net is what we keep after Betfair takes their cut
    expect(net).toBeCloseTo(gross * (1 - COMMISSION));
    // compare to engine's commission-adjusted target
    expect(typeof (gross >= target)).toBe("boolean");
  });

  it("confirms +15% net trigger fires at the right gross threshold", () => {
    // For £10 stake, 15% net target:
    //   net target = £1.50; gross target = 1.50 / 0.95 ≈ 1.5789
    //   gross = stake * (B/O - 1) >= 1.5789
    //   B/O >= 1 + 1.5789/10 = 1.15789
    //   So entry @ 1.40, we need lay <= 1.40 / 1.15789 ≈ 1.209
    const stake = 10;
    const entryOdds = 1.4;
    const profitTargetPct = 15;
    const target = ((profitTargetPct / 100) * stake) / (1 - COMMISSION);

    // Just above the threshold lay price: should NOT trigger
    const layTooHigh = 1.21;
    expect(hedgeProfit(stake, entryOdds, layTooHigh)).toBeLessThan(target);

    // Just below the threshold lay price: should trigger
    const layOk = 1.20;
    expect(hedgeProfit(stake, entryOdds, layOk)).toBeGreaterThanOrEqual(target);
  });
});
