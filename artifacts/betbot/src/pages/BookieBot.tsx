import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Play, Square, RefreshCw,
  TrendingUp, TrendingDown, CircleDot, ChevronRight,
  CalendarDays, CheckCircle2, XCircle, Clock, HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

interface DutchStatus {
  isRunning: boolean;
  startedAt: string | null;
  paperTradingMode: boolean;
  dutchConfig: {
    totalOutlay: number;
    topPct: number;
    minFavPrice: number;
    minLiquidity: number;
    countryCodes: string[];
    minRunners: number;
  };
  racesToday: number;
  profitToday: number;
  totalRaces: number;
  totalNetProfit: number;
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

interface LogEntry {
  id: number;
  level: string;
  message: string;
  createdAt: string;
}

interface ScheduleRunner {
  name: string;
  price: number;
  backed: boolean;
  stake?: number;
  netProfit?: number;
}

interface ScheduleEntry {
  id: number;
  marketId: string;
  eventName: string;
  marketName: string;
  marketStartTime: string;
  runnerCount: number | null;
  status: string;
  skipReason: string | null;
  scheduledDate: string;
  runnersJson: ScheduleRunner[] | null;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

function fmtProfit(n: number, settled: boolean) {
  if (!settled) return { text: "Pending", cls: "text-muted-foreground" };
  if (n > 0) return { text: `+£${n.toFixed(2)}`, cls: "text-emerald-400" };
  if (n < 0) return { text: `-£${Math.abs(n).toFixed(2)}`, cls: "text-red-400" };
  return { text: "£0.00", cls: "text-muted-foreground" };
}

function levelColor(level: string) {
  if (level === "error") return "text-red-400";
  if (level === "warn")  return "text-amber-400";
  return "text-emerald-400/80";
}

export default function BookieBot() {
  const qc = useQueryClient();
  const consoleRef = useRef<HTMLDivElement>(null);

  const { data: status, isLoading } = useQuery<DutchStatus>({
    queryKey: ["dutch-status"],
    queryFn: () => apiFetch("/dutch/status"),
    refetchInterval: 15_000,
  });

  const { data: races } = useQuery<DutchRace[]>({
    queryKey: ["dutch-races"],
    queryFn: () => apiFetch("/dutch/races"),
    refetchInterval: 30_000,
  });

  const { data: schedule, isFetching: scheduleFetching } = useQuery<ScheduleEntry[]>({
    queryKey: ["dutch-schedule"],
    queryFn: () => apiFetch("/dutch/schedule"),
    refetchInterval: 20_000,
  });

  const refreshScheduleMutation = useMutation({
    mutationFn: () => apiFetch<ScheduleEntry[]>("/dutch/schedule/refresh", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dutch-schedule"] }),
  });

  const { data: logs } = useQuery<LogEntry[]>({
    queryKey: ["dutch-logs"],
    queryFn: () => apiFetch("/dutch/logs?limit=100"),
    refetchInterval: 10_000,
  });

  // Auto-scroll console to bottom when new logs arrive
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs]);

