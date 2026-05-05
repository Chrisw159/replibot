import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Scale, Power, PowerOff, ChevronDown, ChevronRight, TrendingUp, TrendingDown, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";


interface BookieStatus {
  isRunning: boolean;
  startedAt: string | null;
  paperTradingMode: boolean;
  bookieConfig: {
    maxRaceNetLoss: number;
    maxRunnerLiability: number;
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

interface BookieRaceBet {
  id: number;
  selectionName: string;
  betType: string;
  requestedOdds: number;
  stakeAmount: number;
  liability: number;
  actualProfit: number | null;
  status: string;
  aiReasoning: string | null;
  placedAt: string;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-sm text-muted-foreground mt-1">{label}</div>
        {sub && <div className="text-xs text-muted-foreground/70 mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function ProfitBadge({ value, settled }: { value: number; settled: boolean }) {
  if (!settled) return <Badge variant="outline" className="text-muted-foreground">Pending</Badge>;
  if (value > 0) return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30">+£{value.toFixed(2)}</Badge>;
  if (value < 0) return <Badge className="bg-red-500/15 text-red-600 border-red-500/30">-£{Math.abs(value).toFixed(2)}</Badge>;
  return <Badge variant="outline">£0.00</Badge>;
}

function RunnerStatusBadge({ status }: { status: string }) {
  const colours: Record<string, string> = {
    WON: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    LOST: "bg-red-500/15 text-red-600 border-red-500/30",
    MATCHED: "bg-blue-500/15 text-blue-600 border-blue-500/30",
    PLACED: "bg-amber-500/15 text-amber-600 border-amber-500/30",
    VOID: "bg-muted text-muted-foreground",
  };
  return <Badge className={colours[status] ?? ""}>{status}</Badge>;
}

function RaceRow({ race }: { race: BookieRace }) {
  const [open, setOpen] = useState(false);
  const { data: runners } = useQuery<BookieRaceBet[]>({
    queryKey: ["bookie-race", race.marketId],
    queryFn: () => apiFetch(`/bookie/race/${race.marketId}`),
    enabled: open,
  });

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-3 min-w-0">
          {open ? <ChevronDown className="w-4 h-4 flex-shrink-0 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 flex-shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{race.eventName}</div>
            <div className="text-xs text-muted-foreground">{race.marketName} · {new Date(race.placedAt).toLocaleString()}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-4">
          <div className="text-xs text-muted-foreground hidden sm:block">{race.betCount} runners</div>
          <ProfitBadge value={race.netProfit} settled={race.settled} />
        </div>
      </button>

      {open && (
        <div className="border-t bg-muted/10 px-4 py-3">
          {!runners ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : (
            <div className="space-y-1">
              <div className="grid grid-cols-5 text-xs font-medium text-muted-foreground mb-2 gap-2">
                <div className="col-span-2">Runner</div>
                <div className="text-right">Odds</div>
                <div className="text-right">Stake / Liab</div>
                <div className="text-right">Result</div>
              </div>
              {runners.map(r => (
                <div key={r.id} className="grid grid-cols-5 text-sm items-center gap-2 py-1 border-b border-border/50 last:border-0">
                  <div className="col-span-2 font-medium truncate">{r.selectionName}</div>
                  <div className="text-right text-muted-foreground">{r.requestedOdds.toFixed(2)}</div>
                  <div className="text-right">
                    <div>£{r.stakeAmount.toFixed(2)}</div>
                    <div className="text-xs text-muted-foreground">£{r.liability.toFixed(2)} liab</div>
                  </div>
                  <div className="text-right">
                    <RunnerStatusBadge status={r.status} />
                    {r.actualProfit !== null && (
                      <div className={`text-xs mt-0.5 ${r.actualProfit >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                        {r.actualProfit >= 0 ? "+" : ""}£{r.actualProfit.toFixed(2)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div className="pt-2 flex justify-between text-xs text-muted-foreground">
                <span>Total staked: £{race.totalStaked.toFixed(2)}</span>
                <span>Collected: £{race.totalCollected.toFixed(2)} · Paid out: £{race.totalPaidOut.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      )}
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

  const startMutation = useMutation({
    mutationFn: () => apiFetch<BookieStatus>("/bookie/start", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookie-status"] }),
  });

  const stopMutation = useMutation({
    mutationFn: () => apiFetch<BookieStatus>("/bookie/stop", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookie-status"] }),
  });

  const [maxLoss, setMaxLoss] = useState<string>("");
  const [maxLiab, setMaxLiab] = useState<string>("");
  const [minLiq, setMinLiq] = useState<string>("");
  const [countryInput, setCountryInput] = useState<string>("");

  const configMutation = useMutation({
    mutationFn: (body: {
      maxRaceNetLoss?: number;
      maxRunnerLiability?: number;
      minLiquidity?: number;
      countryCodes?: string[];
    }) => apiFetch("/bookie/config", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookie-status"] });
      setMaxLoss(""); setMaxLiab(""); setMinLiq(""); setCountryInput("");
    },
  });

  const isRunning = status?.isRunning ?? false;
  const isPaper = status?.paperTradingMode ?? true;
  const cfg = status?.bookieConfig;

  const handleSaveConfig = () => {
    const patch: Parameters<typeof configMutation.mutate>[0] = {};
    if (maxLoss !== "") patch.maxRaceNetLoss = parseFloat(maxLoss);
    if (maxLiab !== "") patch.maxRunnerLiability = parseFloat(maxLiab);
    if (minLiq !== "") patch.minLiquidity = parseFloat(minLiq);
    if (countryInput.trim() !== "") {
      patch.countryCodes = countryInput.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
    }
    if (Object.keys(patch).length > 0) configMutation.mutate(patch);
  };

  const applyPreset = (codes: string[]) => {
    configMutation.mutate({ countryCodes: codes });
  };

  const profitToday = status?.profitToday ?? 0;
  const totalProfit = status?.totalNetProfit ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-primary" />
            <h1 className="text-2xl font-bold">Bookie Bot</h1>
            {isPaper && (
              <Badge className="bg-chart-2/20 text-chart-2 border-chart-2/30 text-[10px] uppercase tracking-wider">
                Paper
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Lays every runner proportional to real Betfair crowd money
            {cfg?.countryCodes?.length ? ` — ${cfg.countryCodes.join(", ")} races` : ""}
          </p>
        </div>

        <Button
          size="lg"
          variant={isRunning ? "destructive" : "default"}
          disabled={isLoading || startMutation.isPending || stopMutation.isPending}
          onClick={() => isRunning ? stopMutation.mutate() : startMutation.mutate()}
          className="gap-2"
        >
          {isRunning ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
          {isRunning ? "Stop Bookie Bot" : "Start Bookie Bot"}
        </Button>
      </div>

      {isRunning && (
        <div className="flex items-center gap-2 text-sm text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Bookie Bot is running{isPaper ? " in paper trading mode" : ""} — scanning {cfg?.countryCodes?.join(", ") ?? "GB, IE"} races every 60 seconds</span>
          {status?.startedAt && (
            <span className="ml-auto text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Since {new Date(status.startedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Today's Net P&L"
          value={`${profitToday >= 0 ? "+" : ""}£${profitToday.toFixed(2)}`}
          sub={`${status?.racesToday ?? 0} races today`}
        />
        <StatCard
          label="Total Net P&L"
          value={`${totalProfit >= 0 ? "+" : ""}£${totalProfit.toFixed(2)}`}
          sub={`${status?.totalRaces ?? 0} races all time`}
        />
        <StatCard
          label="Max Race Net Loss"
          value={`£${cfg?.maxRaceNetLoss ?? 100}`}
          sub="Worst-case per race"
        />
        <StatCard
          label="Max Runner Liability"
          value={`£${cfg?.maxRunnerLiability ?? 300}`}
          sub="Per individual runner"
        />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Strategy Config</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-muted/40 rounded-lg p-3 text-sm space-y-1">
              <div className="font-medium text-xs text-muted-foreground uppercase tracking-wide mb-2">How it works</div>
              <p>Reads the real crowd money on each runner (<code className="text-xs bg-muted px-1 rounded">totalMatched</code>) and lays every runner at the same proportion — mirroring the betting market on a smaller scale.</p>
              <p className="text-muted-foreground text-xs mt-2">Worst case: if the most-backed horse wins, net loss is capped at your max race loss. If an outsider wins, you profit.</p>
            </div>

            {/* Country codes */}
            <div className="space-y-2">
              <Label>Country Codes</Label>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: "GB + IE", codes: ["GB", "IE"] },
                  { label: "AU", codes: ["AU"] },
                  { label: "US", codes: ["US"] },
                  { label: "GB + IE + AU", codes: ["GB", "IE", "AU"] },
                  { label: "All", codes: ["GB", "IE", "AU", "US", "ZA", "FR"] },
                ].map(p => (
                  <Button
                    key={p.label}
                    size="sm"
                    variant={
                      cfg?.countryCodes?.join(",") === p.codes.join(",")
                        ? "default"
                        : "outline"
                    }
                    className="h-7 text-xs"
                    disabled={configMutation.isPending}
                    onClick={() => applyPreset(p.codes)}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder={`Current: ${cfg?.countryCodes?.join(", ") ?? "GB, IE"}`}
                  value={countryInput}
                  onChange={e => setCountryInput(e.target.value)}
                  className="text-sm"
                />
                <p className="text-xs text-muted-foreground self-center whitespace-nowrap">comma-separated</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="maxLoss">Max Net Loss / Race (£)</Label>
                <Input
                  id="maxLoss"
                  type="number"
                  placeholder={String(cfg?.maxRaceNetLoss ?? 100)}
                  value={maxLoss}
                  onChange={e => setMaxLoss(e.target.value)}
                  min={1}
                  max={1000}
                />
                <p className="text-xs text-muted-foreground">Worst case P&L if any one horse wins</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="maxLiab">Max Liability / Runner (£)</Label>
                <Input
                  id="maxLiab"
                  type="number"
                  placeholder={String(cfg?.maxRunnerLiability ?? 300)}
                  value={maxLiab}
                  onChange={e => setMaxLiab(e.target.value)}
                  min={1}
                  max={5000}
                />
                <p className="text-xs text-muted-foreground">Cap on any single runner payout</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="minLiq">Min Market Liquidity (£)</Label>
              <Input
                id="minLiq"
                type="number"
                placeholder={String(cfg?.minLiquidity ?? 10000)}
                value={minLiq}
                onChange={e => setMinLiq(e.target.value)}
                min={0}
                max={500000}
                step={1000}
              />
              <p className="text-xs text-muted-foreground">Skip races with less totalMatched than this — lower for US/AU markets</p>
            </div>

            <div className="text-xs text-muted-foreground space-y-0.5 border-t pt-3">
              <div className="font-medium">Fixed parameters:</div>
              <div>Race type: WIN markets · Timing: 1–4 min before start · Odds: 1.5–50</div>
              <div>Min runner pool share: 2% · Min stake: £2</div>
            </div>

            <Button
              onClick={handleSaveConfig}
              disabled={configMutation.isPending || (maxLoss === "" && maxLiab === "" && minLiq === "" && countryInput.trim() === "")}
              className="w-full"
            >
              Save Config
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Today's Summary</CardTitle>
          </CardHeader>
          <CardContent>
            {(races ?? []).filter(r => {
              const d = new Date(r.placedAt);
              const today = new Date();
              return d.toDateString() === today.toDateString();
            }).length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">
                No races today yet — bot will scan every minute when running
              </div>
            ) : (
              <div className="space-y-2">
                {(races ?? [])
                  .filter(r => new Date(r.placedAt).toDateString() === new Date().toDateString())
                  .map(race => (
                    <div key={race.marketId} className="flex items-center justify-between text-sm py-1 border-b border-border/50 last:border-0">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{race.eventName}</div>
                        <div className="text-xs text-muted-foreground">{race.betCount} runners · £{race.totalStaked.toFixed(2)} staked</div>
                      </div>
                      <ProfitBadge value={race.netProfit} settled={race.settled} />
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Race History</CardTitle>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {(races ?? []).filter(r => r.settled && r.netProfit > 0).length} profitable ·{" "}
              {(races ?? []).filter(r => r.settled && r.netProfit < 0).length} losing
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {!races || races.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-10">
              No bookie bets placed yet. Start the bot to begin laying markets.
            </div>
          ) : (
            <div className="space-y-2">
              {races.map(race => (
                <RaceRow key={race.marketId} race={race} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-muted">
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground space-y-1">
            <div className="flex items-center gap-1 font-medium">
              {totalProfit >= 0
                ? <TrendingUp className="w-3 h-3 text-emerald-500" />
                : <TrendingDown className="w-3 h-3 text-red-500" />}
              Position interpretation
            </div>
            <p>
              When longshots win → you profit (small liability, large stakes collected from everyone else).
              When the most-backed horse wins → worst case, capped at £{cfg?.maxRaceNetLoss ?? 100}.
              The formula scales stakes so both constraints are satisfied simultaneously.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
