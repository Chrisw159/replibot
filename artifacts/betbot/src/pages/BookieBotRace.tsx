import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { ArrowLeft, Trophy, Clock, Target, TrendingUp, TrendingDown } from "lucide-react";

interface RunnerBet {
  id: number;
  selectionId: number;
  selectionName: string;
  backOdds: number;
  stakeAmount: number;
  netIfWins: number;
  potentialProfit: number | null;
  actualProfit: number | null;
  status: string;
  placedAt: string;
}

interface StoredRunner {
  selectionId: number;
  name: string;
  odds: number | null;
}

interface RaceDetail {
  fullField: StoredRunner[] | null;
  actualWinner: string | null;
  bets: RunnerBet[];
}

interface MarketRunner {
  selectionId: number;
  runnerName: string;
  status: string;
  lastPriceTraded: number | null;
  totalMatched: number | null;
  bestBackPrice: number | null;
  bestLayPrice: number | null;
}

interface MarketDetail {
  marketId: string;
  marketName: string;
  eventName: string;
  marketStartTime: string;
  status: string;
  inPlay: boolean;
  totalMatched: number;
  runners: MarketRunner[];
}

interface DutchRace {
  marketId: string;
  marketName: string;
  eventName: string;
  placedAt: string;
  betCount: number;
  totalStaked: number;
  netProfit: number;
  settled: boolean;
  winnerName: string | null;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

export default function BookieBotRace() {
  const [, params] = useRoute("/bookiebot/race/:marketId");
  const marketId = params?.marketId ?? "";

  const { data: detail, isLoading: betsLoading } = useQuery<RaceDetail>({
    queryKey: ["dutch-race-detail", marketId],
    queryFn: () => apiFetch(`/dutch/race/${marketId}`),
    enabled: !!marketId,
    refetchInterval: 30_000,
  });

  const { data: market } = useQuery<MarketDetail>({
    queryKey: ["market-detail", marketId],
    queryFn: () => apiFetch(`/markets/${marketId}`),
    enabled: !!marketId,
    refetchInterval: 30_000,
    retry: 1,
  });

  const { data: races } = useQuery<DutchRace[]>({
    queryKey: ["dutch-races"],
    queryFn: () => apiFetch("/dutch/races"),
  });

  const bets     = detail?.bets ?? [];
  const race     = races?.find(r => r.marketId === marketId);
  const settled  = race?.settled ?? false;
  const raceNet  = race?.netProfit ?? 0;
  // actualWinner from detail is the ground truth — covers unbacked winners too
  const winner   = detail?.actualWinner ?? race?.winnerName ?? null;
  const winnerWasBacked = winner != null && bets.some(b => b.selectionName === winner);

  const totalStaked = bets.reduce((s, b) => s + b.stakeAmount, 0);
  const raceTime = race ? new Date(race.placedAt) : null;

  // Build a set of backed selectionIds for quick lookup
  const backedMap = new Map<number, RunnerBet>(
    bets.map(b => [b.selectionId, b])
  );

  // Priority: 1) stored field in DB (works for settled races)
  //           2) live market runners (works for in-play/upcoming)
  //           3) bets only (worst case)
  const storedField  = detail?.fullField ?? null;
  const activeRunners = (market?.runners ?? []).filter(r => r.status === "ACTIVE");

  type FieldRow = {
    selectionId: number;
    name: string;
    odds: number;
    backed: boolean;
    bet: RunnerBet | null;
    pct: number;
  };

  let field: FieldRow[];

  if (storedField && storedField.length > 0) {
    // Use stored snapshot — always available, even for settled races
    field = storedField.map(r => {
      const bet = backedMap.get(r.selectionId) ?? null;
      return {
        selectionId: r.selectionId,
        name:   r.name,
        odds:   bet ? bet.backOdds : (r.odds ?? 0),
        backed: !!bet,
        bet,
        pct: bet ? (bet.stakeAmount / (totalStaked || 1)) * 100 : 0,
      };
    }).sort((a, b) => (a.odds || 999) - (b.odds || 999));
  } else if (activeRunners.length > 0) {
    // Fallback: live market (works for upcoming/in-play)
    field = activeRunners.map(r => {
      const odds = r.bestBackPrice ?? r.lastPriceTraded ?? 0;
      const bet  = backedMap.get(r.selectionId) ?? null;
      return {
        selectionId: r.selectionId,
        name:   r.runnerName,
        odds:   bet ? bet.backOdds : odds,
        backed: !!bet,
        bet,
        pct: bet ? (bet.stakeAmount / (totalStaked || 1)) * 100 : 0,
      };
    }).sort((a, b) => (a.odds || 999) - (b.odds || 999));
  } else {
    // Last resort: backed runners only
    field = bets.map(b => ({
      selectionId: b.selectionId,
      name:   b.selectionName,
      odds:   b.backOdds,
      backed: true,
      bet:    b,
      pct:    (b.stakeAmount / (totalStaked || 1)) * 100,
    })).sort((a, b) => a.odds - b.odds);
  }

  const backedCount   = field.filter(r => r.backed).length;
  const unbacedCount  = field.length - backedCount;

  return (
    <div className="space-y-5 -mt-2">
      {/* Back nav */}
      <div>
        <Link href="/bookiebot">
          <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Bookie Bot
          </button>
        </Link>
      </div>

      {/* Race header */}
      <div className="rounded-xl overflow-hidden border border-white/10 bg-gradient-to-br from-[#0a1628] via-[#0d1f3c] to-[#0f2b4e] shadow-xl">
        <div className="bg-emerald-600 px-5 py-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-widest text-white/90">
            Dutch Bot · Back Strategy
          </span>
          {raceTime && (
            <span className="text-xs text-white/70 flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              {raceTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {" · "}
              {raceTime.toLocaleDateString([], { day: "numeric", month: "short" })}
            </span>
          )}
        </div>

        <div className="px-5 py-4 flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-2xl font-bold text-white">{race?.eventName ?? market?.eventName ?? "Loading…"}</div>
            <div className="text-sm text-white/50 mt-0.5">{race?.marketName ?? market?.marketName}</div>
          </div>
          <div className="flex flex-wrap gap-6 text-right">
            <div>
              <div className="text-[10px] text-white/40 uppercase tracking-wide">Field</div>
              <div className="text-xl font-bold text-white">{field.length || "—"}</div>
            </div>
            <div>
              <div className="text-[10px] text-white/40 uppercase tracking-wide">Backed</div>
              <div className="text-xl font-bold text-emerald-300">{backedCount || "—"}</div>
            </div>
            <div>
              <div className="text-[10px] text-white/40 uppercase tracking-wide">Total outlay</div>
              <div className="text-xl font-bold text-white">£{totalStaked.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-[10px] text-white/40 uppercase tracking-wide">Race net</div>
              <div className={`text-xl font-bold ${
                !settled ? "text-white/40" :
                raceNet > 0 ? "text-emerald-300" :
                raceNet < 0 ? "text-red-300" : "text-white"
              }`}>
                {settled ? `${raceNet >= 0 ? "+" : ""}£${raceNet.toFixed(2)}` : "Pending"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Winner / result banner */}
      {settled && winner && (
        <div className={`rounded-xl border px-5 py-4 flex items-center gap-3 ${
          winnerWasBacked
            ? "border-emerald-500/40 bg-emerald-500/10"
            : "border-red-500/30 bg-red-500/8"
        }`}>
          <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
            winnerWasBacked ? "bg-emerald-500" : "bg-red-500"
          }`}>
            <Trophy className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Race Winner</div>
            <div className="text-base font-bold">{winner}</div>
            <div className="text-xs text-muted-foreground">
              {winnerWasBacked ? "One of our backed runners — we profit" : "Not in our backed runners — we lose outlay"}
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-xs text-muted-foreground mb-0.5">Race P&L</div>
            <div className={`text-2xl font-bold tabular-nums ${winnerWasBacked ? "text-emerald-400" : "text-red-400"}`}>
              {raceNet >= 0 ? "+" : ""}£{raceNet.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {settled && !winner && bets && bets.length > 0 && (
        <div className="rounded-xl border border-muted px-5 py-4 flex items-center gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${raceNet >= 0 ? "bg-emerald-500" : "bg-red-500"}`}>
            <Trophy className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium">Race settled</div>
            <div className="text-xs text-muted-foreground">Winner not yet recorded</div>
          </div>
          <div className={`text-2xl font-bold tabular-nums ${raceNet >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {raceNet >= 0 ? "+" : ""}£{raceNet.toFixed(2)}
          </div>
        </div>
      )}

      {/* Pending note */}
      {!settled && bets && bets.length > 0 && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 flex items-center gap-2 text-sm text-emerald-400/80">
          <Target className="w-4 h-4 flex-shrink-0" />
          Stakes dutched — any of the {backedCount} backed runners winning returns equal profit
          {unbacedCount > 0 && (
            <span className="text-muted-foreground/60 ml-1">· {unbacedCount} runners not covered</span>
          )}
        </div>
      )}

      {/* Full field */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between px-1 mb-2">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            Full field · sorted by price (shortest first)
          </div>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />Backed</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted inline-block" />Not covered</span>
          </div>
        </div>

        {betsLoading && (
          <div className="text-sm text-muted-foreground text-center py-10">Loading…</div>
        )}

        {field.map((row, i) => {
          const isWinner   = row.name === winner;
          const betWon     = row.bet?.status === "WON";
          const betLost    = row.bet?.status === "LOST";
          const betSettled = betWon || betLost;

          return (
            <div
              key={row.selectionId}
              className={`rounded-xl border px-4 py-3 transition-all ${
                isWinner && raceNet >= 0 && row.backed
                  ? "border-emerald-500/50 bg-emerald-500/8"
                  : isWinner && !row.backed
                  ? "border-red-500/40 bg-red-500/6"
                  : row.backed
                  ? "border-border/60 bg-card/50"
                  : "border-border/25 bg-card/20 opacity-50"
              }`}
            >
              <div className="flex items-center gap-3">
                {/* Icon */}
                <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${
                  isWinner
                    ? raceNet >= 0 && row.backed ? "bg-emerald-500 text-white" : "bg-red-500 text-white"
                    : row.backed
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-muted/60 text-muted-foreground/50"
                }`}>
                  {isWinner ? <Trophy className="w-3.5 h-3.5" /> : i + 1}
                </div>

                {/* Name + odds */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`font-semibold text-sm ${row.backed ? "" : "text-muted-foreground/60"}`}>
                      {row.name}
                    </span>
                    {row.backed && !isWinner && (
                      <span className="text-[9px] uppercase font-bold tracking-wide text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded">
                        Backed
                      </span>
                    )}
                    {isWinner && row.backed && (
                      <span className="text-[9px] uppercase font-bold tracking-wide text-white bg-emerald-500 px-1.5 py-0.5 rounded">
                        Winner ✓
                      </span>
                    )}
                    {isWinner && !row.backed && (
                      <span className="text-[9px] uppercase font-bold tracking-wide text-white bg-red-500 px-1.5 py-0.5 rounded">
                        Winner — not covered
                      </span>
                    )}
                    {betSettled && !isWinner && row.backed && (
                      <span className="text-[9px] uppercase font-bold tracking-wide text-muted-foreground/60 bg-muted/30 px-1.5 py-0.5 rounded">
                        Lost
                      </span>
                    )}
                  </div>

                  {/* Stake bar (backed only) */}
                  {row.backed && row.bet && (
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden flex-1 max-w-[120px]">
                        <div className="h-full bg-emerald-500/70 rounded-full" style={{ width: `${row.pct}%` }} />
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        £{row.bet.stakeAmount.toFixed(2)} stake · {row.pct.toFixed(0)}%
                      </span>
                    </div>
                  )}
                </div>

                {/* Odds */}
                <div className="text-center flex-shrink-0 w-16">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Odds</div>
                  <div className={`text-base font-bold tabular-nums ${row.backed ? "" : "text-muted-foreground/50"}`}>
                    {row.odds ? row.odds.toFixed(2) : "—"}
                  </div>
                </div>

                {/* P&L / if-wins */}
                <div className="text-right flex-shrink-0 min-w-[80px]">
                  {!row.backed ? (
                    <div>
                      <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide">Not backed</div>
                      {isWinner && (
                        <div className="text-xs font-bold text-red-400 mt-0.5">-£{totalStaked.toFixed(2)}</div>
                      )}
                    </div>
                  ) : settled && betWon ? (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Net profit</div>
                      <div className="text-base font-bold tabular-nums text-emerald-400">
                        +£{(row.bet!.actualProfit ?? 0).toFixed(2)}
                      </div>
                    </div>
                  ) : settled && betLost ? (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Lost</div>
                      <div className="text-base font-bold tabular-nums text-red-400/70">
                        -£{row.bet!.stakeAmount.toFixed(2)}
                      </div>
                    </div>
                  ) : row.bet ? (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">If wins</div>
                      <div className={`text-base font-bold tabular-nums ${row.bet.netIfWins >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {row.bet.netIfWins >= 0 ? "+" : ""}£{Math.abs(row.bet.netIfWins).toFixed(2)}
                      </div>
                      <div className="text-[10px] text-muted-foreground/50">race net</div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary footer */}
      {bets && bets.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-card/30 px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {raceNet >= 0
              ? <TrendingUp className="w-4 h-4 text-emerald-400" />
              : <TrendingDown className="w-4 h-4 text-red-400" />}
            {settled ? "Settled" : "Pending settlement"}
          </div>
          <div className="flex gap-6 text-right">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Total outlay</div>
              <div className="text-sm font-bold tabular-nums">£{totalStaked.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Race net</div>
              <div className={`text-sm font-bold tabular-nums ${
                !settled ? "text-muted-foreground" :
                raceNet > 0 ? "text-emerald-400" :
                raceNet < 0 ? "text-red-400" : ""
              }`}>
                {settled ? `${raceNet >= 0 ? "+" : ""}£${raceNet.toFixed(2)}` : "—"}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
