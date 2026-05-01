import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatCurrency, formatNumber } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, TrendingDown, Clock, ChevronRight, ArrowLeft } from "lucide-react";

interface RaceSummary {
  marketId: string;
  marketName: string;
  eventName: string;
  placedAt: string;
  betCount: number;
  totalStaked: number;
  totalProfit: number | null;
  settled: boolean;
}

interface Bet {
  id: number;
  selectionName: string;
  betType: string;
  requestedOdds: number;
  matchedOdds: number | null;
  stakeAmount: number;
  potentialProfit: number;
  actualProfit: number | null;
  status: string;
  aiReasoning: string | null;
  placedAt: string;
}

interface Runner {
  id: number;
  selectionId: number;
  runnerName: string;
  bestBackPrice: number | null;
  status: string;
  included: boolean;
  excludeReason: string | null;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function groupByDate(races: RaceSummary[]) {
  const groups: Record<string, RaceSummary[]> = {};
  races.forEach((r) => {
    const day = new Date(r.placedAt).toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long"
    });
    if (!groups[day]) groups[day] = [];
    groups[day].push(r);
  });
  return groups;
}

function getStatusColor(status: string) {
  switch (status) {
    case "WON": return "bg-chart-1/20 text-chart-1 border-chart-1/30";
    case "LOST": return "bg-chart-4/20 text-chart-4 border-chart-4/30";
    case "PLACED": return "bg-chart-3/20 text-chart-3 border-chart-3/30";
    case "MATCHED": return "bg-chart-2/20 text-chart-2 border-chart-2/30";
    default: return "bg-muted text-muted-foreground border-border";
  }
}