  const startMutation = useMutation({
    mutationFn: () => apiFetch<DutchStatus>("/dutch/start", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dutch-status"] });
      qc.invalidateQueries({ queryKey: ["dutch-logs"] });
    },
  });
  const stopMutation = useMutation({
    mutationFn: () => apiFetch<DutchStatus>("/dutch/stop", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dutch-status"] });
      qc.invalidateQueries({ queryKey: ["dutch-logs"] });
    },
  });
  const paperMutation = useMutation({
    mutationFn: (v: boolean) =>
      apiFetch("/bot/config", { method: "PATCH", body: JSON.stringify({ paperTradingMode: v }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dutch-status"] }),
  });
  const configMutation = useMutation({
    mutationFn: (body: Partial<{
      totalOutlay: number; topPct: number; minFavPrice: number;
      minLiquidity: number; minRunners: number;
    }>) => apiFetch("/dutch/config", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dutch-status"] });
      setOutlayInput(""); setTopPctInput(""); setFavInput(""); setLiqInput(""); setMinRunnersInput("");
    },
  });

  const [outlayInput,     setOutlayInput]     = useState("");
  const [topPctInput,     setTopPctInput]     = useState("");
  const [favInput,        setFavInput]        = useState("");
  const [liqInput,        setLiqInput]        = useState("");
  const [minRunnersInput, setMinRunnersInput] = useState("");

  const isRunning = status?.isRunning ?? false;
  const isPaper   = status?.paperTradingMode ?? true;
  const cfg       = status?.dutchConfig;
  const nothingChanged = !outlayInput && !topPctInput && !favInput && !liqInput && !minRunnersInput;

  const profitToday    = status?.profitToday    ?? 0;
  const totalNetProfit = status?.totalNetProfit ?? 0;
  const sortedLogs = logs ? [...logs].reverse() : [];

  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD local
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set());
  const [expandedRaces, setExpandedRaces] = useState<Set<number>>(new Set());
  const toggleRace = (id: number) =>
    setExpandedRaces(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleDay = (d: string) =>
    setCollapsedDays(prev => {
      const next = new Set(prev);
      next.has(d) ? next.delete(d) : next.add(d);
      return next;
    });

  // Group race history by local calendar date, newest first
  const racesByDay = useMemo(() => {
    if (!races || races.length === 0) return [];
    const map = new Map<string, DutchRace[]>();
    for (const race of races) {
      const d = new Date(race.placedAt).toLocaleDateString("en-CA");
      const list = map.get(d) ?? [];
      list.push(race);
      map.set(d, list);
    }
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, dayRaces]) => ({
        date,
        label: date === today
          ? "Today"
          : new Date(date + "T12:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }),
        races: dayRaces,
        dayPnl: dayRaces.reduce((s, r) => s + (r.settled ? r.netProfit : 0), 0),
      }));
  }, [races, today]);

  // Collapse all non-today days on first load
  useEffect(() => {
    if (racesByDay.length === 0) return;
    setCollapsedDays(prev => {
      const next = new Set(prev);
      for (const { date } of racesByDay) {
        if (date !== today && !next.has(date)) next.add(date);
      }
      return next;
    });
  }, [racesByDay, today]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bookie Bot</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Dutching strategy — backs top {cfg ? Math.round(cfg.topPct * 100) : 40}% of field, equal profit on any winner
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries()}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          {isRunning ? (
            <Button variant="destructive" size="sm" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending}>
              <Square className="w-3.5 h-3.5 mr-1.5" />Stop
            </Button>
          ) : (
            <Button size="sm" onClick={() => startMutation.mutate()} disabled={startMutation.isPending || isLoading}>
              <Play className="w-3.5 h-3.5 mr-1.5" />Start
            </Button>
          )}
        </div>
      </div>

