import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Play, Square, RefreshCw, ChevronRight,
  TrendingUp, TrendingDown, CircleDot,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

interface BookieStatus {
  isRunning: boolean;
  startedAt: string | null;
  paperTradingMode: boolean;
  bookieConfig: {
    totalStakePerRace: number;
    maxRaceNetLoss: number;
    minLiquidity: number;
    countryCodes: string[];
    minRunners: number;
  };
  racesToday: number;
  profitToday: number;
  totalRaces: number;
  totalNetProfit: number;
}

interface BookieRace {
  marketId: string;
  marketName: string;
  eventName: string;
  placedAt: string;
  runners: number;
  netProfit: number;
  settled: boolean;
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

export default function BookieBot() {
  const qc = useQueryClient();

  const { data: status, isLoading } = useQuery<BookieStatus>({
    queryKey: ["bookie-status"],
    queryFn: () => apiFetch("/bookie/status"),
    refetchInterval: 15_000,
  });

  const { data: races } = useQuery<BookieRace[]>({
    queryKey: ["bookie-races"],
    queryFn: () => apiFetch("/bookie/races"),
    refetchInterval: 30_000,
  });

  const startMutation = useMutation({
    mutationFn: () => apiFetch<BookieStatus>("/bookie/start", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookie-status"] }),
  });

  const stopMutation = useMutation({
    mutationFn: () => apiFetch<BookieStatus>("/bookie/stop", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookie-status"] }),
  });

  const paperMutation = useMutation({
    mutationFn: (paperTradingMode: boolean) =>
      apiFetch("/bot/config", { method: "PATCH", body: JSON.stringify({ paperTradingMode }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookie-status"] }),
  });

  const configMutation = useMutation({
    mutationFn: (body: Partial<{
      maxRaceNetLoss: number;
      minLiquidity: number;
      minRunners: number;
    }>) => apiFetch("/bookie/config", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookie-status"] });
      setMaxLossInput(""); setLiqInput(""); setMinRunnersInput("");
    },
  });

  const [maxLossInput, setMaxLossInput]       = useState("");
  const [liqInput, setLiqInput]               = useState("");
  const [minRunnersInput, setMinRunnersInput] = useState("");

  const isRunning = status?.isRunning ?? false;
  const isPaper   = status?.paperTradingMode ?? true;
  const cfg       = status?.bookieConfig;

  const handleSaveConfig = () => {
    const patch: Parameters<typeof configMutation.mutate>[0] = {};
    if (maxLossInput)    patch.maxRaceNetLoss = parseFloat(maxLossInput);
    if (liqInput)        patch.minLiquidity   = parseFloat(liqInput);
    if (minRunnersInput) patch.minRunners     = parseInt(minRunnersInput, 10);
    if (Object.keys(patch).length > 0) configMutation.mutate(patch);
  };

  const nothingChanged = !maxLossInput && !liqInput && !minRunnersInput;

  const profitToday    = status?.profitToday    ?? 0;
  const totalNetProfit = status?.totalNetProfit ?? 0;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bookie Bot</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Mirrors market money — lays each runner in proportion to public betting volume
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries()}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          {isRunning ? (
            <Button
              variant="destructive" size="sm"
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
            >
              <Square className="w-3.5 h-3.5 mr-1.5" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending || isLoading}
            >
              <Play className="w-3.5 h-3.5 mr-1.5" />
              Start
            </Button>
          )}
        </div>
      </div>

      {/* ── Status strip ── */}
      <div className="flex flex-wrap gap-2">
        <Badge
          variant="outline"
          className={isRunning
            ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
            : "text-muted-foreground"}
        >
          <CircleDot className={`w-2.5 h-2.5 mr-1.5 ${isRunning ? "text-emerald-400" : ""}`} />
          {isRunning ? "Running" : "Stopped"}
        </Badge>
        <Badge
          variant="outline"
          className={isPaper
            ? "border-amber-500/40 text-amber-400 bg-amber-500/10"
            : "border-emerald-500/30 text-emerald-400"}
        >
          {isPaper ? "Paper trading" : "Live"}
        </Badge>
        <Badge variant="outline" className="text-muted-foreground">
          GB + IE · WIN markets · 1–4 min before start
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Stats ── */}
        <div className="lg:col-span-2 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Races today",    value: String(status?.racesToday ?? 0) },
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

          {/* ── Race history ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Race History</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {!races || races.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                  No races yet — start the bot to begin
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {races.map(race => {
                    const p = fmtProfit(race.netProfit, race.settled);
                    const t = new Date(race.placedAt);
                    return (
                      <Link key={race.marketId} href={`/bookiebot/race/${race.marketId}`}>
                        <div className="flex items-center gap-3 px-5 py-3 hover:bg-muted/30 transition-colors cursor-pointer">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm truncate">{race.eventName}</div>
                            <div className="text-xs text-muted-foreground">
                              {race.marketName} · {race.runners} runners · {t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <div className={`text-sm font-bold tabular-nums ${p.cls}`}>{p.text}</div>
                            {race.settled
                              ? <div className="text-[10px] text-muted-foreground">Settled</div>
                              : <div className="text-[10px] text-amber-400/70">Pending</div>
                            }
                          </div>
                          <ChevronRight className="w-4 h-4 text-muted-foreground/50 flex-shrink-0" />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Config ── */}
        <div className="space-y-4">
          {/* Paper trading toggle */}
          <Card>
            <CardContent className="pt-4 pb-4 px-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Paper Trading</div>
                  <div className="text-xs text-muted-foreground">No real money placed</div>
                </div>
                <Switch
                  checked={isPaper}
                  onCheckedChange={v => paperMutation.mutate(v)}
                  disabled={paperMutation.isPending}
                />
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
              <div className="rounded-md bg-muted/30 border border-border/40 px-3 py-2.5 text-xs text-muted-foreground space-y-0.5">
                <div className="font-medium text-foreground/70">Stake is auto-calculated</div>
                <div>Each race the bot works out the exact total stake so the worst possible outcome equals your Max Net Loss limit.</div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Max Net Loss Per Race (£)</Label>
                <Input
                  type="number" min={10} max={10000}
                  placeholder={`Current: £${cfg?.maxRaceNetLoss ?? 200}`}
                  value={maxLossInput} onChange={e => setMaxLossInput(e.target.value)}
                  className="h-8 text-sm"
                />
                <p className="text-[10px] text-muted-foreground/70">
                  Race skipped if worst-case outcome exceeds this
                </p>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Min Market Liquidity (£)</Label>
                <Input
                  type="number" min={0}
                  placeholder={`Current: £${cfg?.minLiquidity ?? 8000}`}
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
                onClick={handleSaveConfig}
                disabled={configMutation.isPending || nothingChanged}
                className="w-full h-8 text-xs"
              >
                Save Config
              </Button>

              <div className="text-[10px] text-muted-foreground/60 border-t border-border/40 pt-3 space-y-0.5">
                <div>Countries: GB + IE · Market type: WIN</div>
                <div>Timing: 1–4 min before start</div>
                <div>Odds range: 1.5 – 50</div>
              </div>
            </CardContent>
          </Card>

          {/* How it works */}
          <Card className="bg-muted/20">
            <CardContent className="pt-4 pb-4 px-4 text-xs text-muted-foreground space-y-1.5">
              <div className="font-medium text-muted-foreground/90">How it works</div>
              <div>Checks how much money punters have bet on each runner, then lays each one proportionally to their share of the total market volume.</div>
              <div className="flex items-center gap-1.5 text-emerald-400/80">
                <TrendingUp className="w-3 h-3 flex-shrink-0" />
                Heavily-backed runner wins = maximum loss
              </div>
              <div className="flex items-center gap-1.5 text-blue-400/80">
                <TrendingDown className="w-3 h-3 flex-shrink-0" />
                Lightly-backed runner wins = best result
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
