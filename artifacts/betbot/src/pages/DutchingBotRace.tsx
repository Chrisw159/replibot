import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import {
  ArrowLeft, Trophy, Clock, TrendingUp, TrendingDown,
  CircleDot, Banknote, AlertCircle, CheckCircle2, XCircle, Timer,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface DutchRaceSummary {
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

interface DutchRaceBet {
  id: number;
  selectionName: string;
  requestedOdds: number;
  stakeAmount: number;
  potentialProfit: number | null;
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

function statusIcon(status: string) {
  switch (status) {
    case "WON":     return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    case "LOST":    return <XCircle className="w-4 h-4 text-red-400" />;
    case "VOID":    return <AlertCircle className="w-4 h-4 text-muted-foreground" />;
    case "PLACED":  return <Timer className="w-4 h-4 text-amber-400" />;
    default:        return <CircleDot className="w-4 h-4 text-blue-400" />;
  }
}

function statusColour(status: string) {
  switch (status) {
    case "WON":     return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "LOST":    return "bg-red-500/15 text-red-400 border-red-500/30";
    case "MATCHED": return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    case "PLACED":  return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    default:        return "bg-muted text-muted-foreground";
  }
}

function ProbBar({ pct, status }: { pct: number; status: string }) {
  const colour =
    status === "WON"  ? "bg-emerald-500" :
    status === "LOST" ? "bg-red-500/50" :
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

export default function DutchingBotRace() {
  const [, params] = useRoute("/dutchingbot/race/:marketId");
  const marketId = params?.marketId ?? "";

  const { data: bets, isLoading: betsLoading } = useQuery<DutchRaceBet[]>({
    queryKey: ["dutch-race", marketId],
    queryFn: () => apiFetch(`/dutch/race/${marketId}`),
    enabled: !!marketId,
  });

  const { data: races } = useQuery<DutchRaceSummary[]>({
    queryKey: ["dutch-races"],
    queryFn: () => apiFetch("/dutch/races"),
  });

  const race = races?.find(r => r.marketId === marketId);

  const totalStaked = bets?.reduce((s, b) => s + b.stakeAmount, 0) ?? 0;
  const netProfit   = race?.netProfit ?? 0;
  const settled     = race?.settled ?? false;

  // Sort: biggest stake first (most covered runner at the top)
  const sortedBets = bets ? [...bets].sort((a, b) => b.stakeAmount - a.stakeAmount) : [];

  // Actual race winner = bet with status WON (our BACK bet won = horse won race)
  const actualWinner = sortedBets.find(b => b.status === "WON");

  // Worst case = lose all stakes (none of our horses win)
  // Best case = any winner returns roughly the same profit
  const bestCase = sortedBets.length > 0
    ? Math.max(...sortedBets.map(b => b.potentialProfit ?? 0))
    : 0;

  const raceTime = race ? new Date(race.placedAt) : null;

  return (
    <div className="space-y-0 -mt-2">
      {/* ── Back nav ── */}
      <div className="flex items-center gap-3 pb-5">
        <Link href="/dutchingbot">
          <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Dutching Bot
          </button>
        </Link>
      </div>

      {/* ── Race hero header ── */}
      <div className="rounded-xl overflow-hidden border border-white/10 bg-gradient-to-br from-[#0a1f3f] via-[#0c2952] to-[#0d3566] shadow-2xl">
        <div className="bg-blue-600 px-6 py-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-widest text-white/80">
            Horse Racing · WIN Market · Dutch Strategy
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
            </div>
            <div>
              <div className="text-xs text-white/50 uppercase tracking-wide">Total staked</div>
              <div className="text-2xl font-bold text-white">£{totalStaked.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-xs text-white/50 uppercase tracking-wide">Best case profit</div>
              <div className="text-2xl font-bold text-emerald-300">+£{bestCase.toFixed(2)}</div>
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

      {/* ── Winner banner ── */}
      {settled && actualWinner && (
        <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-5 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
            <Trophy className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-emerald-400/70 uppercase tracking-wide font-semibold mb-0.5">Race Winner</div>
            <div className="text-base font-bold text-emerald-300">{actualWinner.selectionName}</div>
            <div className="text-xs text-emerald-400/60">
              Odds {actualWinner.requestedOdds.toFixed(2)} · Our back bet won
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

      {settled && !actualWinner && sortedBets.length > 0 && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/8 px-5 py-3 flex items-center gap-3 text-sm text-red-300">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          No covered runner won — full stake lost.
        </div>
      )}

      {/* ── Runner table ── */}
      <div className="pt-6 space-y-2">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Runners Backed</h2>
          <span className="text-xs text-muted-foreground">Sorted by stake size</span>
        </div>

        {betsLoading && (
          <div className="text-sm text-muted-foreground py-12 text-center">Loading runners…</div>
        )}

        {sortedBets.map((bet, i) => {
          const prob = impliedPct(bet.requestedOdds);
          const isWinner = bet.status === "WON";
          const isLoser  = bet.status === "LOST";

          return (
            <div
              key={bet.id}
              className={`rounded-xl border transition-all ${
                isWinner ? "border-emerald-500/40 bg-emerald-500/5" :
                isLoser  ? "border-red-500/15 bg-red-500/3" :
                "border-border/60 bg-card/50"
              }`}
            >
              <div className="px-4 py-3 flex items-start gap-4">
                {/* Rank bubble */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5 ${
                  isWinner ? "bg-emerald-500 text-white" :
                  isLoser  ? "bg-red-500/20 text-red-400" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {isWinner ? <Trophy className="w-3.5 h-3.5" /> : i + 1}
                </div>

                {/* Runner name + prob bar */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="font-semibold text-foreground text-sm leading-tight">{bet.selectionName}</span>
                    <div className="flex items-center gap-1">
                      {statusIcon(bet.status)}
                      <Badge className={`text-[10px] px-1.5 py-0 ${statusColour(bet.status)}`}>{bet.status}</Badge>
                    </div>
                  </div>
                  <ProbBar pct={prob} status={bet.status} />
                </div>

                {/* Stats grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-shrink-0 text-right">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Odds</div>
                    <div className="text-base font-bold tabular-nums text-foreground">{bet.requestedOdds.toFixed(2)}</div>
                    <div className="text-[10px] text-muted-foreground">{prob}% prob</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Stake</div>
                    <div className="text-base font-semibold tabular-nums">£{bet.stakeAmount.toFixed(2)}</div>
                    <div className="text-[10px] text-muted-foreground">at risk</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">If wins</div>
                    <div className="text-base font-semibold tabular-nums text-emerald-400">
                      {bet.potentialProfit != null ? `+£${bet.potentialProfit.toFixed(2)}` : "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">net profit</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      {bet.actualProfit !== null ? "Actual" : "Possible"}
                    </div>
                    {bet.actualProfit !== null ? (
                      <>
                        <div className={`text-base font-bold tabular-nums ${bet.actualProfit >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                          {bet.actualProfit >= 0 ? "+" : ""}£{Math.abs(bet.actualProfit).toFixed(2)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">actual</div>
                      </>
                    ) : (
                      <>
                        <div className="text-sm font-semibold text-emerald-400 tabular-nums leading-tight">
                          +£{(bet.potentialProfit ?? 0).toFixed(2)}
                        </div>
                        <div className="text-sm font-semibold text-red-400 tabular-nums leading-tight">
                          -£{bet.stakeAmount.toFixed(2)}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">wins / loses</div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Settlement summary ── */}
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
              {[
                { label: "Total staked",    value: `£${totalStaked.toFixed(2)}`,            sub: "Worst case loss" },
                { label: "Best case profit",value: `+£${bestCase.toFixed(2)}`,               sub: "If any runner wins" },
                { label: "Runners covered", value: String(bets?.length ?? 0),                sub: "Backed selections" },
                {
                  label: "Net P&L",
                  value: settled
                    ? `${netProfit >= 0 ? "+" : ""}£${Math.abs(netProfit).toFixed(2)}`
                    : "Pending",
                  sub: settled
                    ? netProfit >= 0 ? "Profit" : "Loss"
                    : "Awaiting settlement",
                  highlight: settled ? (netProfit >= 0 ? "green" : "red") : "neutral",
                },
              ].map(({ label, value, sub, highlight }) => (
                <div key={label} className="px-5 py-4 text-center">
                  <div className="text-xs text-muted-foreground mb-1">{label}</div>
                  <div className={`text-xl font-bold tabular-nums ${
                    highlight === "green" ? "text-emerald-500" :
                    highlight === "red"   ? "text-red-500" : ""
                  }`}>{value}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>
                </div>
              ))}
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
            <strong className="text-foreground/70">How Dutching works:</strong>{" "}
            Stakes are split across multiple runners so that whichever one wins, the net profit is roughly equal.
            If none of your covered runners win, you lose the total staked. The AI filters out unsuitable races before any bets are placed.
          </span>
        </div>
      </div>
    </div>
  );
}