function RaceDetail({ marketId, race, onBack }: { marketId: string; race: RaceSummary; onBack: () => void }) {
  const { data: bets, isLoading } = useQuery<Bet[]>({
    queryKey: ["race-bets", marketId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/bets/race/${encodeURIComponent(marketId)}`);
      return res.json();
    },
  });

  const { data: runners } = useQuery<Runner[]>({
    queryKey: ["race-runners", marketId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/bets/race/${encodeURIComponent(marketId)}/runners`);
      return res.json();
    },
  });

  const excludedRunners = runners?.filter(r => !r.included) ?? [];

  const totalStaked = bets?.reduce((s, b) => s + b.stakeAmount, 0) ?? 0;
  const totalProfit = bets?.reduce((s, b) => s + (b.actualProfit ?? 0), 0) ?? 0;
  const settled = bets?.every(b => b.status === "WON" || b.status === "LOST" || b.status === "SETTLED") ?? false;
  const winner = bets?.find(b => b.status === "WON");

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to races
      </button>

      <div>
        <h2 className="text-xl font-bold">{race.eventName}</h2>
        <p className="text-muted-foreground text-sm">{race.marketName}</p>
        <p className="text-muted-foreground text-xs mt-0.5">
          {new Date(race.placedAt).toLocaleDateString("en-GB", {
            weekday: "long", day: "numeric", month: "long", year: "numeric",
            hour: "2-digit", minute: "2-digit"
          })}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Staked</p>
            <p className="text-lg font-bold font-mono">{formatCurrency(totalStaked)}</p>
          </CardContent>
        </Card>
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Result</p>
            {settled ? (
              <p className={`text-lg font-bold font-mono ${totalProfit >= 0 ? "text-chart-1" : "text-chart-4"}`}>
                {totalProfit >= 0 ? "+" : ""}{formatCurrency(totalProfit)}
              </p>
            ) : (
              <p className="text-lg font-bold text-muted-foreground">Pending</p>
            )}
          </CardContent>
        </Card>
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Runners Backed</p>
            <p className="text-lg font-bold">{bets?.length ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      {winner && (
        <Card className="border-chart-1/30 bg-chart-1/5">
          <CardContent className="p-4 flex items-center gap-3">
            <Trophy className="h-5 w-5 text-chart-1 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-chart-1">Winner: {winner.selectionName}</p>
              <p className="text-xs text-muted-foreground">
                Odds {formatNumber(winner.matchedOdds || winner.requestedOdds)} · Return {formatCurrency((winner.actualProfit ?? 0) + winner.stakeAmount)}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/50 bg-card/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Runners</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : bets?.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground text-sm">No bets found for this race</p>
          ) : (
            <div className="divide-y divide-border/50">
              {bets?.map((bet) => (
                <div key={bet.id} className="px-4 py-3 flex items-center justify-between gap-4 hover:bg-muted/20">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${bet.status === "WON" ? "bg-chart-1" : bet.status === "LOST" ? "bg-chart-4" : "bg-chart-3"}`} />
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{bet.selectionName}</p>
                      <p className="text-xs text-muted-foreground">
                        Odds {formatNumber(bet.matchedOdds || bet.requestedOdds)} · Stake {formatCurrency(bet.stakeAmount)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {(bet.status === "WON" || bet.status === "LOST") ? (
                      <span className={`font-mono text-sm font-semibold ${(bet.actualProfit ?? 0) >= 0 ? "text-chart-1" : "text-chart-4"}`}>
                        {(bet.actualProfit ?? 0) >= 0 ? "+" : ""}{formatCurrency(bet.actualProfit)}
                      </span>
                    ) : (
                      <span className="font-mono text-sm text-muted-foreground">
                        ~{formatCurrency(bet.potentialProfit)}
                      </span>
                    )}
                    <Badge variant="outline" className={`text-xs ${getStatusColor(bet.status)}`}>
                      {bet.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {excludedRunners.length > 0 && (
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Excluded Runners ({excludedRunners.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border/50">
              {excludedRunners.map((runner) => (
                <div key={runner.id} className="px-4 py-3 flex items-center justify-between gap-4 opacity-60">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-2 h-2 rounded-full bg-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{runner.runnerName}</p>
                      <p className="text-xs text-muted-foreground">{runner.excludeReason ?? "Not selected"}</p>
                    </div>
                  </div>
                  <span className="font-mono text-sm text-muted-foreground shrink-0">
                    {runner.bestBackPrice != null ? formatNumber(runner.bestBackPrice) : "—"}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {bets?.some(b => b.aiReasoning) && (
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">AI Reasoning</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {bets.find(b => b.aiReasoning)?.aiReasoning}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function Bets() {
  const [selectedRace, setSelectedRace] = useState<RaceSummary | null>(null);

  const { data: races, isLoading } = useQuery<RaceSummary[]>({
    queryKey: ["races"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/bets/races`);
      return res.json();
    },
    refetchInterval: 30000,
  });

  const grouped = races ? groupByDate(races) : {};
  const hasRaces = races && races.length > 0;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Race History</h1>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start">
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Races</CardTitle>
          </CardHeader>
          <CardContent className="p-0 max-h-[70vh] overflow-y-auto">
            {isLoading ? (
              <div className="space-y-2 p-4">
                {Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : !hasRaces ? (
              <div className="text-center py-12 text-muted-foreground text-sm px-4">
                <Clock className="h-8 w-8 mx-auto mb-2 opacity-40" />
                No races yet — they'll appear here once the bot places bets
              </div>
            ) : (
              Object.entries(grouped).map(([day, dayRaces]) => (
                <div key={day}>
                  <div className="px-4 py-2 bg-muted/40 border-y border-border/30">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{day}</p>
                  </div>
                  {dayRaces.map((race) => {
                    const isSelected = selectedRace?.marketId === race.marketId;
                    const profit = race.totalProfit ?? 0;
                    return (
                      <button
                        key={race.marketId}
                        onClick={() => setSelectedRace(race)}
                        className={`w-full text-left px-4 py-3 border-b border-border/30 hover:bg-muted/30 transition-colors flex items-center justify-between gap-2 ${isSelected ? "bg-muted/50 border-l-2 border-l-primary" : ""}`}
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{race.eventName}</p>
                          <p className="text-xs text-muted-foreground truncate">{race.marketName}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {race.betCount} {race.betCount === 1 ? "bet" : "bets"} · Staked {formatCurrency(race.totalStaked)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {race.settled ? (
                            profit >= 0 ? (
                              <span className="text-chart-1 font-mono text-sm font-semibold flex items-center gap-1">
                                <Trophy className="h-3 w-3" />+{formatCurrency(profit)}
                              </span>
                            ) : (
                              <span className="text-chart-4 font-mono text-sm font-semibold flex items-center gap-1">
                                <TrendingDown className="h-3 w-3" />{formatCurrency(profit)}
                              </span>
                            )
                          ) : (
                            <span className="text-xs text-muted-foreground">Pending</span>
                          )}
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <div>
          {selectedRace ? (
            <RaceDetail
              marketId={selectedRace.marketId}
              race={selectedRace}
              onBack={() => setSelectedRace(null)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <ChevronRight className="h-10 w-10 mb-3 opacity-20" />
              <p className="text-sm">Select a race from the left to see the full breakdown</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
