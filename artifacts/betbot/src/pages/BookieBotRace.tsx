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

  const { data: bets, isLoading } = useQuery<RunnerBet[]>({
    queryKey: ["dutch-race-detail", marketId],
    queryFn: () => apiFetch(`/dutch/race/${marketId}`),
    enabled: !!marketId,
    refetchInterval: 30_000,
  });

  const { data: races } = useQuery<DutchRace[]>({
    queryKey: ["dutch-races"],
    queryFn: () => apiFetch("/dutch/races"),
  });

  const race     = races?.find(r => r.marketId === marketId);
  const settled  = race?.settled ?? false;
  const raceNet  = race?.netProfit ?? 0;
  const winner   = race?.winnerName ?? null;

  const totalStaked = bets?.reduce((s, b) => s + b.stakeAmount, 0) ?? 0;

  const sorted = bets ? [...bets].sort((a, b) => b.stakeAmount - a.stakeAmount) : [];
  const raceTime = race ? new Date(race.placedAt) : null;

  const impliedPct = totalStaked > 0
    ? sorted.map(b => ({ ...b, pct: (b.stakeAmount / totalStaked) * 100 }))
    : sorted.map(b => ({ ...b, pct: 0 }));

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
            <div className="text-2xl font-bold text-white">{race?.eventName ?? "Loading…"}</div>
            <div className="text-sm text-white/50 mt-0.5">{race?.marketName}</div>
          </div>
          <div className="flex flex-wrap gap-6 text-right">
            <div>
              <div className="text-[10px] text-white/40 uppercase tracking-wide">Runners backed</div>
              <div className="text-xl font-bold text-white">{bets?.length ?? "—"}</div>
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
                {settled
                  ? `${raceNet >= 0 ? "+" : ""}£${raceNet.toFixed(2)}`
                  : "Pending"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Winner / result banner */}
      {settled && winner && (
        <div className={`rounded-xl border px-5 py-4 flex items-center gap-3 ${
          raceNet >= 0
            ? "border-emerald-500/40 bg-emerald-500/10"
            : "border-red-500/30 bg-red-500/8"
        }`}>
          <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
            raceNet >= 0 ? "bg-emerald-500" : "bg-red-500"
          }`}>
            <Trophy className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Race Winner</div>
            <div className="text-base font-bold">{winner}</div>
            <div className="text-xs text-muted-foreground">
              {raceNet >= 0 ? "One of our backed runners — we profit" : "Not in our backed runners — we lose outlay"}
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-xs text-muted-foreground mb-0.5">Race P&L</div>
            <div className={`text-2xl font-bold tabular-nums ${raceNet >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {raceNet >= 0 ? "+" : ""}£{raceNet.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {settled && !winner && (
        <div className="rounded-xl border border-muted px-5 py-4 flex items-center gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
            raceNet >= 0 ? "bg-emerald-500" : "bg-red-500"
          }`}>
            <Trophy className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium">Race settled</div>
            <div className="text-xs text-muted-foreground">Winner not recorded</div>
          </div>
          <div className={`text-2xl font-bold tabular-nums ${raceNet >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {raceNet >= 0 ? "+" : ""}£{raceNet.toFixed(2)}
          </div>
        </div>
      )}

      {/* Equal profit note */}
      {!settled && bets && bets.length > 0 && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 flex items-center gap-2 text-sm text-emerald-400/80">
          <Target className="w-4 h-4 flex-shrink-0" />
          Stakes are dutched — if any backed runner wins you collect the same net profit
        </div>
      )}

      {/* Runner table */}
      <div className="space-y-2">
        <div className="text-xs text-muted-foreground uppercase tracking-wide px-1">
          Backed runners — sorted by stake
        </div>

        {isLoading && (
          <div className="text-sm text-muted-foreground text-center py-10">Loading…</div>
        )}

        {impliedPct.map((bet, i) => {
          const isWinner   = bet.selectionName === winner;
          const isSettled  = bet.status === "WON" || bet.status === "LOST";
          const betWon     = bet.status === "WON";

          return (
            <div
              key={bet.id}
              className={`rounded-xl border px-4 py-3 transition-all ${
                isWinner && raceNet >= 0
                  ? "border-emerald-500/40 bg-emerald-500/6"
                  : isWinner && raceNet < 0
                  ? "border-emerald-500/30 bg-emerald-500/4"
                  : "border-border/50 bg-card/40"
              }`}
            >
              <div className="flex items-center gap-4">
                {/* Rank / trophy */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${
                  isWinner
                    ? "bg-emerald-500 text-white"
                    : "bg-muted text-muted-foreground"
                }`}>
                  {isWinner ? <Trophy className="w-3.5 h-3.5" /> : i + 1}
                </div>

                {/* Name + odds + stake */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">{bet.selectionName}</span>
                    {isWinner && (
                      <span className="text-[10px] uppercase font-bold tracking-wide text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded">
                        Won
                      </span>
                    )}
                    {isSettled && !isWinner && (
                      <span className="text-[10px] uppercase font-bold tracking-wide text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded">
                        Lost
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Back @ {bet.backOdds.toFixed(2)} · Stake £{bet.stakeAmount.toFixed(2)}
                    <span className="ml-2 text-muted-foreground/50">({bet.pct.toFixed(1)}% of outlay)</span>
                  </div>

                  {/* Stake bar */}
                  <div className="mt-1.5 h-1 bg-muted/40 rounded-full overflow-hidden w-full max-w-xs">
                    <div
                      className="h-full bg-emerald-500/60 rounded-full"
                      style={{ width: `${bet.pct}%` }}
                    />
                  </div>
                </div>

                {/* P&L column */}
                <div className="text-right flex-shrink-0 min-w-[80px]">
                  {settled && betWon ? (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Net profit</div>
                      <div className="text-lg font-bold tabular-nums text-emerald-400">
                        +£{(bet.actualProfit ?? 0).toFixed(2)}
                      </div>
                    </div>
                  ) : settled && !betWon ? (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Lost stake</div>
                      <div className="text-lg font-bold tabular-nums text-red-400">
                        -£{bet.stakeAmount.toFixed(2)}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">If wins</div>
                      <div className={`text-lg font-bold tabular-nums ${bet.netIfWins >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {bet.netIfWins >= 0 ? "+" : ""}£{Math.abs(bet.netIfWins).toFixed(2)}
                      </div>
                      <div className="text-[10px] text-muted-foreground/50">race net</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary row */}
      {bets && bets.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-card/30 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {raceNet >= 0
              ? <TrendingUp className="w-4 h-4 text-emerald-400" />
              : <TrendingDown className="w-4 h-4 text-red-400" />}
            {settled ? "Settled" : "Pending settlement"}
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Total outlay</div>
            <div className="text-sm font-bold tabular-nums">£{totalStaked.toFixed(2)}</div>
          </div>
          <div className="text-right">
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
      )}
    </div>
  );
}
