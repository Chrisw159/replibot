import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  TrendingUp, TrendingDown, Trophy, Clock,
  CircleOff, CheckCircle2, ArrowUpCircle,
  Play, Square, Loader2, AlertCircle, Settings as SettingsIcon,
  RotateCcw, Repeat, AlertTriangle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface MartingaleConfig {
  startStake: number;
  minOdds: number;
  maxOdds: number;
  maxDoubles: number;
  minLiquidity: number;
  eventTypeIds: string[];
}

interface MartingaleStateInfo {
  currentStake: number;
  lossStreak: number;
  nextStakeIfLoss: number;
  atCap: boolean;
}

interface MartingaleStatus {
  strategyName: string;
  isRunning: boolean;
  startedAt: string | null;
  paperTradingMode: boolean;
  martingaleConfig: MartingaleConfig;
  martingaleState: MartingaleStateInfo;
  racesToday: number;
  betsToday: number;
  profitToday: number;
  totalRaces: number;
  totalBets: number;
  totalNetProfit: number;
  totalStaked: number;
  roiPct: number;
  winRate: number;
  settledRaces: number;
  winRaces: number;
}

interface MartingaleRace {
  marketId: string;
  marketName: string;
  eventName: string;
  selectionName: string;
  betType: "BACK" | "LAY";
  triggerOdds: number;
  matchedOdds: number | null;
  stake: number;
  netProfit: number | null;
  status: string;
  placedAt: string;
  settledAt: string | null;
  settled: boolean;
}

interface MartingaleLog {
  id: number;
  level: string;
  message: string;
  createdAt: string;
}

const SPORT_OPTIONS: { id: string; label: string }[] = [
  { id: "7",    label: "Horse Racing (GB/IE)" },
  { id: "1",    label: "Soccer" },
  { id: "2",    label: "Tennis" },
  { id: "7522", label: "Basketball" },
];

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

