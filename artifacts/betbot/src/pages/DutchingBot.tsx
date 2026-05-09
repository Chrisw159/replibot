import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  TrendingUp, TrendingDown, Trophy, Clock,
  ChevronRight, ChevronDown, CircleOff, CheckCircle2,
  CalendarClock, ArrowDownCircle, ArrowUpCircle, MinusCircle,
  Play, Square, Loader2, AlertCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface DutchStats {
  racesToday: number;
  betsToday: number;
  profitToday: number;
  totalRaces: number;
  totalNetProfit: number;
  isRunning?: boolean;
  startedAt?: string | null;
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

interface ScheduleRunner {
  name: string;
  price: number;
  backed: boolean;
  betType?: "BACK" | "LAY";
  stake?: number;
  liability?: number;
  netProfit?: number;
}

interface DutchScheduleEntry {
  id: number;
  marketId: string;
  eventName: string;
  marketName: string;
  marketStartTime: string;
  runnerCount: number | null;
  status: string;          // SCHEDULED | BET_PLACED | SKIPPED | MISSED
  skipReason: string | null;
  runnersJson: ScheduleRunner[] | null;
}

interface DutchLog {
  id: number;
  level: string;
  message: string;
  createdAt: string;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

function statusBadge(status: string) {
  switch (status) {
    case "BET_PLACED":
      return <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 text-[10px]">Bet placed</Badge>;
    case "SKIPPED":
      return <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-[10px]">Skipped</Badge>;
    case "MISSED":
      return <Badge className="bg-red-500/10 text-red-400/70 border-red-500/20 text-[10px]">Missed</Badge>;
    default:
      return <Badge className="bg-muted text-muted-foreground text-[10px]">Scheduled</Badge>;
  }
}

export default function DutchingBot() {
  const qc = useQueryClient();
  const [logs, setLogs] = useState<DutchLog[]>([]);
  const [openSchedule, setOpenSchedule] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: stats } = useQuery<DutchStats>({
    queryKey: ["dutch-status"],
    queryFn: () => apiFetch("/dutch/status"),
    refetchInterval: 5000,
  });

  const startMutation = useMutation({
    mutationFn: () => apiFetch<DutchStats>("/dutch/start", { method: "POST" }),
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["dutch-status"] });
    },
    onError: (e: Error) => setActionError(e.message || "Failed to start bot"),
  });
  const stopMutation = useMutation({
    mutationFn: () => apiFetch<DutchStats>("/dutch/stop", { method: "POST" }),
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["dutch-status"] });
    },
    onError: (e: Error) => setActionError(e.message || "Failed to stop bot"),
  });
  const isRunning   = stats?.isRunning ?? false;
  const actionBusy  = startMutation.isPending || stopMutation.isPending;

  const { data: schedule, isLoading: scheduleLoading } = useQuery<DutchScheduleEntry[]>({
    queryKey: ["dutch-schedule"],
    queryFn: () => apiFetch("/dutch/schedule"),
    refetchInterval: 30_000,
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

  const toggleSchedule = (marketId: string) => {
    setOpenSchedule(prev => {
      const next = new Set(prev);
      if (next.has(marketId)) next.delete(marketId); else next.add(marketId);
      return next;
    });
  };

  const todayP = stats?.profitToday ?? 0;
  const allP   = stats?.totalNetProfit ?? 0;

  const won  = races?.filter(r => r.settled && r.netProfit > 0).length ?? 0;
  const lost = races?.filter(r => r.settled && r.netProfit <= 0).length ?? 0;
  const pending = races?.filter(r => !r.settled).length ?? 0;

  // Map marketId → settlement info from races (for inline P&L on schedule rows)
  const raceByMarket = new Map<string, DutchRace>();
  races?.forEach(r => raceByMarket.set(r.marketId, r));

  // Schedule counts
  const sched      = schedule?.length ?? 0;
  const placed     = schedule?.filter(s => s.status === "BET_PLACED").length ?? 0;
  const skipped    = schedule?.filter(s => s.status === "SKIPPED").length ?? 0;
  const upcoming   = schedule?.filter(s => s.status === "SCHEDULED").length ?? 0;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            Dutching Bot
            <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 text-xs">Combo strategy</Badge>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            BACK heavy favs (&lt;2.5) · LAY mid-favs (3.0–5.0) · LAY top 2 in open races (fav≥5.0)
          </p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${isRunning ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/40"}`} />
              {isRunning
                ? <span className="text-emerald-400">Running{stats?.startedAt ? ` since ${fmtTime(stats.startedAt)}` : ""}</span>
                : <span className="text-muted-foreground">Stopped</span>}
            </div>
            {isRunning ? (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => stopMutation.mutate()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              >
                {actionBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4 fill-current" />}
                Stop bot
              </button>
            ) : (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => startMutation.mutate()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              >
                {actionBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                Start bot
              </button>
            )}
          </div>
          {actionError && (
            <div className="inline-flex items-center gap-1.5 text-xs text-red-400 max-w-xs text-right">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate" title={actionError}>{actionError}</span>
            </div>
          )}
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
            label: "Schedule today",
            value: String(sched),
            sub: `${placed} bet · ${skipped} skipped · ${upcoming} upcoming`,
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

      {/* ── TOP: Today's schedule (expandable rows) ── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <CalendarClock className="w-4 h-4" />
            Today's Race Schedule
          </h2>
          {schedule && (
            <span className="text-xs text-muted-foreground">
              {sched} races · {placed} bet · {skipped} skipped · {upcoming} upcoming
            </span>
          )}
        </div>

        {scheduleLoading && (
          <div className="text-sm text-muted-foreground py-8 text-center">Loading schedule…</div>
        )}

        {!scheduleLoading && schedule?.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/60 py-10 text-center text-muted-foreground text-sm">
            <CalendarClock className="w-7 h-7 mx-auto mb-2 opacity-20" />
            No races scheduled yet — start the bot to populate today's schedule
          </div>
        )}

        <div className="space-y-1.5 max-h-[500px] overflow-y-auto pr-1">
          {schedule?.map(s => {
            const isOpen = openSchedule.has(s.marketId);
            const runners = s.runnersJson ?? [];
            const hasBets = s.status === "BET_PLACED" && runners.some(r => r.backed);
            return (
              <div
                key={s.marketId}
                className={`rounded-lg border transition-all ${
                  s.status === "BET_PLACED" ? "border-blue-500/30 bg-blue-500/5" :
                  s.status === "SKIPPED"    ? "border-amber-500/15 bg-amber-500/3" :
                  s.status === "MISSED"     ? "border-red-500/10 bg-red-500/3 opacity-70" :
                  "border-border/50 bg-card/40"
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleSchedule(s.marketId)}
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-accent/30 transition-colors rounded-lg"
                >
                  {isOpen
                    ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                  <div className="text-xs tabular-nums text-muted-foreground w-12 flex-shrink-0">
                    {fmtTime(s.marketStartTime)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">{s.eventName}</span>
                      <span className="text-[11px] text-muted-foreground truncate">· {s.marketName}</span>
                    </div>
                    {s.skipReason && !isOpen && (
                      <div className="text-[10px] text-amber-400/70 mt-0.5 truncate">{s.skipReason}</div>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground flex-shrink-0">
                    {s.runnerCount ? `${s.runnerCount} runners` : "—"}
                  </div>
                  {(() => {
                    const race = raceByMarket.get(s.marketId);
                    if (race?.settled) {
                      const p = race.netProfit;
                      const positive = p > 0;
                      return (
                        <span
                          className={`text-xs font-semibold tabular-nums px-2 py-0.5 rounded-md flex-shrink-0 ${
                            positive
                              ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/30"
                              : p < 0
                                ? "text-red-400 bg-red-500/10 border border-red-500/30"
                                : "text-muted-foreground bg-muted/30 border border-border/40"
                          }`}
                          title={race.winnerName ? `Winner: ${race.winnerName}` : undefined}
                        >
                          {positive ? "+" : ""}£{p.toFixed(2)}
                        </span>
                      );
                    }
                    return null;
                  })()}
                  {statusBadge(s.status)}
                </button>

                {isOpen && (
                  <div className="px-4 pb-3 pt-1 border-t border-border/30 mt-1 space-y-2">
                    {s.skipReason && (
                      <div className="text-xs text-amber-400/90 bg-amber-500/5 border border-amber-500/20 rounded px-3 py-1.5">
                        <strong>Skipped:</strong> {s.skipReason}
                      </div>
                    )}

                    {runners.length === 0 ? (
                      <div className="text-xs text-muted-foreground py-2 italic">
                        No runner snapshot yet — race not yet processed
                      </div>
                    ) : (
                      <div className="space-y-1 mt-2">
                        <div className="grid grid-cols-12 gap-2 text-[10px] text-muted-foreground uppercase tracking-wide pb-1 px-2">
                          <div className="col-span-1">#</div>
                          <div className="col-span-5">Runner</div>
                          <div className="col-span-2 text-right">Odds</div>
                          <div className="col-span-2 text-right">Action</div>
                          <div className="col-span-2 text-right">Net if wins</div>
                        </div>
                        {runners.map((r, i) => (
                          <div
                            key={`${s.marketId}-${i}`}
                            className={`grid grid-cols-12 gap-2 text-xs py-1.5 px-2 rounded ${
                              r.backed
                                ? r.betType === "LAY"
                                  ? "bg-red-500/8 border border-red-500/20"
                                  : "bg-emerald-500/8 border border-emerald-500/20"
                                : "bg-card/30"
                            }`}
                          >
                            <div className="col-span-1 text-muted-foreground tabular-nums">{i + 1}</div>
                            <div className="col-span-5 truncate font-medium">{r.name}</div>
                            <div className="col-span-2 text-right tabular-nums">{r.price.toFixed(2)}</div>
                            <div className="col-span-2 text-right">
                              {r.backed ? (
                                r.betType === "LAY" ? (
                                  <span className="inline-flex items-center gap-0.5 text-red-400 font-semibold">
                                    <ArrowDownCircle className="w-3 h-3" />
                                    LAY £{r.stake?.toFixed(2)}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-0.5 text-emerald-400 font-semibold">
                                    <ArrowUpCircle className="w-3 h-3" />
                                    BACK £{r.stake?.toFixed(2)}
                                  </span>
                                )
                              ) : (
                                <span className="text-muted-foreground/60 inline-flex items-center gap-0.5">
                                  <MinusCircle className="w-3 h-3" />no bet
                                </span>
                              )}
                            </div>
                            <div className={`col-span-2 text-right tabular-nums ${
                              r.netProfit == null ? "text-muted-foreground" :
                              r.netProfit > 0 ? "text-emerald-400" :
                              r.netProfit < 0 ? "text-red-400" :
                              "text-muted-foreground"
                            }`}>
                              {r.netProfit == null
                                ? "—"
                                : `${r.netProfit >= 0 ? "+" : ""}£${r.netProfit.toFixed(2)}`}
                            </div>
                          </div>
                        ))}
                        {hasBets && (
                          <Link href={`/dutchingbot/race/${s.marketId}`}>
                            <button className="text-xs text-blue-400 hover:text-blue-300 mt-1 inline-flex items-center gap-1">
                              View settled result <ChevronRight className="w-3 h-3" />
                            </button>
                          </Link>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── BOTTOM: Race history + log feed ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Race history (2/3 width) */}
        <div className="lg:col-span-2 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Bets Placed — Race History
            </h2>
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
              No bets placed yet — the bot will trade races as they enter the 1-4 minute window
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
                        <span>{fmtTime(race.placedAt)} {fmtDate(race.placedAt)}</span>
                        <span>·</span>
                        <span>{race.betCount} {race.betCount === 1 ? "bet" : "bets"}</span>
                        <span>·</span>
                        <span>£{race.totalStaked.toFixed(2)} staked</span>
                      </div>
                    </div>

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

          <div className="rounded-xl border border-border/40 bg-muted/20 px-4 py-3 text-xs text-muted-foreground space-y-2">
            <p className="font-semibold text-foreground/70">Combo strategy</p>
            <p><strong className="text-emerald-400">Heavy fav (&lt;2.5):</strong> back £outlay on the favourite — wins ~67% of the time.</p>
            <p><strong className="text-red-400">Mid fav (3.0–5.0):</strong> lay the favourite — actual wins (~18%) below implied (~25%).</p>
            <p><strong className="text-red-400">Open race (fav≥5.0):</strong> lay top 2 with half-liability each.</p>
            <p className="text-[10px] mt-2">Backtested on 197 real UK/IE races — net +£586 vs old Hybrid Fav -£1,338.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
