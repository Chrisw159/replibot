import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  TrendingUp, TrendingDown, Trophy, Clock,
  CircleOff, CheckCircle2,
  ArrowDownCircle, ArrowUpCircle,
  Play, Square, Loader2, AlertCircle, Settings as SettingsIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface PaperConfig {
  stake: number;
  minOdds: number;
  maxOdds: number;
  minLiquidity: number;
  countryCodes: string[];
}

interface PaperStatus {
  strategyKey: "back_fav" | "lay_short_fav";
  strategyName: string;
  betSide: "BACK" | "LAY";
  isRunning: boolean;
  startedAt: string | null;
  paperTradingMode: boolean;
  paperConfig: PaperConfig;
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

interface PaperRace {
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

interface PaperLog {
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

interface Props {
  slug: "back-fav" | "lay-short-fav";
  title: string;
  subtitle: string;
  description: string;
}

export default function PaperStrategy({ slug, title, subtitle, description }: Props) {
  const qc = useQueryClient();
  const [logs, setLogs] = useState<PaperLog[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [draft, setDraft] = useState<PaperConfig | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const statusKey = ["paper-status", slug];

  const { data: stats } = useQuery<PaperStatus>({
    queryKey: statusKey,
    queryFn: () => apiFetch(`/paper/${slug}/status`),
    refetchInterval: 5000,
  });

  const { data: races, isLoading: racesLoading } = useQuery<PaperRace[]>({
    queryKey: ["paper-races", slug],
    queryFn: () => apiFetch(`/paper/${slug}/races`),
    refetchInterval: 10000,
  });

  const startMutation = useMutation({
    mutationFn: () => apiFetch<PaperStatus>(`/paper/${slug}/start`, { method: "POST" }),
    onSuccess: () => { setActionError(null); qc.invalidateQueries({ queryKey: statusKey }); },
    onError: (e: Error) => setActionError(e.message || "Failed to start bot"),
  });
  const stopMutation = useMutation({
    mutationFn: () => apiFetch<PaperStatus>(`/paper/${slug}/stop`, { method: "POST" }),
    onSuccess: () => { setActionError(null); qc.invalidateQueries({ queryKey: statusKey }); },
    onError: (e: Error) => setActionError(e.message || "Failed to stop bot"),
  });
  const saveConfigMutation = useMutation({
    mutationFn: (cfg: PaperConfig) =>
      apiFetch(`/paper/${slug}/config`, { method: "PATCH", body: JSON.stringify(cfg) }),
    onSuccess: () => {
      setSaveError(null);
      setConfigOpen(false);
      qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: (e: Error) => setSaveError(e.message || "Failed to save config"),
  });

  const isRunning   = stats?.isRunning ?? false;
  const actionBusy  = startMutation.isPending || stopMutation.isPending;

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/paper/${slug}/logs?limit=50`);
      if (res.ok) setLogs(await res.json());
    } catch { /* silent */ }
  }, [slug]);

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
    setDraft({ ...stats.paperConfig });
    setSaveError(null);
    setConfigOpen(true);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            {title}
            <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-xs">Paper only</Badge>
            {stats?.betSide && (
              <Badge className={`text-xs ${
                stats.betSide === "BACK"
                  ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                  : "bg-red-500/15 text-red-400 border-red-500/30"
              }`}>
                {stats.betSide}
              </Badge>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{subtitle}</p>
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

      {/* Stats */}
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
              { label: "Stake (£)", key: "stake" as const, step: 1 },
              { label: "Min fav odds", key: "minOdds" as const, step: 0.05 },
              { label: "Max fav odds", key: "maxOdds" as const, step: 0.05 },
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
            <label className="text-xs space-y-1 md:col-span-2">
              <span className="text-muted-foreground">Country codes (comma-separated)</span>
              <input
                type="text"
                value={draft.countryCodes.join(", ")}
                onChange={e => setDraft({ ...draft, countryCodes: e.target.value.split(",").map(s => s.trim().toUpperCase()).filter(Boolean) })}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
              />
            </label>
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

      {/* Race history + log feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Race history
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
              No bets yet — start the bot to begin scanning races
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
                          {r.betType === "LAY"
                            ? <ArrowDownCircle className="w-3 h-3 text-red-400" />
                            : <ArrowUpCircle  className="w-3 h-3 text-emerald-400" />}
                          {r.betType} {r.selectionName}
                        </span>
                        <span>·</span>
                        <span>trigger {r.triggerOdds.toFixed(2)}</span>
                        {r.matchedOdds != null && <><span>·</span><span>BSP {r.matchedOdds.toFixed(2)}</span></>}
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
              <Trophy className="w-3.5 h-3.5" /> Strategy
            </p>
            <p>{description}</p>
            <p className="text-[10px] mt-2 italic">Paper bets settle at BSP (Betfair Starting Price) once the market closes.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
