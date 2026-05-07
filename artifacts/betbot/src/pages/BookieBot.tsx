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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface BookieStatus {
  isRunning: boolean;
  startedAt: string | null;
  paperTradingMode: boolean;
  bookieConfig: {
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

interface BookieRace {
  marketId: string;
  marketName: string;
  eventName: string;
  placedAt: string;
  runners: number;
  netProfit: number;
  settled: boolean;
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

function StatCards({ values }: {
  values: { label: string; value: string; cls?: string }[];
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {values.map(({ label, value, cls }) => (
        <Card key={label} className="bg-card/60">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
            <div className={`text-2xl font-bold tabular-nums mt-0.5 ${cls ?? ""}`}>{value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function BookieBotTab() {
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
    mutationFn: (v: boolean) => apiFetch("/bot/config", { method: "PATCH", body: JSON.stringify({ paperTradingMode: v }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookie-status"] }),
  });
  const configMutation = useMutation({
    mutationFn: (body: Partial<{ maxRaceNetLoss: number; minLiquidity: number; minRunners: number }>) =>
      apiFetch("/bookie/config", { method: "PATCH", body: JSON.stringify(body) }),
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
  const nothingChanged = !maxLossInput && !liqInput && !minRunnersInput;

  const profitToday    = status?.profitToday    ?? 0;
  const totalNetProfit = status?.totalNetProfit ?? 0;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
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
        </div>
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

      <StatCards values={[
        { label: "Races today",  value: String(status?.racesToday ?? 0) },
        { label: "Today P&L",    value: profitToday >= 0 ? `+£${profitToday.toFixed(2)}` : `-£${Math.abs(profitToday).toFixed(2)}`,
          cls: profitToday > 0 ? "text-emerald-400" : profitToday < 0 ? "text-red-400" : "" },
        { label: "Total races",  value: String(status?.totalRaces ?? 0) },
        { label: "All-time P&L", value: totalNetProfit >= 0 ? `+£${totalNetProfit.toFixed(2)}` : `-£${Math.abs(totalNetProfit).toFixed(2)}`,
          cls: totalNetProfit > 0 ? "text-emerald-400" : totalNetProfit < 0 ? "text-red-400" : "" },
      ]} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Race history */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Race History</CardTitle></CardHeader>
            <CardContent className="p-0">
              {!races || races.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">No races yet — start the bot to begin</div>
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
                            {race.settled ? <div className="text-[10px] text-muted-foreground">Settled</div>
                              : <div className="text-[10px] text-amber-400/70">Pending</div>}
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

        {/* Config */}
        <div className="space-y-4">
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

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Configuration</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Max Net Loss Per Race (£)</Label>
                <Input type="number" min={10} max={10000} placeholder={`Current: £${cfg?.maxRaceNetLoss ?? 200}`}
                  value={maxLossInput} onChange={e => setMaxLossInput(e.target.value)} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Min Market Liquidity (£)</Label>
                <Input type="number" min={0} placeholder={`Current: £${cfg?.minLiquidity ?? 8000}`}
                  value={liqInput} onChange={e => setLiqInput(e.target.value)} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Min Runners</Label>
                <Input type="number" min={2} max={20} placeholder={`Current: ${cfg?.minRunners ?? 4}`}
                  value={minRunnersInput} onChange={e => setMinRunnersInput(e.target.value)} className="h-8 text-sm" />
              </div>
              <Button onClick={() => {
                const patch: Record<string, number> = {};
                if (maxLossInput)    patch.maxRaceNetLoss = parseFloat(maxLossInput);
                if (liqInput)        patch.minLiquidity   = parseFloat(liqInput);
                if (minRunnersInput) patch.minRunners     = parseInt(minRunnersInput, 10);
                if (Object.keys(patch).length > 0) configMutation.mutate(patch);
              }} disabled={configMutation.isPending || nothingChanged} className="w-full h-8 text-xs">
                Save Config
              </Button>
              <div className="text-[10px] text-muted-foreground/60 border-t border-border/40 pt-3 space-y-0.5">
                <div>Countries: GB + IE · Market type: WIN</div>
                <div>Timing: 1–4 min before start · Odds range: 1.5–300</div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-muted/20">
            <CardContent className="pt-4 pb-4 px-4 text-xs text-muted-foreground space-y-1.5">
              <div className="font-medium text-muted-foreground/90">How it works</div>
              <div>Lays every runner proportionally to their share of the total market volume.</div>
              <div className="flex items-center gap-1.5 text-emerald-400/80">
                <TrendingUp className="w-3 h-3 flex-shrink-0" />Heavily-backed runner wins = max loss
              </div>
              <div className="flex items-center gap-1.5 text-blue-400/80">
                <TrendingDown className="w-3 h-3 flex-shrink-0" />Lightly-backed runner wins = best result
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function DutchBotTab() {
  const qc = useQueryClient();

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

  const startMutation = useMutation({
    mutationFn: () => apiFetch<DutchStatus>("/dutch/start", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dutch-status"] }),
  });
  const stopMutation = useMutation({
    mutationFn: () => apiFetch<DutchStatus>("/dutch/stop", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dutch-status"] }),
  });
  const paperMutation = useMutation({
    mutationFn: (v: boolean) => apiFetch("/bot/config", { method: "PATCH", body: JSON.stringify({ paperTradingMode: v }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dutch-status"] }),
  });
  const configMutation = useMutation({
    mutationFn: (body: Partial<{ totalOutlay: number; topPct: number; minFavPrice: number; minLiquidity: number; minRunners: number }>) =>
      apiFetch("/dutch/config", { method: "PATCH", body: JSON.stringify(body) }),
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

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
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
            Top {cfg ? Math.round(cfg.topPct * 100) : 40}% · fav ≥ {cfg?.minFavPrice ?? 4.0} · £{cfg?.totalOutlay ?? 50}/race
          </Badge>
        </div>
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

      <StatCards values={[
        { label: "Races today",  value: String(status?.racesToday ?? 0) },
        { label: "Today P&L",    value: profitToday >= 0 ? `+£${profitToday.toFixed(2)}` : `-£${Math.abs(profitToday).toFixed(2)}`,
          cls: profitToday > 0 ? "text-emerald-400" : profitToday < 0 ? "text-red-400" : "" },
        { label: "Total races",  value: String(status?.totalRaces ?? 0) },
        { label: "All-time P&L", value: totalNetProfit >= 0 ? `+£${totalNetProfit.toFixed(2)}` : `-£${Math.abs(totalNetProfit).toFixed(2)}`,
          cls: totalNetProfit > 0 ? "text-emerald-400" : totalNetProfit < 0 ? "text-red-400" : "" },
      ]} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Race history */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Race History</CardTitle></CardHeader>
            <CardContent className="p-0">
              {!races || races.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">No races yet — start the bot to begin</div>
              ) : (
                <div className="divide-y divide-border/50">
                  {races.map(race => {
                    const p = fmtProfit(race.netProfit, race.settled);
                    const t = new Date(race.placedAt);
                    return (
                      <div key={race.marketId} className="flex items-center gap-3 px-5 py-3">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{race.eventName}</div>
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
                          {race.settled ? <div className="text-[10px] text-muted-foreground">Settled</div>
                            : <div className="text-[10px] text-amber-400/70">Pending</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Config */}
        <div className="space-y-4">
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

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Configuration</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-md bg-muted/30 border border-border/40 px-3 py-2.5 text-xs text-muted-foreground space-y-0.5">
                <div className="font-medium text-foreground/70">Dutching strategy</div>
                <div>Top 40% by market weight, stakes weighted so every backed horse returns the same profit.</div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Total Outlay Per Race (£)</Label>
                <Input type="number" min={2} max={10000} placeholder={`Current: £${cfg?.totalOutlay ?? 50}`}
                  value={outlayInput} onChange={e => setOutlayInput(e.target.value)} className="h-8 text-sm" />
                <p className="text-[10px] text-muted-foreground/70">Split across all backed runners (dutched)</p>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Top % of Field</Label>
                <Input type="number" min={10} max={100} step={5}
                  placeholder={`Current: ${cfg ? Math.round(cfg.topPct * 100) : 40}%`}
                  value={topPctInput} onChange={e => setTopPctInput(e.target.value)} className="h-8 text-sm" />
                <p className="text-[10px] text-muted-foreground/70">Enter as percentage, e.g. 40</p>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Min Favourite Price</Label>
                <Input type="number" min={1.5} max={20} step={0.5}
                  placeholder={`Current: ${cfg?.minFavPrice ?? 4.0} (${(cfg?.minFavPrice ?? 4) - 1}/1)`}
                  value={favInput} onChange={e => setFavInput(e.target.value)} className="h-8 text-sm" />
                <p className="text-[10px] text-muted-foreground/70">Skip races where favourite is shorter than this</p>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Min Market Liquidity (£)</Label>
                <Input type="number" min={0} placeholder={`Current: £${cfg?.minLiquidity ?? 3000}`}
                  value={liqInput} onChange={e => setLiqInput(e.target.value)} className="h-8 text-sm" />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Min Runners</Label>
                <Input type="number" min={2} max={20} placeholder={`Current: ${cfg?.minRunners ?? 4}`}
                  value={minRunnersInput} onChange={e => setMinRunnersInput(e.target.value)} className="h-8 text-sm" />
              </div>

              <Button onClick={() => {
                const patch: Record<string, number> = {};
                if (outlayInput)     patch.totalOutlay  = parseFloat(outlayInput);
                if (topPctInput)     patch.topPct       = parseFloat(topPctInput) / 100;
                if (favInput)        patch.minFavPrice  = parseFloat(favInput);
                if (liqInput)        patch.minLiquidity = parseFloat(liqInput);
                if (minRunnersInput) patch.minRunners   = parseInt(minRunnersInput, 10);
                if (Object.keys(patch).length > 0) configMutation.mutate(patch);
              }} disabled={configMutation.isPending || nothingChanged} className="w-full h-8 text-xs">
                Save Config
              </Button>

              <div className="text-[10px] text-muted-foreground/60 border-t border-border/40 pt-3 space-y-0.5">
                <div>Countries: GB + IE · Market type: WIN</div>
                <div>Timing: 1–4 min before start · Odds cap: 50/1</div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-muted/20">
            <CardContent className="pt-4 pb-4 px-4 text-xs text-muted-foreground space-y-1.5">
              <div className="font-medium text-muted-foreground/90">How it works</div>
              <div>Backs the top 40% of the field by market weight. Skips any race with a favourite shorter than 3/1. Stakes are dutched so every backed horse returns the same profit.</div>
              <div className="flex items-center gap-1.5 text-emerald-400/80">
                <TrendingUp className="w-3 h-3 flex-shrink-0" />Any backed runner wins = target profit
              </div>
              <div className="flex items-center gap-1.5 text-red-400/80">
                <TrendingDown className="w-3 h-3 flex-shrink-0" />Unbacked runner wins = lose outlay
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function BookieBot() {
  const qc = useQueryClient();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bookie Bot</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Two automated strategies running independently on live GB/IE racing
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries()}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      <Tabs defaultValue="dutch">
        <TabsList className="mb-4">
          <TabsTrigger value="dutch">Dutch Bot</TabsTrigger>
          <TabsTrigger value="lay">Lay Bot</TabsTrigger>
        </TabsList>
        <TabsContent value="dutch">
          <DutchBotTab />
        </TabsContent>
        <TabsContent value="lay">
          <BookieBotTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