      {/* Status badges */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className={isRunning
          ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
          : "text-muted-foreground"}>
          <CircleDot className={`w-2.5 h-2.5 mr-1.5 ${isRunning ? "text-emerald-400" : ""}`} />
          {isRunning ? "Running" : "Stopped"}
        </Badge>
        <Badge variant="outline" className={isPaper
          ? "border-amber-500/40 text-amber-400 bg-amber-500/10"
          : "border-emerald-500/30 text-emerald-400"}>
          {isPaper ? "Paper trading" : "Live"}
        </Badge>
        <Badge variant="outline" className="text-muted-foreground">
          GB + IE · WIN · 1–4 min before start · fav ≥ {cfg?.minFavPrice ?? 4.0} · £{cfg?.totalOutlay ?? 50}/race
        </Badge>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Races today",   value: String(status?.racesToday ?? 0) },
          {
            label: "Today P&L",
            value: profitToday >= 0 ? `+£${profitToday.toFixed(2)}` : `-£${Math.abs(profitToday).toFixed(2)}`,
            cls: profitToday > 0 ? "text-emerald-400" : profitToday < 0 ? "text-red-400" : "",
          },
          { label: "Total races",   value: String(status?.totalRaces ?? 0) },
          {
            label: "All-time P&L",
            value: totalNetProfit >= 0 ? `+£${totalNetProfit.toFixed(2)}` : `-£${Math.abs(totalNetProfit).toFixed(2)}`,
            cls: totalNetProfit > 0 ? "text-emerald-400" : totalNetProfit < 0 ? "text-red-400" : "",
          },
        ].map(({ label, value, cls }) => (
          <Card key={label} className="bg-card/60">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
              <div className={`text-2xl font-bold tabular-nums mt-0.5 ${cls ?? ""}`}>{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Today's Race Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-muted-foreground" />
              Today's Race Card
              {schedule && (
                <span className="text-muted-foreground font-normal text-xs ml-1">
                  ({schedule.filter(e => e.status !== "FILTERED_OUT").length} races)
                </span>
              )}
            </CardTitle>
            <Button
              variant="ghost" size="sm"
              onClick={() => refreshScheduleMutation.mutate()}
              disabled={refreshScheduleMutation.isPending || scheduleFetching}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshScheduleMutation.isPending || scheduleFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!schedule || schedule.filter(e => e.status !== "FILTERED_OUT").length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-muted-foreground">
              No races scheduled yet — click refresh or start the bot
            </div>
          ) : (
            <div className="divide-y divide-border/50 max-h-80 overflow-y-auto">
              {schedule
                .filter(e => e.status !== "FILTERED_OUT")
                .map(entry => {
                  const t = new Date(entry.marketStartTime);
                  const timeStr = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  const venue = entry.eventName.replace(/^\d{2}:\d{2}\s+/, "");
                  const isExpanded = expandedRaces.has(entry.id);
                  const isMuted = entry.status === "MISSED";

                  let icon, badge, detailLine;
                  if (entry.status === "BET_PLACED") {
                    icon = <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />;
                    badge = <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">BET</span>;
                    detailLine = "Bets placed — awaiting settlement";
                  } else if (entry.status === "SKIPPED") {
                    icon = <XCircle className="w-4 h-4 text-orange-400/70 flex-shrink-0" />;
                    badge = <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400/80">SKIP</span>;
                    detailLine = entry.skipReason ?? "Skipped by bot";
                  } else if (entry.status === "MISSED") {
                    icon = <HelpCircle className="w-4 h-4 text-muted-foreground/50 flex-shrink-0" />;
                    badge = <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground">MISS</span>;
                    detailLine = "Race started before bot could check it";
                  } else {
                    icon = <Clock className="w-4 h-4 text-muted-foreground/60 flex-shrink-0" />;
                    badge = null;
                    detailLine = "Waiting — bot will check 1–5 min before start";
                  }

                  return (
                    <div key={entry.id} className={`border-b border-border/30 last:border-0 ${isMuted ? "opacity-40" : ""}`}>
                      {/* Row header — click to expand */}
                      <button
                        onClick={() => toggleRace(entry.id)}
                        className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-muted/20 transition-colors text-left"
                      >
                        {icon}
                        <div className="w-11 text-xs tabular-nums text-muted-foreground flex-shrink-0">{timeStr}</div>
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-medium truncate ${isMuted ? "text-muted-foreground" : ""}`}>
                            {venue} — {entry.marketName}
                          </div>
                        </div>
                        {entry.runnerCount != null && (
                          <div className="text-xs text-muted-foreground/60 flex-shrink-0">{entry.runnerCount}r</div>
                        )}
                        {badge}
                        <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                      </button>
                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="px-5 pb-4 pt-2 bg-muted/10 border-t border-border/20">
                          {/* Status / reason line */}
                          <p className={`text-xs leading-relaxed mb-2 ${entry.status === "SKIPPED" ? "text-orange-300/80" : entry.status === "BET_PLACED" ? "text-emerald-400/80" : "text-muted-foreground"}`}>
                            {detailLine}
                          </p>

                          {/* Runner table — shown once the bot has processed this race */}
                          {entry.runnersJson && entry.runnersJson.length > 0 ? (
                            <div className="rounded-md border border-border/30 overflow-hidden mt-1">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b border-border/30 bg-muted/20">
                                    <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Runner</th>
                                    <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Price</th>
                                    {entry.status === "BET_PLACED" && (
                                      <>
                                        <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Stake</th>
                                        <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Net if wins</th>
                                      </>
                                    )}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-border/20">
                                  {entry.runnersJson.map((r, i) => (
                                    <tr
                                      key={i}
                                      className={r.backed ? "bg-emerald-500/5" : ""}
                                    >
                                      <td className="px-3 py-1.5 flex items-center gap-1.5">
                                        {r.backed && (
                                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
                                        )}
                                        <span className={r.backed ? "text-emerald-300 font-medium" : "text-muted-foreground"}>
                                          {r.name}
                                        </span>
                                      </td>
                                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                                        {r.price.toFixed(2)}
                                      </td>
                                      {entry.status === "BET_PLACED" && (
                                        <>
                                          <td className="px-3 py-1.5 text-right tabular-nums">
                                            {r.stake != null
                                              ? <span className="text-emerald-400">£{r.stake.toFixed(2)}</span>
                                              : <span className="text-muted-foreground/40">—</span>}
                                          </td>
                                          <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                                            {r.netProfit != null ? (
                                              r.netProfit >= 0
                                                ? <span className="text-emerald-400">+£{r.netProfit.toFixed(2)}</span>
                                                : <span className="text-red-400">-£{Math.abs(r.netProfit).toFixed(2)}</span>
                                            ) : <span className="text-muted-foreground/40">—</span>}
                                          </td>
                                        </>
                                      )}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : entry.status === "SCHEDULED" ? (
                            <p className="text-[10px] text-muted-foreground/50 italic">
                              Runner details will appear when the bot checks this race (1–4 min before start)
                            </p>
                          ) : null}

                          <div className="flex gap-4 mt-2 text-[10px] text-muted-foreground/50">
                            {entry.runnerCount != null && <span>{entry.runnerCount} runners</span>}
                            <span>{t.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · {timeStr}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: race history + console */}
        <div className="lg:col-span-2 space-y-4">
          {/* Race history */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Race History</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {racesByDay.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                  No races yet — start the bot to begin
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {racesByDay.map(({ date, label, races: dayRaces, dayPnl }) => {
                    const collapsed = collapsedDays.has(date);
                    const pnlCls = dayPnl > 0 ? "text-emerald-400" : dayPnl < 0 ? "text-red-400" : "text-muted-foreground";
                    const pnlStr = dayPnl > 0 ? `+£${dayPnl.toFixed(2)}` : dayPnl < 0 ? `-£${Math.abs(dayPnl).toFixed(2)}` : "£0.00";
                    return (
                      <div key={date}>
                        {/* Day header — always visible */}
                        <button
                          onClick={() => toggleDay(date)}
                          className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-muted/20 transition-colors text-left"
                        >
                          <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground/60 flex-shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex-1">{label}</span>
                          <span className="text-xs text-muted-foreground/60">{dayRaces.length} race{dayRaces.length !== 1 ? "s" : ""}</span>
                          <span className={`text-xs font-bold tabular-nums ml-3 ${pnlCls}`}>{pnlStr}</span>
                        </button>
                        {/* Race rows — hidden when collapsed */}
                        {!collapsed && dayRaces.map(race => {
                          const p = fmtProfit(race.netProfit, race.settled);
                          const t = new Date(race.placedAt);
                          return (
                            <Link key={race.marketId} href={`/bookiebot/race/${race.marketId}`}>
                              <div className="flex items-center gap-3 px-5 py-3 hover:bg-muted/30 cursor-pointer transition-colors group border-t border-border/30">
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium text-sm truncate group-hover:text-foreground">{race.eventName}</div>
                                  <div className="text-xs text-muted-foreground">
                                    {race.marketName} · {race.betCount} backed · £{race.totalStaked.toFixed(2)} outlay
                                    {" · "}{t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                  </div>
                                  {race.winnerName && (
                                    <div className="text-xs text-emerald-400/80 mt-0.5">Winner: {race.winnerName}</div>
                                  )}
                                </div>
                                <div className="text-right flex-shrink-0">
                                  <div className={`text-sm font-bold tabular-nums ${p.cls}`}>{p.text}</div>
                                  {race.settled
                                    ? <div className="text-[10px] text-muted-foreground">Settled</div>
                                    : <div className="text-[10px] text-amber-400/70">Pending</div>}
                                </div>
                                <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-muted-foreground flex-shrink-0" />
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* System console */}
          <Card>
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">System Console</CardTitle>
              <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground"
                onClick={() => qc.invalidateQueries({ queryKey: ["dutch-logs"] })}>
                <RefreshCw className="w-3 h-3 mr-1" />Refresh
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <div
                ref={consoleRef}
                className="h-64 overflow-y-auto font-mono text-[11px] bg-black/40 rounded-b-lg px-4 py-3 space-y-0.5"
              >
                {!sortedLogs.length ? (
                  <div className="text-muted-foreground/50 pt-2">No log entries yet...</div>
                ) : (
                  sortedLogs.map(l => {
                    const t = new Date(l.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                    return (
                      <div key={l.id} className="flex gap-2 leading-5">
                        <span className="text-muted-foreground/40 flex-shrink-0 w-20">{t}</span>
                        <span className={`flex-shrink-0 w-8 uppercase ${levelColor(l.level)}`}>{l.level.slice(0, 4)}</span>
                        <span className="text-muted-foreground/90 break-all">{l.message}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: config panel */}
        <div className="space-y-4">
          {/* Paper trading */}
          <Card>
            <CardContent className="pt-4 pb-4 px-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Paper Trading</div>
                  <div className="text-xs text-muted-foreground">No real money placed</div>
                </div>
                <Switch checked={isPaper} onCheckedChange={v => paperMutation.mutate(v)} disabled={paperMutation.isPending} />
              </div>
              {!isPaper && (
                <div className="rounded-md bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400">
                  Live mode — real money will be placed on Betfair
                </div>
              )}
            </CardContent>
          </Card>

          {/* Config */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Total Outlay Per Race (£)</Label>
                <Input
                  type="number" min={2} max={10000}
                  placeholder={`Current: £${cfg?.totalOutlay ?? 50}`}
                  value={outlayInput} onChange={e => setOutlayInput(e.target.value)}
                  className="h-8 text-sm"
                />
                <p className="text-[10px] text-muted-foreground/70">Split across backed runners (dutched)</p>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Top % of Field to Back</Label>
                <Input
                  type="number" min={10} max={100} step={5}
                  placeholder={`Current: ${cfg ? Math.round(cfg.topPct * 100) : 40}%`}
                  value={topPctInput} onChange={e => setTopPctInput(e.target.value)}
                  className="h-8 text-sm"
                />
                <p className="text-[10px] text-muted-foreground/70">Enter as a number, e.g. 40</p>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Min Favourite Price (decimal)</Label>
                <Input
                  type="number" min={1.5} max={20} step={0.5}
                  placeholder={`Current: ${cfg?.minFavPrice ?? 4.0}`}
                  value={favInput} onChange={e => setFavInput(e.target.value)}
                  className="h-8 text-sm"
                />
                <p className="text-[10px] text-muted-foreground/70">Skip races where favourite is shorter</p>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Min Market Liquidity (£)</Label>
                <Input
                  type="number" min={0}
                  placeholder={`Current: £${cfg?.minLiquidity ?? 3000}`}
                  value={liqInput} onChange={e => setLiqInput(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Min Runners</Label>
                <Input
                  type="number" min={2} max={20}
                  placeholder={`Current: ${cfg?.minRunners ?? 4}`}
                  value={minRunnersInput} onChange={e => setMinRunnersInput(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>

              <Button
                onClick={() => {
                  const patch: Record<string, number> = {};
                  if (outlayInput)     patch.totalOutlay  = parseFloat(outlayInput);
                  if (topPctInput)     patch.topPct       = parseFloat(topPctInput) / 100;
                  if (favInput)        patch.minFavPrice  = parseFloat(favInput);
                  if (liqInput)        patch.minLiquidity = parseFloat(liqInput);
                  if (minRunnersInput) patch.minRunners   = parseInt(minRunnersInput, 10);
                  if (Object.keys(patch).length > 0) configMutation.mutate(patch);
                }}
                disabled={configMutation.isPending || nothingChanged}
                className="w-full h-8 text-xs"
              >
                Save Config
              </Button>

              <div className="text-[10px] text-muted-foreground/60 border-t border-border/40 pt-3 space-y-0.5">
                <div>Countries: GB + IE · Market type: WIN</div>
                <div>Timing: 1–4 min before start · Odds cap: 50/1</div>
              </div>
            </CardContent>
          </Card>

          {/* How it works */}
          <Card className="bg-muted/20">
            <CardContent className="pt-4 pb-4 px-4 text-xs text-muted-foreground space-y-1.5">
              <div className="font-medium text-muted-foreground/90">How it works</div>
              <div>Scans races 1–4 min before the off. Skips any race where the favourite is under 3/1. Backs the top 40% of the field by market weight, dutching the stakes so every backed horse returns the same profit.</div>
              <div className="flex items-center gap-1.5 text-emerald-400/80">
                <TrendingUp className="w-3 h-3 flex-shrink-0" />
                Any backed runner wins = +profit
              </div>
              <div className="flex items-center gap-1.5 text-red-400/80">
                <TrendingDown className="w-3 h-3 flex-shrink-0" />
                Unbacked runner wins = lose outlay
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
