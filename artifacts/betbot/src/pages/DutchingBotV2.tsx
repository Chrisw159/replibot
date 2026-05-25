import { useEffect, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "wouter";
import {
  TrendingUp, TrendingDown, Trophy, Clock,
  Play, Square, Loader2, AlertCircle, Lock, ShieldAlert, FlaskConical,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface V2Status {
  id: "premium" | "conservative";
  label: string;
  isRunning: boolean;
  startedAt: string | null;
  config: {
    id: string;
    label: string;
    totalOutlay: number;
    profitLockGBP: number;
    lossStopGBP: number;
  };
  racesToday: number;
  betsToday: number;
  profitToday: number;
  totalRaces: number;
  totalBets: number;
  totalNetProfit: number;
  dailyProfitLock: { locked: boolean; net: number; target: number };
  dailyLossStop:   { stopped: boolean; net: number; threshold: number };
}

interface V2Race {
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

interface V2Log {
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
function fmtDateTime(iso: string) {
  return `${new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" })} ${fmtTime(iso)}`;
}

export default function DutchingBotV2() {
  const params = useParams<{ variant: string }>();
  const variant = params.variant === "premium" ? "premium" : "conservative";
  const qc = useQueryClient();
  const [logs, setLogs] = useState<V2Log[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: status } = useQuery<V2Status>({
    queryKey: ["dutch-v2-status", variant],
    queryFn: () => apiFetch(`/dutch-v2/${variant}/status`),
    refetchInterval: 5000,
  });

  const startMutation = useMutation({
    mutationFn: () => apiFetch<V2Status>(`/dutch-v2/${variant}/start`, { method: "POST" }),
    onSuccess: () => { setActionError(null); qc.invalidateQueries({ queryKey: ["dutch-v2-status", variant] }); },
    onError: (e: Error) => setActionError(e.message || "Failed to start"),
  });
  const stopMutation = useMutation({
    mutationFn: () => apiFetch<V2Status>(`/dutch-v2/${variant}/stop`, { method: "POST" }),
    onSuccess: () => { setActionError(null); qc.invalidateQueries({ queryKey: ["dutch-v2-status", variant] }); },
    onError: (e: Error) => setActionError(e.message || "Failed to stop"),
  });

  const { data: races, isLoading: racesLoading } = useQuery<V2Race[]>({
    queryKey: ["dutch-v2-races", variant],
    queryFn: () => apiFetch(`/dutch-v2/${variant}/races`),
    refetchInterval: 10000,
  });

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/dutch-v2/${variant}/logs?limit=50`);
      if (res.ok) setLogs(await res.json());
    } catch { /* silent */ }
  }, [variant]);

  useEffect(() => {
    fetchLogs();
    const i = setInterval(fetchLogs, 5000);
    return () => clearInterval(i);
  }, [fetchLogs]);

  const isRunning = status?.isRunning ?? false;
  const profitLock = status?.dailyProfitLock;
  const lossStop   = status?.dailyLossStop;
  const isProfitLocked = !!profitLock?.locked;
  const isLossStopped  = !!lossStop?.stopped;
  const isAnyLocked    = isProfitLocked || isLossStopped;
  const actionBusy = startMutation.isPending || stopMutation.isPending;

  const todayP = status?.profitToday ?? 0;
  const allP   = status?.totalNetProfit ?? 0;
  const won  = races?.filter(r => r.settled && r.netProfit > 0).length ?? 0;
  const lost = races?.filter(r => r.settled && r.netProfit <= 0).length ?? 0;
  const pending = races?.filter(r => !r.settled).length ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FlaskConical className="w-6 h-6 text-violet-400" />
            {status?.label ?? (variant === "premium" ? "V2 Premium" : "V2 Conservative")}
            <Badge className="bg-violet-500/15 text-violet-400 border-violet-500/30 text-xs">Paper · Test</Badge>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            V2 filters: BACK fav 2.0–2.5 (skip 8–9 runners) · LAY fav 3.0–3.6 (≥8 runners) · LAY top 2 if fav ≥ 5.0 · skip Hurdle/NHF
          </p>
          {status?.config && (
            <p className="text-xs text-muted-foreground mt-1">
              Stake <span className="font-semibold text-foreground">£{status.config.totalOutlay}</span> ·
              profit lock <span className="font-semibold text-emerald-400">+£{status.config.profitLockGBP}</span> ·
              loss stop <span className="font-semibold text-red-400">−£{status.config.lossStopGBP}</span>
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${
                isLossStopped ? "bg-red-400 animate-pulse" :
                isProfitLocked ? "bg-amber-400 animate-pulse" :
                isRunning ? "bg-emerald-400 animate-pulse" :
                "bg-muted-foreground/40"}`}
              />
              {isLossStopped
                ? <span className="text-red-400">Paused — daily loss stop</span>
                : isProfitLocked
                ? <span className="text-amber-400">Paused — daily profit lock</span>
                : isRunning
                ? <span className="text-emerald-400">Running{status?.startedAt ? ` since ${fmtTime(status.startedAt)}` : ""}</span>
                : <span className="text-muted-foreground">Stopped</span>}
            </div>
            {isRunning ? (
              <button type="button" disabled={actionBusy} onClick={() => stopMutation.mutate()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-medium transition-colors">
                {actionBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4 fill-current" />}
                Stop bot
              </button>
            ) : (
              <button type="button" disabled={actionBusy} onClick={() => startMutation.mutate()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-medium transition-colors">
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

      {/* Lock banners */}
      {isProfitLocked && profitLock && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3">
          <Lock className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-amber-300">
              Daily profit lock hit — no new bets until midnight UTC
            </div>
            <div className="text-xs text-amber-200/80 mt-1">
              Today's settled net <span className="font-semibold">£{profitLock.net.toFixed(2)}</span> reached your target of <span className="font-semibold">£{profitLock.target.toFixed(2)}</span>.
            </div>
          </div>
        </div>
      )}
      {isLossStopped && lossStop && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-red-300">
              Daily loss stop hit — no new bets until midnight UTC
            </div>
            <div className="text-xs text-red-200/80 mt-1">
              Today's settled net <span className="font-semibold">£{lossStop.net.toFixed(2)}</span> breached the −£{lossStop.threshold.toFixed(2)} floor.
            </div>
          </div>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Today's P&L",     value: `${todayP >= 0 ? "+" : ""}£${todayP.toFixed(2)}`, sub: `${status?.racesToday ?? 0} races today`,
            colour: todayP > 0 ? "text-emerald-400" : todayP < 0 ? "text-red-400" : "text-foreground" },
          { label: "All-time P&L",    value: `${allP   >= 0 ? "+" : ""}£${allP.toFixed(2)}`,   sub: `${status?.totalRaces ?? 0} races · ${status?.totalBets ?? 0} bets`,
            colour: allP > 0 ? "text-emerald-400" : allP < 0 ? "text-red-400" : "text-foreground" },
          { label: "Profitable races", value: String(won), sub: `${lost} losing · ${pending} pending`, colour: "text-foreground" },
          { label: "Lock status",      value: isAnyLocked ? "PAUSED" : isRunning ? "ACTIVE" : "OFF",
            sub: isProfitLocked ? "profit lock" : isLossStopped ? "loss stop" : isRunning ? "scanning markets" : "bot stopped",
            colour: isAnyLocked ? "text-amber-400" : isRunning ? "text-emerald-400" : "text-muted-foreground" },
        ].map(({ label, value, sub, colour }) => (
          <div key={label} className="rounded-xl border border-border/60 bg-card/60 px-5 py-4">
            <div className="text-xs text-muted-foreground mb-1">{label}</div>
            <div className={`text-2xl font-bold tabular-nums ${colour}`}>{value}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
          </div>
        ))}
      </div>

      {/* Race history */}
      <section className="space-y-2">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Trophy className="w-4 h-4" /> Recent Races
          </h2>
          <span className="text-xs text-muted-foreground">
            {races?.length ?? 0} races · {won} won · {lost} lost · {pending} pending
          </span>
        </div>

        {racesLoading && <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>}
        {!racesLoading && (races?.length ?? 0) === 0 && (
          <div className="rounded-xl border border-dashed border-border/60 py-10 text-center text-muted-foreground text-sm">
            <Clock className="w-7 h-7 mx-auto mb-2 opacity-20" />
            No paper bets placed yet — start the bot to begin scanning UK/IE races
          </div>
        )}

        <div className="space-y-1.5 max-h-[500px] overflow-y-auto pr-1">
          {races?.map(r => (
            <div key={r.marketId}
              className={`rounded-lg border px-4 py-2.5 flex items-center gap-3 ${
                !r.settled ? "border-border/50 bg-card/40" :
                r.netProfit > 0 ? "border-emerald-500/30 bg-emerald-500/5" :
                r.netProfit < 0 ? "border-red-500/30 bg-red-500/5" :
                "border-border/50 bg-card/40"
              }`}>
              <div className="text-xs tabular-nums text-muted-foreground w-20 flex-shrink-0">{fmtDateTime(r.placedAt)}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{r.eventName}</span>
                  <span className="text-[11px] text-muted-foreground truncate">· {r.marketName}</span>
                </div>
                {r.winnerName && (
                  <div className="text-[10px] text-muted-foreground mt-0.5 truncate">Winner: {r.winnerName}</div>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground flex-shrink-0">
                £{r.totalStaked.toFixed(2)} staked
              </div>
              {r.settled ? (
                <span className={`text-xs font-semibold tabular-nums px-2 py-0.5 rounded-md flex-shrink-0 ${
                  r.netProfit > 0 ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/30" :
                  r.netProfit < 0 ? "text-red-400 bg-red-500/10 border border-red-500/30" :
                  "text-muted-foreground bg-muted/30 border border-border/40"
                }`}>
                  {r.netProfit > 0 ? <TrendingUp className="w-3 h-3 inline mr-0.5" /> :
                   r.netProfit < 0 ? <TrendingDown className="w-3 h-3 inline mr-0.5" /> : null}
                  {r.netProfit >= 0 ? "+" : ""}£{r.netProfit.toFixed(2)}
                </span>
              ) : (
                <Badge className="bg-muted text-muted-foreground text-[10px]">Pending</Badge>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Logs */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">System Console</h2>
        <div className="rounded-lg border border-border/50 bg-black/40 p-3 max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed">
          {logs.length === 0 && <div className="text-muted-foreground">No log activity yet…</div>}
          {logs.map(l => (
            <div key={l.id} className={`whitespace-pre-wrap ${
              l.level === "error" ? "text-red-400" :
              l.level === "warn"  ? "text-amber-300" :
              "text-emerald-300/90"
            }`}>
              <span className="text-muted-foreground">{fmtTime(l.createdAt)}</span> {l.message}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
