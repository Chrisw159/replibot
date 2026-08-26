import React, { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Target, Power, PowerOff, Loader2, AlertCircle,
  TrendingUp, Clock, Settings2, X, CircleOff
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
  getGetSoccerConfigQueryKey,
  getGetSoccerStatusQueryKey,
  getGetSoccerCandidatesQueryKey,
  getListSoccerTradesQueryKey,
  getGetSoccerSummaryQueryKey,
} from "@workspace/api-client-react";

const inputClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const BOT_TITLE = "No More Goals Lay Lock";
const BOT_DESCRIPTION = "Rests a same-stake lay at a fixed odds offset, then uses a loss-capped fallback if it has not matched.";

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
            Bot Configuration
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-4 overflow-y-auto space-y-4 text-sm">
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="text-xs font-medium">Automatic stake bands</div>
            <div className="text-[11px] text-muted-foreground mt-1">£50 at entry odds up to 2.00; £100 above 2.00.</div>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Entry Minute (e.g. 80)</label>
              <input type="number" min="80" max="90" name="entryMinute" value={formData.entryMinute} onChange={handleChange} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Min Goal Gap</label>
              <input type="number" name="minGoalGap" value={formData.minGoalGap} onChange={handleChange} className={inputClass} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Tight line minimum odds</label>
              <input type="number" step="0.01" name="minOdds" value={formData.minOdds} onChange={handleChange} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Insured line minimum odds</label>
              <input type="number" step="0.01" name="maxOdds" value={formData.maxOdds} onChange={handleChange} className={inputClass} />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-muted-foreground text-xs">Max Concurrent Trades</label>
            <input type="number" name="maxConcurrent" value={formData.maxConcurrent} onChange={handleChange} className={inputClass} />
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
          
          <div className="space-y-3 pt-2 border-t border-border/60 mt-2">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pt-2">Lay and fallback</div>
            <div className="space-y-1.5">
              <label className="text-muted-foreground text-xs">Lay odds offset</label>
              <input type="number" min="0.01" max="10" step="0.01" name="layOffset" value={formData.layOffset ?? 0.45} onChange={handleChange} className={inputClass} />
              <div className="text-[11px] text-muted-foreground">
                The resting lay target is the entry odds minus {Number(formData.layOffset ?? 0.45).toFixed(2)} (rounded to a valid Betfair tick).
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-muted-foreground text-xs">Fallback retry</label>
                <div className={`${inputClass} flex items-center opacity-70`}>Every 60s for 5 min</div>
              </div>
              <div className="space-y-1.5">
                <label className="text-muted-foreground text-xs">Max fallback loss</label>
                <div className={`${inputClass} flex items-center opacity-70`}>£5 fixed</div>
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <label className="flex items-center gap-2 cursor-not-allowed opacity-70">
              <input type="checkbox" name="paperMode" checked={true} readOnly className="h-4 w-4 rounded border-border bg-transparent text-amber-500" />
              <span>Paper Trading Mode (Forced)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" name="blockReEntryAfterProfit" checked={formData.blockReEntryAfterProfit ?? true} onChange={handleChange} className="h-4 w-4 rounded border-border bg-transparent text-primary" />
              <span>Block repeat entries on the same game</span>
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
  
  const { data: candidates, isLoading: candidatesLoading } = useGetSoccerCandidates(
    { query: { queryKey: getGetSoccerCandidatesQueryKey(), refetchInterval: isRunning ? 5000 : 30000 } },
  );
  
  const tradeParams = { limit: 50 };
  const { data: trades, isLoading: tradesLoading } = useListSoccerTrades(
    tradeParams,
    { query: { queryKey: getListSoccerTradesQueryKey(tradeParams), refetchInterval: isRunning ? 5000 : 30000 } },
  );
  
  const { data: summary } = useGetSoccerSummary(
    { query: { queryKey: getGetSoccerSummaryQueryKey(), refetchInterval: 15000 } },
  );

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
  const breakEven = summary?.settledBreakEven ?? 0;
  const lost = summary?.settledLost ?? 0;
  const totalPnl = summary?.totalPnl ?? 0;
  const todayPnl = summary?.todayPnl ?? 0;

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
            {BOT_DESCRIPTION}
          </p>
          {config && (
            <p className="text-xs text-muted-foreground mt-1">
               Stakes <span className="font-semibold text-foreground">£50 / £100</span> ·
               Lay offset <span className="font-semibold text-emerald-400">
                 {config.layOffset.toFixed(2)}
              </span>
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${
                isRunning ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/40"}`}
              />
              {isRunning
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

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {[
          { label: "Today's P&L", value: `${todayPnl >= 0 ? "+" : ""}£${todayPnl.toFixed(2)}`, sub: `${summary?.todayTrades ?? 0} trades`, color: todayPnl > 0 ? "text-emerald-400" : todayPnl < 0 ? "text-red-400" : "text-foreground" },
          { label: "All-time P&L", value: `${totalPnl >= 0 ? "+" : ""}£${totalPnl.toFixed(2)}`, sub: `${summary?.totalTrades ?? 0} trades`, color: totalPnl > 0 ? "text-emerald-400" : totalPnl < 0 ? "text-red-400" : "text-foreground" },
          { label: "Win", value: `${summary?.winRatePct ?? 0}%`, sub: `${won} trades`, color: "text-emerald-400" },
          { label: "Break Even", value: `${summary?.breakEvenRatePct ?? 0}%`, sub: `${breakEven} trades`, color: "text-amber-400" },
          { label: "Loss", value: `${summary?.lossRatePct ?? 0}%`, sub: `${lost} trades`, color: "text-red-400" },
          { label: "Open Trades", value: String(summary?.openTrades ?? 0), sub: "Lay lock only", color: "text-blue-400" },
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
                {BOT_TITLE} Watchlist ({candidates?.length ?? 0})
              </h2>
            </div>
            
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
              {candidatesLoading && <div className="text-sm text-muted-foreground py-4 text-center">Scanning live games...</div>}
              {!candidatesLoading && (!candidates || candidates.length === 0) && (
                <div className="rounded-xl border border-dashed border-border/60 py-8 text-center text-muted-foreground text-sm flex flex-col items-center">
                  <CircleOff className="w-6 h-6 mb-2 opacity-20" />
                  No live games matching criteria right now.
                  {isRunning && <span className="text-xs mt-1">Scanning for lay-lock entries...</span>}
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
                         <div className="text-xs font-mono">{c.tightLine ? `Tight U${c.tightLine}` : 'Tight?'} @ <span className="font-bold text-foreground">{c.tightOdds?.toFixed(2) ?? '-'}</span></div>
                         {c.bufferLine != null && (
                           <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                             Insured U{c.bufferLine} @ {c.bufferOdds?.toFixed(2) ?? '-'}
                           </div>
                         )}
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
                {BOT_TITLE} Trades
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
                        <div className="flex flex-col items-end gap-1">
                          <Badge className={`text-[10px] uppercase font-bold tracking-wider ${
                            t.status === "OPEN" ? "bg-blue-500/15 text-blue-400 border-blue-500/30" :
                            t.status === "HEDGED" ? "bg-amber-500/15 text-amber-400 border-amber-500/30" :
                             t.status.startsWith("SETTLED_") && Math.round((t.profit ?? 0) * 100) > 0 ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" :
                             t.status.startsWith("SETTLED_") && Math.round((t.profit ?? 0) * 100) === 0 ? "bg-amber-500/15 text-amber-400 border-amber-500/30" :
                             t.status.startsWith("SETTLED_") && Math.round((t.profit ?? 0) * 100) < 0 ? "bg-red-500/15 text-red-400 border-red-500/30" :
                            "bg-muted text-muted-foreground border-border"
                          }`}>{
                            t.status === "HEDGED"
                              ? "LAY MATCHED"
                              : t.status.startsWith("SETTLED_") && Math.round((t.profit ?? 0) * 100) === 0
                                ? "BREAK EVEN"
                                : t.status.replace(/_/g, ' ')
                          }</Badge>
                        </div>
                     </div>
                     <div className="flex justify-between items-end">
                       <div className="text-xs text-muted-foreground space-y-0.5">
                          <div>Stake: £{t.stake} <span className="font-medium text-foreground">@ {t.entryOdds.toFixed(2)}</span></div>
                            {t.targetLayPrice != null && (
                             <div>
                                Original target <span className="font-medium text-foreground">@ {t.targetLayPrice.toFixed(2)}</span>
                               {" · "}£{(t.layMatchedStake ?? 0).toFixed(2)} matched
                               {(t.layMatchedStake ?? 0) > 0 && (t.layMatchedPriceStake ?? 0) > 0
                                 ? ` @ ${((t.layMatchedPriceStake ?? 0) / (t.layMatchedStake ?? 1)).toFixed(2)} average`
                                 : ""}
                             </div>
                          )}
                           {t.fallbackAttemptedAt && (
                             <div className="text-amber-400">
                                Fallback #{t.fallbackAttemptCount ?? 0} {t.fallbackDecision?.replace(/_/g, " ").toLowerCase()} at {new Date(t.fallbackAttemptedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                               {t.fallbackPrice != null ? ` @ ${t.fallbackPrice.toFixed(2)}` : ""}
                                {t.fallbackProjectedPnl != null ? ` · projected ${t.fallbackProjectedPnl >= 0 ? "+" : ""}£${t.fallbackProjectedPnl.toFixed(2)}` : ""}
                               {" · "}£{(t.layMatchedStake ?? 0).toFixed(2)} total matched
                             </div>
                           )}
                            {!t.fallbackAttemptedAt && t.fallbackNextCheckAt && t.status === "OPEN" && (
                              <div>Fallback eligible after {new Date(t.fallbackNextCheckAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
                            )}
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

        {/* Right Column: daily chart */}
        <div className="space-y-6">
          
          <section className="space-y-3">
             <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{BOT_TITLE} Daily P&L</h2>
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

        </div>
      </div>
    </div>
  );
}
