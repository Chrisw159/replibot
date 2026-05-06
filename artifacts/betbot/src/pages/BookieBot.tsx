import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Scale, Power, PowerOff, TrendingUp, TrendingDown, Clock,
  ChevronRight, Trophy, Banknote, Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface BotLog {
  id: number;
  level: string;
  message: string;
  metadata: string | null;
  createdAt: string;
}

interface BookieStatus {
  isRunning: boolean;
  startedAt: string | null;
  paperTradingMode: boolean;
  bookieConfig: {
    stakePerRunner: number;
    maxRaceNetLoss: number;
    maxOdds: number;
    minRunners: number;
    countryCodes: string[];
    minLiquidity: number;
  };
  racesToday: number;
  betsToday: number;
  profitToday: number;
  totalRaces: number;
  totalNetProfit: number;
}

interface BookieRace {
  marketId: string;
  marketName: string;
  eventName: string;
  placedAt: string;
  betCount: number;
  totalStaked: number;
  totalCollected: number;
  totalPaidOut: number;
  netProfit: number;
  settled: boolean;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

function PnlChip({ value, settled }: { value: number; settled: boolean }) {
  if (!settled) return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Clock className="w-3 h-3" /> Pending
    </span>
  );
  if (value > 0) return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-500">
      <TrendingUp className="w-3 h-3" /> +£{value.toFixed(2)}
    </span>
  );
  if (value < 0) return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-500">
      <TrendingDown className="w-3 h-3" /> -£{Math.abs(value).toFixed(2)}
    </span>
  );
  return <span className="text-xs text-muted-foreground">£0.00</span>;
}

