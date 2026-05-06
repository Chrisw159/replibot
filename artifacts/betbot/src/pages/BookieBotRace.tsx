import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import {
  ArrowLeft, Trophy, Clock, TrendingUp, TrendingDown,
  CircleDot, Banknote, AlertCircle, CheckCircle2, XCircle, Timer,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface BookieRace {
  marketId: string;
  marketName: string;
  eventName: string;
  placedAt: string;
  betCount: number;
  totalStaked: number;
  totalCollected: number;
  totalPaidOut: number;
  netProfit: number;
  settled: boolean;
}

interface BookieRaceBet {
  id: number;
  selectionName: string;
  betType: string;
  requestedOdds: number;
  stakeAmount: number;
  liability: number;
  actualProfit: number | null;
  status: string;
  aiReasoning: string | null;
  placedAt: string;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

function impliedPct(odds: number) {
  return Math.round((1 / odds) * 100);
}

function bookieLabel(status: string) {
  switch (status) {
    case "WON":     return "BACKED & WON";
    case "LOST":    return "BACKED & LOST";
    case "MATCHED": return "MATCHED";
    case "PLACED":  return "PLACED";
    case "VOID":    return "VOID";
    default:        return status;
  }
}

function statusIcon(status: string) {
  switch (status) {
    case "WON":    return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    case "LOST":   return <XCircle className="w-4 h-4 text-red-400" />;
    case "VOID":   return <AlertCircle className="w-4 h-4 text-muted-foreground" />;
    case "PLACED": return <Timer className="w-4 h-4 text-amber-400" />;
    default:       return <CircleDot className="w-4 h-4 text-blue-400" />;
  }
}

function statusColour(status: string) {
  switch (status) {
    case "WON":     return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "LOST":    return "bg-red-500/15 text-red-400 border-red-500/30";
    case "MATCHED": return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    case "PLACED":  return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "VOID":    return "bg-muted text-muted-foreground";
    default:        return "bg-muted text-muted-foreground";
  }
}

function ProbBar({ pct, status }: { pct: number; status: string }) {
  const colour =
    status === "WON"  ? "bg-emerald-500" :
    status === "LOST" ? "bg-red-500" :
    "bg-[#0072bb]";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-white/10">
        <div className={`h-1.5 rounded-full ${colour} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">{pct}%</span>
    </div>
  );
}

export default function BookieBotRace() {
  const [, params] = useRoute("/bookiebot/race/:marketId");
  const marketId = params?.marketId ?? "";

  const { data: bets, isLoading: betsLoading } = useQuery<BookieRaceBet[]>({
    queryKey: ["bookie-race", marketId],
    queryFn: () => apiFetch(`/bookie/race/${marketId}`),
    enabled: !!marketId,
  });

  const { data: races } = useQuery<BookieRace[]>({
    queryKey: ["bookie-races"],
    queryFn: () => apiFetch("/bookie/races"),
  });

  const race = races?.find(r => r.marketId === marketId);

  const totalStaked  = bets?.reduce((s, b) => s + b.stakeAmount, 0) ?? 0;
  const netProfit    = race?.netProfit ?? 0;
  const settled      = race?.settled ?? false;

  // Level-stakes back-the-field:
  // Net race P&L if runner i wins = stake × odds_i − total staked
  // (positive for outsiders beyond the breakeven point, negative for shorter runners)
  const netIfWins = (b: { stakeAmount: number; requestedOdds: number }) =>
    Math.round((b.stakeAmount * b.requestedOdds - totalStaked) * 100) / 100;

  const breakevenOdds = bets?.length ?? 0; // decimal odds that = break even

  // Best case = biggest outsider wins; worst case = shortest runner wins
  const worstBet = bets && bets.length > 0
    ? bets.reduce((a, b) => netIfWins(a) < netIfWins(b) ? a : b)
    : null;
  const bestBet = bets && bets.length > 0
    ? bets.reduce((a, b) => netIfWins(a) > netIfWins(b) ? a : b)
    : null;
  const worstCaseNet = worstBet ? netIfWins(worstBet) : 0;

  const raceTime = race ? new Date(race.placedAt) : null;

  // Sort: favourite (lowest odds) first
  const sortedBets = bets ? [...bets].sort((a, b) => a.requestedOdds - b.requestedOdds) : [];
  // BACK bet: status=WON means our backed horse actually WON the race
  const actualWinner = sortedBets.find(b => b.status === "WON");

  return (
    <div className="space-y-0 -mt-2">
      {/* ── Back nav ── */}
      <div className="flex items-center gap-3 pb-5">
        <Link href="/bookiebot">
          <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Bookie Bot
          </button>
        </Link>
      </div>

      {/* ── Race hero header ── */}
      <div className="rounded-xl overflow-hidden border border-white/10 bg-gradient-to-br from-[#001f3f] via-[#00294d] to-[#003a6e] shadow-2xl">
        {/* Top strip */}
        <div className="bg-[#0072bb] px-6 py-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-widest text-white/80">
            Horse Racing · WIN Market · Back Strategy
          </span>
          {race && (
            <span className="text-xs text-white/70 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Bets placed {raceTime?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {" · "}
              {raceTime?.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}
            </span>
          )}
        </div>

        <div className="px-6 py-5 flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-2xl md:text-3xl font-bold text-white tracking-tight">
              {race?.eventName ?? "Loading…"}
            </div>
            <div className="text-sm text-white/60 mt-1">{race?.marketName}</div>
          </div>

          <div className="flex flex-wrap gap-4 text-right">
            <div>
              <div className="text-xs text-white/50 uppercase tracking-wide">Runners backed</div>
              <div className="text-2xl font-bold text-white">{bets?.length ?? "—"}</div>
              {breakevenOdds > 0 && (
                <div className="text-[10px] text-white/40 mt-0.5">breakeven @ {breakevenOdds}+ odds</div>
              )}
            </div>
            <div>
              <div className="text-xs text-white/50 uppercase tracking-wide">Total staked</div>
              <div className="text-2xl font-bold text-white">£{totalStaked.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-xs text-white/50 uppercase tracking-wide">Best case</div>
              <div className="text-2xl font-bold text-emerald-300">
                {bestBet ? (netIfWins(bestBet) >= 0 ? "+" : "-") : ""}£{bestBet ? Math.abs(netIfWins(bestBet)).toFixed(2) : "0.00"}
              </div>
              {bestBet && (
                <div className="text-[10px] text-white/40 mt-0.5">if {bestBet.selectionName} wins</div>
              )}
            </div>
            <div>
              <div className="text-xs text-white/50 uppercase tracking-wide">Worst case</div>
              <div className="text-2xl font-bold text-amber-300">
                {worstCaseNet >= 0 ? "+" : "-"}£{Math.abs(worstCaseNet).toFixed(2)}
              </div>
              {worstBet && (
                <div className="text-[10px] text-white/40 mt-0.5">if {worstBet.selectionName} wins</div>
              )}
            </div>
            <div>
              <div className="text-xs text-white/50 uppercase tracking-wide">Net P&L</div>
              <div className={`text-2xl font-bold ${
                !settled ? "text-white/50" :
                netProfit > 0 ? "text-emerald-400" :
                netProfit < 0 ? "text-red-400" : "text-white"
              }`}>
                {!settled ? "Pending" : `${netProfit >= 0 ? "+" : ""}£${netProfit.toFixed(2)}`}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Race Winner banner (only shown when settled) ── */}
      {settled && actualWinner && (
        <div className={`mt-4 rounded-xl border px-5 py-4 flex items-center gap-3 ${
          netProfit >= 0
            ? "border-emerald-500/40 bg-emerald-500/10"
            : "border-amber-500/30 bg-amber-500/8"
        }`}>
          <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
            netProfit >= 0 ? "bg-emerald-500" : "bg-amber-500"
          }`}>
            <Trophy className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-xs uppercase tracking-wide font-semibold mb-0.5 ${netProfit >= 0 ? "text-emerald-400/70" : "text-amber-400/70"}`}>
              Race Winner — Our back landed
            </div>
            <div className={`text-base font-bold ${netProfit >= 0 ? "text-emerald-300" : "text-amber-300"}`}>
              {actualWinner.selectionName}
            </div>
            <div className={`text-xs ${netProfit >= 0 ? "text-emerald-400/60" : "text-amber-400/60"}`}>
              Odds {actualWinner.requestedOdds.toFixed(2)} · Profit on this bet: +£{(actualWinner.actualProfit ?? 0).toFixed(2)} · Other stakes lost
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-xs text-muted-foreground mb-0.5">Net result</div>
            <div className={`text-xl font-bold tabular-nums ${netProfit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {netProfit >= 0 ? "+" : ""}£{netProfit.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {settled && !actualWinner && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/8 px-5 py-3 flex items-center gap-3 text-sm text-red-300">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          Winner was not in our covered runners — all stakes lost (£{totalStaked.toFixed(2)}).
        </div>
      )}

      {/* ── Runner table ── */}
      <div className="pt-6 space-y-2">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Runners</h2>
          <span className="text-xs text-muted-foreground">Sorted favourite → outsider</span>
        </div>

        {betsLoading && (
          <div className="text-sm text-muted-foreground py-12 text-center">Loading runners…</div>
        )}

        {sortedBets.map((bet, i) => {
          const prob = impliedPct(bet.requestedOdds);
          // BACK bet: WON = our backed horse won the race
          const isRaceWinner = bet.status === "WON";
          const isBackLost   = bet.status === "LOST";

          return (
            <div
              key={bet.id}
              className={`rounded-xl border transition-all ${
                isRaceWinner ? "border-emerald-500/40 bg-emerald-500/5" :
                isBackLost   ? "border-red-500/10 bg-card/30" :
                "border-border/60 bg-card/50"
              }`}
            >
              <div className="px-4 py-3 flex items-start gap-4">
                {/* Rank bubble */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5 ${
                  isRaceWinner ? "bg-emerald-500 text-white" :
                  isBackLost   ? "bg-red-500/15 text-red-400" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {isRaceWinner ? <Trophy className="w-3.5 h-3.5" /> : i + 1}
                </div>

                {/* Runner name + prob bar */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="font-semibold text-foreground text-sm leading-tight">{bet.selectionName}</span>
                    <div className="flex items-center gap-1">{statusIcon(bet.status)}
                      <Badge className={`text-[10px] px-1.5 py-0 ${statusColour(bet.status)}`}>{bookieLabel(bet.status)}</Badge>
                    </div>
                  </div>
                  <ProbBar pct={prob} status={bet.status} />
                </div>

                {/* Stats grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-shrink-0 text-right">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Back odds</div>
                    <div className="text-base font-bold tabular-nums text-foreground">{bet.requestedOdds.toFixed(2)}</div>
                    <div className="text-[10px] text-muted-foreground">{prob}% prob</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Stake</div>
                    <div className="text-base font-semibold tabular-nums">£{bet.stakeAmount.toFixed(2)}</div>
                    <div className="text-[10px] text-muted-foreground">at risk</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Potential win</div>
                    <div className={`text-base font-semibold tabular-nums ${isRaceWinner ? "text-emerald-400" : ""}`}>
                      £{(bet.stakeAmount * (bet.requestedOdds - 1)).toFixed(2)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">profit if wins</div>
                  </div>
                  {(() => {
                    const net = netIfWins(bet);
                    return (
                      <div>
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wide">If wins</div>
                        <div className={`text-base font-bold tabular-nums ${net > 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {net >= 0 ? "+" : "-"}£{Math.abs(net).toFixed(2)}
                        </div>
                        {bet.actualProfit !== null ? (
                          <div className={`text-[10px] mt-0.5 font-medium ${bet.actualProfit >= 0 ? "text-emerald-500/70" : "text-red-500/70"}`}>
                            actual: {bet.actualProfit >= 0 ? "+" : "-"}£{Math.abs(bet.actualProfit).toFixed(2)}
                          </div>
                        ) : (
                          <div className="text-[10px] text-muted-foreground mt-0.5">race outcome</div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── P&L summary ── */}
      {race && (
        <div className="pt-4">
          <div className="rounded-xl border border-border/60 bg-card/50 overflow-hidden">
            <div className="px-5 py-3 border-b border-border/50 bg-muted/20">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                <Banknote className="w-3.5 h-3.5" />
                Race Settlement Summary
              </h3>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border/50">
              {(() => {
                const bestNet  = bestBet  ? netIfWins(bestBet)  : 0;
                const worstNet = worstBet ? netIfWins(worstBet) : 0;
                const cells = [
                  {
                    label: "Best case",
                    value: bestNet >= 0 ? `+£${bestNet.toFixed(2)}` : `-£${Math.abs(bestNet).toFixed(2)}`,
                    sub: bestBet ? `if ${bestBet.selectionName} wins` : "—",
                    highlight: bestNet > 0 ? "green" : bestNet < 0 ? "amber" : "neutral",
                  },
                  {
                    label: "Worst case",
                    value: worstNet >= 0 ? `+£${worstNet.toFixed(2)}` : `-£${Math.abs(worstNet).toFixed(2)}`,
                    sub: worstBet ? `if ${worstBet.selectionName} wins` : "—",
                    highlight: worstNet >= 0 ? "green" : "red",
                  },
                  {
                    label: "Total staked",
                    value: `£${totalStaked.toFixed(2)}`,
                    sub: settled ? "Stakes placed" : "At risk",
                    highlight: "neutral",
                  },
                  {
                    label: "Net P&L",
                    value: settled
                      ? netProfit >= 0 ? `+£${netProfit.toFixed(2)}` : `-£${Math.abs(netProfit).toFixed(2)}`
                      : "Pending",
                    sub: settled
                      ? netProfit >= 0 ? "Profit" : "Loss"
                      : "Awaiting settlement",
                    highlight: settled ? (netProfit >= 0 ? "green" : "red") : "neutral",
                  },
                ];
                return cells.map(({ label, value, sub, highlight }) => (
                  <div key={label} className="px-5 py-4 text-center">
                    <div className="text-xs text-muted-foreground mb-1">{label}</div>
                    <div className={`text-xl font-bold tabular-nums ${
                      highlight === "green" ? "text-emerald-500" :
                      highlight === "red"   ? "text-red-500"    :
                      highlight === "amber" ? "text-amber-400"  :
                      ""
                    }`}>{value}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── How to read ── */}
      <div className="pt-2 pb-4">
        <div className="rounded-lg bg-muted/30 border border-border/40 px-4 py-3 text-xs text-muted-foreground flex items-start gap-2">
          {netProfit >= 0
            ? <TrendingUp className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
            : <TrendingDown className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />}
          <span>
            <strong className="text-foreground/70">How level-stakes back-the-field works:</strong>{" "}
            We back every runner with the same flat stake. The breakeven point in decimal odds equals the number of runners backed.
            A big outsider winning = big profit (odds far above breakeven). The favourite winning = controlled loss.
            Like an underground bookmaker — you profit most when the unexpected happens.
          </span>
        </div>
      </div>
    </div>
  );
}