export default function Martingale() {
  const qc = useQueryClient();
  const [logs, setLogs] = useState<MartingaleLog[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [draft, setDraft] = useState<MartingaleConfig | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const statusKey = ["martingale-status"];

  const { data: stats } = useQuery<MartingaleStatus>({
    queryKey: statusKey,
    queryFn: () => apiFetch(`/martingale/status`),
    refetchInterval: 5000,
  });

  const { data: races, isLoading: racesLoading } = useQuery<MartingaleRace[]>({
    queryKey: ["martingale-races"],
    queryFn: () => apiFetch(`/martingale/races`),
    refetchInterval: 10000,
  });

  const startMutation = useMutation({
    mutationFn: () => apiFetch<MartingaleStatus>(`/martingale/start`, { method: "POST" }),
    onSuccess: () => { setActionError(null); qc.invalidateQueries({ queryKey: statusKey }); },
    onError: (e: Error) => setActionError(e.message || "Failed to start bot"),
  });
  const stopMutation = useMutation({
    mutationFn: () => apiFetch<MartingaleStatus>(`/martingale/stop`, { method: "POST" }),
    onSuccess: () => { setActionError(null); qc.invalidateQueries({ queryKey: statusKey }); },
    onError: (e: Error) => setActionError(e.message || "Failed to stop bot"),
  });
  const resetMutation = useMutation({
    mutationFn: () => apiFetch(`/martingale/reset`, { method: "POST" }),
    onSuccess: () => { setActionError(null); qc.invalidateQueries({ queryKey: statusKey }); },
    onError: (e: Error) => setActionError(e.message || "Failed to reset state"),
  });
  const saveConfigMutation = useMutation({
    mutationFn: (cfg: MartingaleConfig) =>
      apiFetch(`/martingale/config`, { method: "PATCH", body: JSON.stringify(cfg) }),
    onSuccess: () => {
      setSaveError(null);
      setConfigOpen(false);
      qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: (e: Error) => setSaveError(e.message || "Failed to save config"),
  });

  const isRunning  = stats?.isRunning ?? false;
  const actionBusy = startMutation.isPending || stopMutation.isPending;

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/martingale/logs?limit=50`);
      if (res.ok) setLogs(await res.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchLogs();
    const t = setInterval(fetchLogs, 5000);
    return () => clearInterval(t);
  }, [fetchLogs]);

  const todayP = stats?.profitToday ?? 0;
  const allP   = stats?.totalNetProfit ?? 0;
  const roi    = stats?.roiPct ?? 0;

  const won  = races?.filter(r => r.settled && (r.netProfit ?? 0) > 0).length ?? 0;
  const lost = races?.filter(r => r.settled && (r.netProfit ?? 0) <= 0).length ?? 0;
  const pending = races?.filter(r => !r.settled).length ?? 0;

  function openConfig() {
    if (!stats) return;
    setDraft({ ...stats.martingaleConfig });
    setSaveError(null);
    setConfigOpen(true);
  }

  function toggleSport(id: string) {
    if (!draft) return;
    const next = draft.eventTypeIds.includes(id)
      ? draft.eventTypeIds.filter(x => x !== id)
      : [...draft.eventTypeIds, id];
    setDraft({ ...draft, eventTypeIds: next });
  }

  const st = stats?.martingaleState;
  const maxStake = stats ? stats.martingaleConfig.startStake * Math.pow(2, stats.martingaleConfig.maxDoubles) : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Repeat className="w-6 h-6 text-amber-400" />
            Martingale Favourite
            <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-xs">Paper only</Badge>
            <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-xs">BACK</Badge>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            BACK the favourite in odds {stats?.martingaleConfig.minOdds.toFixed(2) ?? "2.50"}–{stats?.martingaleConfig.maxOdds.toFixed(2) ?? "3.50"}.
            Double stake after each loss, reset to £{stats?.martingaleConfig.startStake.toFixed(2) ?? "2.00"} on win or after {stats?.martingaleConfig.maxDoubles ?? 6} losses.
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
            <button
              type="button"
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border/60 hover:bg-accent text-sm font-medium transition-colors disabled:opacity-50"
              title="Reset stake to start and clear loss streak"
            >
              {resetMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              Reset
            </button>
            <button
              type="button"
              onClick={openConfig}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border/60 hover:bg-accent text-sm font-medium transition-colors"
            >
              <SettingsIcon className="w-4 h-4" /> Config
            </button>
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

      {/* Martingale state card */}
      {st && stats && (
        <div className={`rounded-xl border p-5 ${st.atCap ? "border-amber-500/40 bg-amber-500/5" : "border-border/60 bg-card/60"}`}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Next bet stake</div>
              <div className="text-3xl font-bold tabular-nums text-foreground">£{st.currentStake.toFixed(2)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">starts at £{stats.martingaleConfig.startStake.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Loss streak</div>
              <div className={`text-3xl font-bold tabular-nums ${st.lossStreak === 0 ? "text-foreground" : st.atCap ? "text-amber-400" : "text-red-400"}`}>
                {st.lossStreak}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">cap at {stats.martingaleConfig.maxDoubles} doubles</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">If next bet loses</div>
              <div className="text-2xl font-bold tabular-nums text-foreground/80">
                {st.lossStreak + 1 > stats.martingaleConfig.maxDoubles
                  ? <span className="text-amber-400">reset → £{stats.martingaleConfig.startStake.toFixed(2)}</span>
                  : <>→ £{st.nextStakeIfLoss.toFixed(2)}</>}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">double-up</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Series max stake</div>
              <div className="text-2xl font-bold tabular-nums text-foreground/80">£{maxStake.toFixed(2)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">£{stats.martingaleConfig.startStake.toFixed(0)} × 2^{stats.martingaleConfig.maxDoubles}</div>
            </div>
          </div>
          {st.atCap && (
            <div className="mt-4 flex items-center gap-2 text-xs text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              At maximum doubles — next loss will reset the series back to £{stats.martingaleConfig.startStake.toFixed(2)}.
            </div>
          )}
        </div>
      )}

      {/* P&L stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "Today's P&L",
            value: `${todayP >= 0 ? "+" : ""}£${todayP.toFixed(2)}`,
            sub: `${stats?.racesToday ?? 0} race${stats?.racesToday === 1 ? "" : "s"} · ${stats?.betsToday ?? 0} bet${stats?.betsToday === 1 ? "" : "s"} today`,
            colour: todayP > 0 ? "text-emerald-400" : todayP < 0 ? "text-red-400" : "text-foreground",
          },
          {
            label: "All-time P&L",
            value: `${allP >= 0 ? "+" : ""}£${allP.toFixed(2)}`,
            sub: `${stats?.totalRaces ?? 0} races · £${(stats?.totalStaked ?? 0).toFixed(0)} staked`,
            colour: allP > 0 ? "text-emerald-400" : allP < 0 ? "text-red-400" : "text-foreground",
          },
          {
            label: "ROI",
            value: `${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`,
            sub: `${stats?.winRate ?? 0}% win rate · ${stats?.winRaces ?? 0}/${stats?.settledRaces ?? 0} settled`,
            colour: roi > 0 ? "text-emerald-400" : roi < 0 ? "text-red-400" : "text-foreground",
          },
          {
            label: "Outcomes",
            value: String(won),
            sub: `${lost} losing · ${pending} pending`,
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

      {/* Config drawer */}
      {configOpen && draft && (
        <div className="rounded-xl border border-border/60 bg-card/60 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide">Strategy Config</h2>
            <button type="button" onClick={() => setConfigOpen(false)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { label: "Start stake (£)", key: "startStake" as const, step: 1 },
              { label: "Min fav odds", key: "minOdds" as const, step: 0.05 },
              { label: "Max fav odds", key: "maxOdds" as const, step: 0.05 },
              { label: "Max doubles (cap)", key: "maxDoubles" as const, step: 1 },
              { label: "Min market liquidity (£)", key: "minLiquidity" as const, step: 500 },
            ].map(f => (
              <label key={f.key} className="text-xs space-y-1">
                <span className="text-muted-foreground">{f.label}</span>
                <input
                  type="number"
                  step={f.step}
                  value={draft[f.key]}
                  onChange={e => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm tabular-nums"
                />
              </label>
            ))}
            <div className="md:col-span-2 space-y-2">
              <span className="text-xs text-muted-foreground">Sports to scan</span>
              <div className="grid grid-cols-2 gap-2">
                {SPORT_OPTIONS.map(s => {
                  const checked = draft.eventTypeIds.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer text-sm ${
                        checked ? "border-emerald-500/40 bg-emerald-500/5 text-foreground" : "border-border/60 text-muted-foreground"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSport(s.id)}
                        className="accent-emerald-500"
                      />
                      {s.label}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          {saveError && (
            <div className="text-xs text-red-400 inline-flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" />{saveError}</div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={saveConfigMutation.isPending}
              onClick={() => saveConfigMutation.mutate(draft)}
              className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-sm font-medium"
            >
              {saveConfigMutation.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Bet history + log feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Bet history</h2>
            {races && (
              <span className="text-xs text-muted-foreground">
                {won} won · {lost} lost · {pending} pending
              </span>
            )}
          </div>

          {racesLoading && (
            <div className="text-sm text-muted-foreground py-12 text-center">Loading bets…</div>
          )}

          {!racesLoading && races?.length === 0 && (
            <div className="rounded-xl border border-dashed border-border/60 py-16 text-center text-muted-foreground text-sm">
              <CircleOff className="w-8 h-8 mx-auto mb-3 opacity-20" />
              No bets yet — start the bot to begin scanning
            </div>
          )}

          <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
            {races?.map(r => {
              const pnl = r.netProfit ?? 0;
              const isWin = r.settled && pnl > 0;
              const isLoss = r.settled && pnl <= 0;
              return (
                <div
                  key={`${r.marketId}-${r.placedAt}`}
                  className={`rounded-xl border ${
                    isWin  ? "border-emerald-500/30 bg-emerald-500/5" :
                    isLoss ? "border-red-500/20 bg-red-500/3" :
                    "border-border/60 bg-card/50"
                  }`}
                >
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
                          : <Clock className="w-4 h-4 text-muted-foreground" />}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-semibold text-sm text-foreground truncate">{r.eventName}</span>
                        <span className="text-[11px] text-muted-foreground truncate">· {r.marketName}</span>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
                          <ArrowUpCircle className="w-3 h-3 text-emerald-400" />
                          BACK {r.selectionName}
                        </span>
                        <span>·</span>
                        <span>trigger {r.triggerOdds.toFixed(2)}</span>
                        {r.matchedOdds != null && <><span>·</span><span>settled {r.matchedOdds.toFixed(2)}</span></>}
                        <span>·</span>
                        <span>£{r.stake.toFixed(2)} stake</span>
                        <span>·</span>
                        <span>{fmtTime(r.placedAt)} {fmtDate(r.placedAt)}</span>
                      </div>
                    </div>

                    <div className="text-right flex-shrink-0">
                      {r.settled ? (
                        <div className={`text-base font-bold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {pnl >= 0 ? "+" : "-"}£{Math.abs(pnl).toFixed(2)}
                        </div>
                      ) : (
                        <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30">Pending</Badge>
                      )}
                      {r.settled && (
                        <div className="text-[10px] text-muted-foreground">{r.status === "VOID" ? "void" : pnl >= 0 ? "profit" : "loss"}</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Log feed */}
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">Activity Log</h2>
          <div className="rounded-xl border border-border/60 bg-card/50 overflow-hidden">
            {logs.length === 0 ? (
              <div className="py-10 text-center text-xs text-muted-foreground">No activity yet</div>
            ) : (
              <div className="divide-y divide-border/40 max-h-[520px] overflow-y-auto">
                {logs.map(log => (
                  <div key={log.id} className="px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      {log.level === "error"
                        ? <span className="text-[10px] text-red-400 font-bold uppercase flex-shrink-0 mt-0.5">ERR</span>
                        : log.level === "warn"
                          ? <span className="text-[10px] text-amber-400 font-bold uppercase flex-shrink-0 mt-0.5">WARN</span>
                          : <CheckCircle2 className="w-3 h-3 text-blue-400/60 flex-shrink-0 mt-0.5" />}
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
            <p className="font-semibold text-foreground/70 inline-flex items-center gap-2">
              <Trophy className="w-3.5 h-3.5" /> How it works
            </p>
            <p>
              Places one BACK bet at a time on the favourite when its price sits inside the configured range,
              across the selected sports. On a loss, the next stake doubles. On a win (or void), the stake resets
              to the start. After the configured maximum doubles, the series also resets — capping worst-case exposure.
            </p>
            <p className="text-[10px] mt-2 italic">Paper bets settle at BSP where available, otherwise at the trigger price.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