function RaceRow({ race }: { race: BookieRace }) {
  const isToday = new Date(race.placedAt).toDateString() === new Date().toDateString();

  return (
    <Link href={`/bookiebot/race/${race.marketId}`}>
      <div className="group flex items-center gap-4 px-4 py-3.5 rounded-xl border border-border/60 bg-card/50 hover:bg-muted/40 hover:border-border transition-all cursor-pointer">
        {/* Icon */}
        <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
          race.settled && race.netProfit > 0 ? "bg-emerald-500/15 text-emerald-500" :
          race.settled && race.netProfit < 0 ? "bg-red-500/15 text-red-500" :
          "bg-muted text-muted-foreground"
        }`}>
          {race.settled && race.netProfit > 0
            ? <Trophy className="w-4 h-4" />
            : <Banknote className="w-4 h-4" />}
        </div>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-foreground truncate">{race.eventName}</div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-xs text-muted-foreground">{race.marketName}</span>
            <span className="text-muted-foreground/40 text-xs">·</span>
            <span className="text-xs text-muted-foreground">
              {new Date(race.placedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {!isToday && (
                <> · {new Date(race.placedAt).toLocaleDateString([], { day: "numeric", month: "short" })}</>
              )}
            </span>
            <span className="text-muted-foreground/40 text-xs">·</span>
            <span className="text-xs text-muted-foreground">{race.betCount} runners</span>
            <span className="text-muted-foreground/40 text-xs">·</span>
            <span className="text-xs text-muted-foreground">£{race.totalStaked.toFixed(2)} staked</span>
          </div>
        </div>

        {/* P&L */}
        <div className="flex-shrink-0">
          <PnlChip value={race.netProfit} settled={race.settled} />
        </div>

        {/* Arrow */}
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors flex-shrink-0" />
      </div>
    </Link>
  );
}

function LogLine({ log }: { log: BotLog }) {
  const isLaying  = log.message.toLowerCase().includes("laying");
  const isSkip    = log.message.toLowerCase().includes("skipping");
  const isError   = log.level === "error";
  const isWarn    = log.level === "warn";
  const isCycle   = log.message.toLowerCase().startsWith("cycle");
  const isStart   = log.message.toLowerCase().includes("started") || log.message.toLowerCase().includes("stopped");

  const msgColour =
    isError   ? "text-red-400" :
    isWarn    ? "text-amber-400" :
    isLaying  ? "text-emerald-400 font-medium" :
    isSkip    ? "text-muted-foreground/60" :
    isCycle   ? "text-blue-400/80" :
    isStart   ? "text-violet-400" :
    "text-slate-300";

  const levelColour =
    isError ? "text-red-500" :
    isWarn  ? "text-amber-500" :
    "text-slate-600";

  return (
    <div className="flex items-start gap-3 py-1 border-b border-white/[0.04] last:border-0">
      <span className="text-slate-600 flex-shrink-0 tabular-nums text-[11px] pt-px w-[52px]">
        {new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
      <span className={`text-[10px] font-bold uppercase flex-shrink-0 w-8 pt-px ${levelColour}`}>
        {log.level.slice(0, 4)}
      </span>
      <span className={`text-xs leading-relaxed break-words ${msgColour}`}>{log.message}</span>
    </div>
  );
}

export default function BookieBot() {
  const qc = useQueryClient();

  const { data: status, isLoading } = useQuery<BookieStatus>({
    queryKey: ["bookie-status"],
    queryFn: () => apiFetch("/bookie/status"),
    refetchInterval: 5000,
  });

  const { data: races } = useQuery<BookieRace[]>({
    queryKey: ["bookie-races"],
    queryFn: () => apiFetch("/bookie/races"),
    refetchInterval: 10000,
  });

  const { data: logs } = useQuery<BotLog[]>({
    queryKey: ["bookie-logs"],
    queryFn: () => apiFetch("/bookie/logs?limit=200"),
    refetchInterval: 5000,
  });

  const consoleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs]);

  const startMutation = useMutation({
    mutationFn: () => apiFetch<BookieStatus>("/bookie/start", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookie-status"] }),
  });

  const stopMutation = useMutation({
    mutationFn: () => apiFetch<BookieStatus>("/bookie/stop", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookie-status"] }),
  });

  const [stakePerRunner, setStakePerRunner]   = useState("");
  const [maxLoss, setMaxLoss]                 = useState("");
  const [maxOddsInput, setMaxOddsInput]       = useState("");
  const [minRunnersInput, setMinRunnersInput] = useState("");
  const [minLiq, setMinLiq]                   = useState("");
  const [countryInput, setCountryInput]       = useState("");

  const configMutation = useMutation({
    mutationFn: (body: {
      stakePerRunner?: number;
      maxRaceNetLoss?: number;
      maxOdds?: number;
      minRunners?: number;
      minLiquidity?: number;
      countryCodes?: string[];
    }) => apiFetch("/bookie/config", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookie-status"] });
      setStakePerRunner(""); setMaxLoss(""); setMaxOddsInput("");
      setMinRunnersInput(""); setMinLiq(""); setCountryInput("");
    },
  });

  const isRunning = status?.isRunning ?? false;
  const isPaper   = status?.paperTradingMode ?? true;
  const cfg       = status?.bookieConfig;

  const handleSaveConfig = () => {
    const patch: Parameters<typeof configMutation.mutate>[0] = {};
    if (stakePerRunner !== "")  patch.stakePerRunner = parseFloat(stakePerRunner);
    if (maxLoss !== "")         patch.maxRaceNetLoss = parseFloat(maxLoss);
    if (maxOddsInput !== "")    patch.maxOdds        = parseFloat(maxOddsInput);
    if (minRunnersInput !== "") patch.minRunners     = parseInt(minRunnersInput, 10);
    if (minLiq !== "")          patch.minLiquidity   = parseFloat(minLiq);
    if (countryInput.trim() !== "") {
      patch.countryCodes = countryInput.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
    }
    if (Object.keys(patch).length > 0) configMutation.mutate(patch);
  };

  const profitToday  = status?.profitToday    ?? 0;
  const totalProfit  = status?.totalNetProfit ?? 0;
  const todaysRaces  = (races ?? []).filter(r => new Date(r.placedAt).toDateString() === new Date().toDateString());
  const profitableCount = (races ?? []).filter(r => r.settled && r.netProfit > 0).length;
  const losingCount     = (races ?? []).filter(r => r.settled && r.netProfit < 0).length;

  return (
    <div className="space-y-6 pb-8">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#0072bb]/20 flex items-center justify-center">
              <Scale className="w-4 h-4 text-[#0072bb]" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Bookie Bot</h1>
            {isPaper && (
              <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/30 text-[10px] uppercase tracking-wider font-semibold">
                Paper
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1.5 ml-0.5">
            Level-stakes back-the-field · Horse racing WIN markets · {cfg?.countryCodes?.join(", ") ?? "GB, IE"}
          </p>
        </div>

        <Button
          size="lg"
          variant={isRunning ? "destructive" : "default"}
          disabled={isLoading || startMutation.isPending || stopMutation.isPending}
          onClick={() => isRunning ? stopMutation.mutate() : startMutation.mutate()}
          className="gap-2 shadow-md"
        >
          {isRunning ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
          {isRunning ? "Stop Bookie Bot" : "Start Bookie Bot"}
        </Button>
      </div>

      {/* ── Status banner ── */}
      {isRunning ? (
        <div className="flex items-center gap-3 text-sm bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
          </span>
          <span className="text-emerald-600 font-medium">
            Running{isPaper ? " in paper mode" : ""} — scanning {cfg?.countryCodes?.join(", ") ?? "GB, IE"} races
          </span>
          {status?.startedAt && (
            <span className="ml-auto text-muted-foreground flex items-center gap-1.5 text-xs">
              <Clock className="w-3 h-3" />
              Since {new Date(status.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3 text-sm bg-muted/40 border border-border/60 rounded-xl px-4 py-3">
          <span className="w-2.5 h-2.5 rounded-full bg-muted-foreground/40 flex-shrink-0" />
          <span className="text-muted-foreground">Bot is stopped — press Start to begin scanning races</span>
        </div>
      )}

      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: "Today's P&L",
            value: `${profitToday >= 0 ? "+" : ""}£${profitToday.toFixed(2)}`,
            sub: `${status?.racesToday ?? 0} races today`,
            colour: profitToday > 0 ? "text-emerald-500" : profitToday < 0 ? "text-red-500" : "",
          },
          {
            label: "All-time P&L",
            value: `${totalProfit >= 0 ? "+" : ""}£${totalProfit.toFixed(2)}`,
            sub: `${status?.totalRaces ?? 0} races total`,
            colour: totalProfit > 0 ? "text-emerald-500" : totalProfit < 0 ? "text-red-500" : "",
          },
          {
            label: "Stake / Runner",
            value: `£${cfg?.stakePerRunner ?? 10}`,
            sub: "Flat back stake each",
            colour: "",
          },
          {
            label: "Max Race Outlay",
            value: `£${cfg?.maxRaceNetLoss ?? 150}`,
            sub: "Skip if total > this",
            colour: "",
          },
        ].map(s => (
          <Card key={s.label} className="border-border/60">
            <CardContent className="pt-5 pb-4">
              <div className={`text-2xl font-bold tabular-nums ${s.colour}`}>{s.value}</div>
              <div className="text-xs text-muted-foreground mt-1 font-medium">{s.label}</div>
              <div className="text-[11px] text-muted-foreground/60 mt-0.5">{s.sub}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Main grid ── */}
      <div className="grid md:grid-cols-[1fr_360px] gap-6">

        {/* Race history */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Race History</h2>
            {(races ?? []).length > 0 && (
              <span className="text-xs text-muted-foreground">
                {profitableCount} won · {losingCount} lost · {(races ?? []).filter(r => !r.settled).length} pending
              </span>
            )}
          </div>

          {!races || races.length === 0 ? (
            <div className="rounded-xl border border-border/60 border-dashed bg-muted/20 py-16 text-center">
              <Banknote className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No races yet</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Start the bot to begin laying markets</p>
            </div>
          ) : (
            <div className="space-y-2">
              {races.map(race => <RaceRow key={race.marketId} race={race} />)}
            </div>
          )}
        </div>

        {/* Right column: config + today's summary */}
        <div className="space-y-4">

          {/* Today's summary */}
          <Card className="border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Today</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {todaysRaces.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No races today yet</p>
              ) : (
                todaysRaces.map(race => (
                  <Link key={race.marketId} href={`/bookiebot/race/${race.marketId}`}>
                    <div className="flex items-center justify-between py-2 border-b border-border/40 last:border-0 cursor-pointer hover:opacity-80 transition-opacity group">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                          {race.eventName}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {race.betCount} runners · £{race.totalStaked.toFixed(2)}
                        </div>
                      </div>
                      <PnlChip value={race.netProfit} settled={race.settled} />
                    </div>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>

          {/* Config */}
          <Card className="border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Strategy Config</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-0">

              {/* Country presets */}
              <div className="space-y-2">
                <Label className="text-xs">Country Codes</Label>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { label: "GB + IE",       codes: ["GB", "IE"] },
                    { label: "AU",            codes: ["AU"] },
                    { label: "GB + IE + AU",  codes: ["GB", "IE", "AU"] },
                    { label: "All",           codes: ["GB", "IE", "AU", "US", "ZA", "FR"] },
                  ].map(p => (
                    <Button
                      key={p.label}
                      size="sm"
                      variant={cfg?.countryCodes?.join(",") === p.codes.join(",") ? "default" : "outline"}
                      className="h-7 text-xs"
                      disabled={configMutation.isPending}
                      onClick={() => configMutation.mutate({ countryCodes: p.codes })}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
                <Input
                  placeholder={`Current: ${cfg?.countryCodes?.join(", ") ?? "GB, IE"}`}
                  value={countryInput}
                  onChange={e => setCountryInput(e.target.value)}
                  className="text-xs h-8"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="stakePerRunner" className="text-xs">Lay Stake / Runner (£)</Label>
                  <Input
                    id="stakePerRunner" type="number"
                    placeholder={String(cfg?.stakePerRunner ?? 10)}
                    value={stakePerRunner} onChange={e => setStakePerRunner(e.target.value)}
                    min={2} max={500} className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="maxOdds" className="text-xs">Max Lay Odds (liability cap)</Label>
                  <Input
                    id="maxOdds" type="number"
                    placeholder={String(cfg?.maxOdds ?? 20)}
                    value={maxOddsInput} onChange={e => setMaxOddsInput(e.target.value)}
                    min={2} max={100} className="h-8 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="maxLoss" className="text-xs">Max Race Loss (£)</Label>
                  <Input
                    id="maxLoss" type="number"
                    placeholder={String(cfg?.maxRaceNetLoss ?? 150)}
                    value={maxLoss} onChange={e => setMaxLoss(e.target.value)}
                    min={1} max={5000} className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="minRunners" className="text-xs">Min Runners</Label>
                  <Input
                    id="minRunners" type="number"
                    placeholder={String(cfg?.minRunners ?? 5)}
                    value={minRunnersInput} onChange={e => setMinRunnersInput(e.target.value)}
                    min={2} max={20} className="h-8 text-sm"
                  />
                </div>
              </div>

              <div className="rounded-md bg-white/[0.04] border border-white/10 px-3 py-2 text-[11px] text-muted-foreground/80 space-y-0.5">
                <div className="font-medium text-muted-foreground">How it works</div>
                <div>Lay all runners at equal stake. P&L = stake × (runners − winner odds)</div>
                <div>Favourite wins (short odds) → biggest profit · Outsider wins → biggest loss</div>
                <div>Breakeven = number of eligible runners as decimal odds</div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="minLiq" className="text-xs">Min Market Liquidity (£)</Label>
                <Input
                  id="minLiq" type="number"
                  placeholder={String(cfg?.minLiquidity ?? 1000)}
                  value={minLiq} onChange={e => setMinLiq(e.target.value)}
                  min={0} max={500000} step={1000} className="h-8 text-sm"
                />
              </div>

              <Button
                onClick={handleSaveConfig}
                disabled={configMutation.isPending || (stakePerRunner === "" && maxLoss === "" && maxOddsInput === "" && minRunnersInput === "" && minLiq === "" && countryInput.trim() === "")}
                className="w-full h-8 text-xs"
              >
                Save Config
              </Button>

              <div className="text-[11px] text-muted-foreground/70 border-t border-border/40 pt-3 space-y-0.5">
                <div className="font-medium text-muted-foreground/90">Fixed parameters</div>
                <div>Market type: WIN · Timing: 1–4 min before start</div>
                <div>Min odds: 1.5 · Min pool share: 2% · Timing: 1–4 min before start</div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Activity console ── */}
      <div className="rounded-xl border border-white/10 bg-[#0a0d14] overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.02]">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-slate-500" />
            <span className="text-xs font-medium text-slate-400">Live Activity</span>
            {isRunning && (
              <span className="flex items-center gap-1 text-[10px] text-emerald-500/80">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                LIVE
              </span>
            )}
          </div>
          {logs && logs.length > 0 && (
            <span className="text-[10px] text-slate-600">{logs.length} entries</span>
          )}
        </div>
        <div
          ref={consoleRef}
          className="h-64 overflow-y-auto px-4 py-3 space-y-0 scrollbar-thin"
        >
          {!logs || logs.length === 0 ? (
            <div className="text-slate-600 text-xs py-8 text-center">
              No activity yet — start the bot to see live logs here
            </div>
          ) : (
            [...logs].reverse().map(log => <LogLine key={log.id} log={log} />)
          )}
        </div>
      </div>

    </div>
  );
}
