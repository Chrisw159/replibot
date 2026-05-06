import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  TrendingUp, TrendingDown, Trophy, Clock,
  ChevronRight, CircleOff, CheckCircle2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface DutchStats {
  racesToday: number;
  betsToday: number;
  profitToday: number;
  totalRaces: number;
  totalNetProfit: number;
}

interface DutchRace {
  marketId: string;
  marketName: string;
  eventName: string;
  strategyName: string | null;
  placedAt: string;
  betCount: number;
  totalStaked: number;
  netProfit: number;
  settled: boolean;
  winnerName: string | null;
}

interface DutchLog {
  id: number;
  level: string;
  message: string;
  createdAt: string;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export default function DutchingBot() {
  const [logs, setLogs] = useState<DutchLog[]>([]);

  const { data: stats } = useQuery<DutchStats>({
    queryKey: ["dutch-status"],
    queryFn: () => apiFetch("/dutch/status"),
    refetchInterval: 5000,
  });

  const { data: races, isLoading: racesLoading } = useQuery<DutchRace[]>({
    queryKey: ["dutch-races"],
    queryFn: () => apiFetch("/dutch/races"),
    refetchInterval: 10000,
  });

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/dutch/logs?limit=50");
      if (res.ok) setLogs(await res.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  const todayP = stats?.profitToday ?? 0;
  const allP   = stats?.totalNetProfit ?? 0;

  const won  = races?.filter(r => r.settled && r.netProfit > 0).length ?? 0;
  const lost = races?.filter(r => r.settled && r.netProfit <= 0).length ?? 0;
  const pending = races?.filter(r => !r.settled).length ?? 0;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            Dutching Bot
            <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 text-xs">BACK strategy</Badge>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Backs multiple runners proportionally so any winner returns the same profit
          </p>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "Today's P&L",
            value: `${todayP >= 0 ? "+" : ""}£${todayP.toFixed(2)}`,
            sub: `${stats?.racesToday ?? 0} races today`,
            colour: todayP > 0 ? "text-emerald-400" : todayP < 0 ? "text-red-400" : "text-foreground",
          },
          {
            label: "All-time P&L",
            value: `${allP >= 0 ? "+" : ""}£${allP.toFixed(2)}`,
            sub: `${stats?.totalRaces ?? 0} races total`,
            colour: allP > 0 ? "text-emerald-400" : allP < 0 ? "text-red-400" : "text-foreground",
          },
          {
            label: "Profitable races",
            value: String(won),
            sub: `${lost} losing · ${pending} pending`,
            colour: "text-foreground",
          },
          {
            label: "Bets placed",
            value: String(stats?.betsToday ?? 0),
            sub: "today",
            colour: "text-foreground",
          },
        ].map(({ label, value, sub, colour }) => (
          <div key={label} className="rounded-xl border border-border/60 bg-card/60 px-5 py-4">
            <div className="text-xs text-muted-foreground mb-1">{label}</div>
            <div className={`text-2xl font-bold tabular-nums ${colour}`}>{value}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
          </div>
        ))}
      </div>

      {/* ── Race history + logs side-by-side ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Race history (2/3 width) */}
        <div className="lg:col-span-2 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Race History</h2>
            {races && (
              <span className="text-xs text-muted-foreground">
                {won} won · {lost} lost · {pending} pending
              </span>
            )}
          </div>

          {racesLoading && (
            <div className="text-sm text-muted-foreground py-12 text-center">Loading races…</div>
          )}

          {!racesLoading && races?.length === 0 && (
            <div className="rounded-xl border border-dashed border-border/60 py-16 text-center text-muted-foreground text-sm">
              <CircleOff className="w-8 h-8 mx-auto mb-3 opacity-20" />
              No Dutch races yet — the bot will place bets when the main bot is running and a Dutch strategy is active
            </div>
          )}

          {races?.map(race => {
            const pnl = race.netProfit;
            const isWin = race.settled && pnl > 0;
            const isLoss = race.settled && pnl <= 0;

            return (
              <Link key={race.marketId} href={`/dutchingbot/race/${race.marketId}`}>
                <div className={`rounded-xl border transition-all cursor-pointer hover:border-border ${
                  isWin  ? "border-emerald-500/30 bg-emerald-500/5" :
                  isLoss ? "border-red-500/20 bg-red-500/3" :
                  "border-border/60 bg-card/50 hover:bg-card"
                }`}>
                  <div className="px-4 py-3 flex items-center gap-3">
                    {/* Icon */}
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                      isWin  ? "bg-emerald-500/20" :
                      isLoss ? "bg-red-500/20" :
                      "bg-muted"
                    }`}>
                      {isWin
                        ? <TrendingUp className="w-4 h-4 text-emerald-400" />
                        : isLoss
                          ? <TrendingDown className="w-4 h-4 text-red-400" />
                          : <Clock className="w-4 h-4 text-muted-foreground" />
                      }
                    </div>

                    {/* Event info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-semibold text-sm text-foreground truncate">{race.eventName}</span>
                        {race.winnerName && (
                          <span className="flex items-center gap-1 text-xs text-emerald-400 flex-shrink-0">
                            <Trophy className="w-3 h-3" />{race.winnerName}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2">
                        <span>{race.marketName}</span>
                        <span>·</span>
                        <span>{fmt(race.placedAt)} {fmtDate(race.placedAt)}</span>
                        <span>·</span>
                        <span>{race.betCount} runners</span>
                        <span>·</span>
                        <span>£{race.totalStaked.toFixed(2)} staked</span>
                      </div>
                    </div>

                    {/* P&L + status */}
                    <div className="text-right flex-shrink-0 flex items-center gap-3">
                      {race.settled ? (
                        <div>
                          <div className={`text-base font-bold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {pnl >= 0 ? "+" : ""}£{Math.abs(pnl).toFixed(2)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {pnl >= 0 ? "profit" : "loss"}
                          </div>
                        </div>
                      ) : (
                        <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30">Pending</Badge>
                      )}
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {/* Log feed (1/3 width) */}
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">Activity Log</h2>
          <div className="rounded-xl border border-border/60 bg-card/50 overflow-hidden">
            {logs.length === 0 ? (
              <div className="py-10 text-center text-xs text-muted-foreground">No Dutch activity yet</div>
            ) : (
              <div className="divide-y divide-border/40 max-h-[520px] overflow-y-auto">
                {logs.map(log => (
                  <div key={log.id} className="px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      {log.level === "error"
                        ? <span className="text-[10px] text-red-400 font-bold uppercase flex-shrink-0 mt-0.5">ERR</span>
                        : log.level === "warn"
                          ? <span className="text-[10px] text-amber-400 font-bold uppercase flex-shrink-0 mt-0.5">WARN</span>
                          : <CheckCircle2 className="w-3 h-3 text-blue-400/60 flex-shrink-0 mt-0.5" />
                      }
                      <span className="text-xs text-foreground/80 leading-snug break-words">{log.message}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 ml-5">
                      {new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* How it works */}
          <div className="rounded-xl border border-border/40 bg-muted/20 px-4 py-3 text-xs text-muted-foreground space-y-2">
            <p className="font-semibold text-foreground/70">How Dutching works</p>
            <p>Stakes are split across multiple runners so that <span className="text-foreground/80">any one of them winning returns the same net profit</span>, regardless of which one wins.</p>
            <p>The bot filters out outsiders above the odds cap, checks book percentage, and only bets when AI approves the race.</p>
            <p>Worst case: all covered runners lose → you lose the total staked. Best case: any runner wins → fixed profit.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
