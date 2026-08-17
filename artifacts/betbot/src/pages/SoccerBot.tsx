import React, { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Target, Power, PowerOff, ShieldAlert, Loader2, AlertCircle,
  TrendingUp, Clock, Settings2, X, CircleOff, CheckCircle2
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, ReferenceLine, Cell
} from "recharts";
import {
  useGetSoccerConfig,
  useUpdateSoccerConfig,
  useStartSoccerBot,
  useStopSoccerBot,
  useGetSoccerStatus,
  useGetSoccerCandidates,
  useListSoccerTrades,
  useGetSoccerSummary,
  useGetSoccerLogs,
  getGetSoccerConfigQueryKey,
  getGetSoccerStatusQueryKey,
  getGetSoccerCandidatesQueryKey,
  getListSoccerTradesQueryKey,
  getGetSoccerSummaryQueryKey,
  getGetSoccerLogsQueryKey,
} from "@workspace/api-client-react";

const inputClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function ConfigModal({ config, isOpen, onClose, onSave, isSaving }: any) {
  const [formData, setFormData] = useState<any>(null);

  useEffect(() => {
    if (isOpen && config) {
      setFormData(config);
    }
  }, [config, isOpen]);

  if (!isOpen || !formData) return null;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev: any) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : Number(value)
    }));
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border shadow-lg rounded-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-muted-foreground" />
            Strategy Configuration
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-4 overflow-y-auto space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Stake (£)</label>
              <input type="number" name="stake" value={formData.stake} onChange={handleChange} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Daily Stop Loss (£)</label>
              <input type="number" name="dailyStopLoss" value={formData.dailyStopLoss} onChange={handleChange} className={inputClass} />
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Entry Minute (e.g. 85)</label>
              <input type="number" name="entryMinute" value={formData.entryMinute} onChange={handleChange} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Min Goal Gap</label>
              <input type="number" name="minGoalGap" value={formData.minGoalGap} onChange={handleChange} className={inputClass} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Min Odds</label>
              <input type="number" step="0.01" name="minOdds" value={formData.minOdds} onChange={handleChange} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Max Odds</label>
              <input type="number" step="0.01" name="maxOdds" value={formData.maxOdds} onChange={handleChange} className={inputClass} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Profit Target (%)</label>
              <input type="number" name="profitTargetPct" value={formData.profitTargetPct} onChange={handleChange} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Max Concurrent Trades</label>
              <input type="number" name="maxConcurrent" value={formData.maxConcurrent} onChange={handleChange} className={inputClass} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Min Liquidity (£)</label>
              <input type="number" name="minLiquidity" value={formData.minLiquidity} onChange={handleChange} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Check Interval (s)</label>
              <input type="number" name="checkIntervalSeconds" value={formData.checkIntervalSeconds} onChange={handleChange} className={inputClass} />
            </div>
          </div>
          
          <div className="space-y-3 pt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" name="preferBufferLine" checked={formData.preferBufferLine} onChange={handleChange} className="h-4 w-4 rounded border-border bg-transparent text-primary" />
              <span>Prefer Buffer Line (Under X.5 + 1)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" name="paperMode" checked={formData.paperMode} onChange={handleChange} className="h-4 w-4 rounded border-border bg-transparent text-primary" />
              <span>Paper Trading Mode</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" name="blockReEntryAfterProfit" checked={formData.blockReEntryAfterProfit ?? true} onChange={handleChange} className="h-4 w-4 rounded border-border bg-transparent text-primary" />
              <span>Block re-entry after profit taken on same game today</span>
            </label>
          </div>
        </div>

        <div className="p-4 border-t border-border flex justify-end gap-2 bg-muted/20">
          <button onClick={onClose} disabled={isSaving} className="px-4 py-2 rounded-md hover:bg-muted text-sm font-medium transition-colors">
            Cancel
          </button>
          <button onClick={() => onSave(formData)} disabled={isSaving} className="px-4 py-2 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium transition-colors flex items-center gap-2">
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SoccerBot() {
  const qc = useQueryClient();
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: status } = useGetSoccerStatus({ query: { queryKey: getGetSoccerStatusQueryKey(), refetchInterval: 5000 } });
  const isRunning = status?.isRunning ?? false;

  const { data: config } = useGetSoccerConfig();
  
  const { data: candidates, isLoading: candidatesLoading } = useGetSoccerCandidates({ query: { queryKey: getGetSoccerCandidatesQueryKey(), refetchInterval: isRunning ? 5000 : 30000 } });
  
  const { data: trades, isLoading: tradesLoading } = useListSoccerTrades({ limit: 50 }, { query: { queryKey: getListSoccerTradesQueryKey({ limit: 50 }), refetchInterval: isRunning ? 5000 : 30000 } });
  
  const { data: summary } = useGetSoccerSummary({ query: { queryKey: getGetSoccerSummaryQueryKey(), refetchInterval: 15000 } });
  
  const { data: logs } = useGetSoccerLogs({ limit: 50 }, { query: { queryKey: getGetSoccerLogsQueryKey({ limit: 50 }), refetchInterval: 5000 } });

  const updateConfig = useUpdateSoccerConfig();
  const startBot = useStartSoccerBot();
  const stopBot = useStopSoccerBot();

  const handleSaveConfig = (newConfig: any) => {
    updateConfig.mutate({ data: newConfig }, {
      onSuccess: () => {
        setIsConfigOpen(false);
        qc.invalidateQueries({ queryKey: getGetSoccerConfigQueryKey() });
      }
    });
  };

  const handleStart = () => {
    setActionError(null);
    startBot.mutate(undefined as any, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetSoccerStatusQueryKey() }),
      onError: (err: any) => setActionError(err?.message || "Failed to start")
    });
  };

  const handleStop = () => {
    setActionError(null);
    stopBot.mutate(undefined as any, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetSoccerStatusQueryKey() }),
      onError: (err: any) => setActionError(err?.message || "Failed to stop")
    });
  };

  const won = summary?.settledWon ?? 0;
  const lost = summary?.settledLost ?? 0;
  const totalPnl = summary?.totalPnl ?? 0;
  const todayPnl = status?.todayPnl ?? 0;

  return (
    <div className="space-y-6">
      <ConfigModal 
        config={config} 
        isOpen={isConfigOpen} 
        onClose={() => setIsConfigOpen(false)} 
        onSave={handleSaveConfig} 
        isSaving={updateConfig.isPending} 
      />

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Target className="w-6 h-6 text-blue-400" />
            No More Goals Sniper
            {status?.paperMode && (
               <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-xs">Paper Mode</Badge>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Watches dead games (≥85', 2+ gap) · Backs Under X.5 · Trades out at +15%
          </p>
          {config && (
            <p className="text-xs text-muted-foreground mt-1">
              Stake <span className="font-semibold text-foreground">£{config.stake}</span> ·
              Loss stop {Number(config.dailyStopLoss) > 0
                ? <span className="font-semibold text-red-400">−£{config.dailyStopLoss}</span>
                : <span className="font-semibold text-muted-foreground">off</span>} ·
              Target <span className="font-semibold text-emerald-400">+{config.profitTargetPct}%</span>
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${
                status?.dailyStopHit ? "bg-red-400 animate-pulse" :
                isRunning ? "bg-emerald-400 animate-pulse" :
                "bg-muted-foreground/40"}`}
              />
              {status?.dailyStopHit
                ? <span className="text-red-400">Paused — daily stop hit</span>
                : isRunning
                ? <span className="text-emerald-400">Running{status?.startedAt ? ` since ${new Date(status.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ""}</span>
                : <span className="text-muted-foreground">Stopped</span>}
            </div>
            
            <button onClick={() => setIsConfigOpen(true)} className="p-2 rounded-lg bg-secondary hover:bg-secondary/80 text-foreground transition-colors" title="Settings">
              <Settings2 className="w-4 h-4" />
            </button>

            {isRunning ? (
              <button type="button" disabled={stopBot.isPending} onClick={handleStop}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 text-sm font-medium transition-colors">
                {stopBot.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PowerOff className="w-4 h-4" />}
                Stop Bot
              </button>
            ) : (
              <button type="button" disabled={startBot.isPending} onClick={handleStart}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-sm font-medium transition-colors">
                {startBot.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Power className="w-4 h-4" />}
                Start Bot
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

      {status?.dailyStopHit && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-red-300">
              Daily stop loss reached
            </div>
            <div className="text-xs text-red-200/80 mt-1">
              Bot has paused taking new entries. Already open trades will continue to be managed.
            </div>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Today's P&L", value: `${todayPnl >= 0 ? "+" : ""}£${todayPnl.toFixed(2)}`, sub: `${status?.todayTrades ?? 0} trades`, color: todayPnl > 0 ? "text-emerald-400" : todayPnl < 0 ? "text-red-400" : "text-foreground" },
          { label: "All-time P&L", value: `${totalPnl >= 0 ? "+" : ""}£${totalPnl.toFixed(2)}`, sub: `${summary?.totalTrades ?? 0} trades`, color: totalPnl > 0 ? "text-emerald-400" : totalPnl < 0 ? "text-red-400" : "text-foreground" },
          { label: "Win Rate", value: `${summary?.winRatePct ?? 0}%`, sub: `${won} won · ${lost} lost`, color: "text-foreground" },
          { label: "Open Trades", value: String(status?.openTrades ?? 0), sub: `${status?.watchedGames ?? 0} games watched`, color: "text-blue-400" },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-border/60 bg-card/40 px-5 py-4 flex flex-col justify-center">
             <div className="text-xs text-muted-foreground mb-1">{s.label}</div>
             <div className={`text-2xl font-bold tabular-nums ${s.color}`}>{s.value}</div>
             <div className="text-xs text-muted-foreground mt-0.5">{s.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Watchlist & Trades */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Watchlist */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                <Target className="w-4 h-4" />
                Live Watchlist ({candidates?.length ?? 0})
              </h2>
            </div>
            
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
              {candidatesLoading && <div className="text-sm text-muted-foreground py-4 text-center">Scanning live games...</div>}
              {!candidatesLoading && (!candidates || candidates.length === 0) && (
                <div className="rounded-xl border border-dashed border-border/60 py-8 text-center text-muted-foreground text-sm flex flex-col items-center">
                  <CircleOff className="w-6 h-6 mb-2 opacity-20" />
                  No live games matching criteria right now.
                  {isRunning && <span className="text-xs mt-1">Bot is watching {status?.watchedGames ?? 0} active games...</span>}
                </div>
              )}
              {candidates?.map(c => {
                const isActionable = c.verdict === "ENTERED" || c.verdict === "OPEN";
                return (
                  <div key={`${c.eventName}-${c.marketId}`} className={`p-3 rounded-lg border transition-colors ${
                    isActionable ? "border-emerald-500/30 bg-emerald-500/5" :
                    c.verdict === "WATCHING" ? "border-amber-500/20 bg-amber-500/5" :
                    "border-border/50 bg-card/40 opacity-80"
                  }`}>
                    <div className="flex gap-4 items-center">
                      <div className={`w-10 flex-shrink-0 text-center rounded py-1 font-bold ${isActionable ? 'bg-emerald-500/20 text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                        {c.minute}'
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm truncate">{c.eventName}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex gap-2">
                           <span className="font-medium text-foreground">{c.score}</span>
                           <span>·</span>
                           <span>Gap: {c.goalGap ?? '?'}</span>
                           <span>·</span>
                           <span>Liq: £{c.liquidity ?? 0}</span>
                        </div>
                        {c.verdict === "SKIPPED" && c.reason && (
                          <div className="text-[11px] text-amber-400/70 mt-1 leading-snug" title={c.reason}>
                            {c.reason}
                          </div>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-xs font-mono">{c.tightLine ? `U${c.tightLine}` : 'Line?'} @ <span className="font-bold text-foreground">{c.tightOdds?.toFixed(2) ?? '-'}</span></div>
                        <div className={`text-[10px] mt-1 px-1.5 py-0.5 rounded inline-block font-semibold tracking-wide ${
                          c.verdict === "ENTERED" ? "bg-emerald-500/20 text-emerald-400" :
                          c.verdict === "WATCHING" ? "bg-amber-500/20 text-amber-400" :
                          "bg-muted text-muted-foreground"
                        }`}>{c.verdict}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* Trade History */}
          <section className="space-y-3">
             <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                Recent Trades
              </h2>
            </div>
            
            <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
              {tradesLoading && <div className="text-sm text-muted-foreground py-4 text-center">Loading trades...</div>}
              {!tradesLoading && (!trades || trades.length === 0) && (
                <div className="rounded-xl border border-dashed border-border/60 py-8 text-center text-muted-foreground text-sm flex flex-col items-center">
                  <Clock className="w-6 h-6 mb-2 opacity-20" />
                  No trades placed yet.
                  {isRunning && <span className="text-xs mt-1">Awaiting target entry conditions.</span>}
                </div>
              )}
              {trades?.map(t => {
                const isWin = t.profit && t.profit > 0;
                const isLoss = t.profit && t.profit <= 0;
                return (
                  <div key={t.id} className={`p-3 rounded-lg border transition-colors ${
                    t.status === "OPEN" ? "border-blue-500/30 bg-blue-500/5" :
                    isWin ? "border-emerald-500/30 bg-emerald-500/5" :
                    isLoss ? "border-red-500/20 bg-red-500/5" :
                    "border-border/50 bg-card/40"
                  }`}>
                     <div className="flex justify-between items-start mb-2">
                        <div>
                           <div className="font-semibold text-sm">{t.eventName}</div>
                           <div className="text-xs text-muted-foreground mt-0.5">
                             {t.selectionName} · Entry {t.entryMinute}' @ {t.entryScore}
                           </div>
                        </div>
                        <Badge className={`text-[10px] uppercase font-bold tracking-wider ${
                          t.status === "OPEN" ? "bg-blue-500/15 text-blue-400 border-blue-500/30" :
                          t.status === "TRADED_OUT" || t.status === "SETTLED_WON" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" :
                          t.status === "EXITED_AFTER_GOAL" || t.status === "SETTLED_LOST" ? "bg-red-500/15 text-red-400 border-red-500/30" :
                          "bg-muted text-muted-foreground border-border"
                        }`}>{t.status.replace(/_/g, ' ')}</Badge>
                     </div>
                     <div className="flex justify-between items-end">
                       <div className="text-xs text-muted-foreground space-y-0.5">
                          <div>Stake: £{t.stake} <span className="font-medium text-foreground">@ {t.entryOdds.toFixed(2)}</span></div>
                          {(t.exitOdds || t.exitReason) && (
                            <div>Exit: {t.exitOdds ? <span className="font-medium text-foreground">@ {t.exitOdds.toFixed(2)}</span> : ''} {t.exitReason ? `(${t.exitReason})` : ''}</div>
                          )}
                       </div>
                       <div className="text-right">
                         <div className={`text-base font-bold tabular-nums ${isWin ? 'text-emerald-400' : isLoss ? 'text-red-400' : 'text-muted-foreground'}`}>
                           {t.profit != null ? `${isWin ? '+' : ''}£${t.profit.toFixed(2)}` : '—'}
                         </div>
                       </div>
                     </div>
                  </div>
                )
              })}
            </div>
          </section>

        </div>

        {/* Right Column: Chart & Logs */}
        <div className="space-y-6">
          
          <section className="space-y-3">
             <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Daily Performance</h2>
             <div className="rounded-xl border border-border/60 bg-card/40 p-4 h-[220px]">
                {!summary?.dailyPnl || summary.dailyPnl.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No P&L data yet</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={summary.dailyPnl} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={10} tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} axisLine={false} tickLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickFormatter={(v) => `£${v}`} axisLine={false} tickLine={false} />
                      <RechartsTooltip 
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
                        itemStyle={{ color: 'hsl(var(--foreground))', fontWeight: 'bold' }}
                        formatter={(val: number) => [`£${val.toFixed(2)}`, 'P&L']}
                        labelFormatter={(label) => new Date(label).toLocaleDateString()}
                        cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                      />
                      <ReferenceLine y={0} stroke="hsl(var(--border))" />
                      <Bar dataKey="pnl" radius={[2, 2, 0, 0]} maxBarSize={40}>
                        {summary.dailyPnl.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.pnl >= 0 ? 'hsl(var(--chart-1))' : 'hsl(var(--chart-4))'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
             </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Activity Log</h2>
            <div className="rounded-xl border border-border/60 bg-card/40 overflow-hidden">
              {!logs || logs.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">No activity yet</div>
              ) : (
                <div className="divide-y divide-border/40 max-h-[400px] overflow-y-auto">
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
          </section>

        </div>
      </div>
    </div>
  );
}
