import { useGetDashboardSummary, useGetPnlChart, useGetRecentBets, useGetStrategyPerformance } from "@workspace/api-client-react";
import { formatCurrency, formatPercent } from "@/lib/format";

interface RecentRace {
  marketId: string;
  marketName: string;
  eventName: string;
  strategyName: string | null;
  placedAt: string;
  runnersBackedCount: number;
  totalStaked: number;
  netProfit: number | null;
  settled: boolean;
  hasWinner: boolean;
  winnerName: string | null;
}
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Legend } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";

export default function Dashboard() {
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary();
  const { data: pnlData, isLoading: loadingPnl } = useGetPnlChart({ days: 30 });
  const { data: recentBets, isLoading: loadingBets } = useGetRecentBets();
  const { data: perfData, isLoading: loadingPerf } = useGetStrategyPerformance();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
      </div>

      {/* Top Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total P&L" value={summary?.totalProfit} formatter={formatCurrency} loading={loadingSummary} />
        <StatCard title="Win Rate" value={summary?.winRate} formatter={formatPercent} loading={loadingSummary} />
        <StatCard title="Total Bets" value={summary?.totalBets} loading={loadingSummary} />
        <StatCard title="Total Staked" value={summary?.totalStaked} formatter={formatCurrency} loading={loadingSummary} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* PnL Chart */}
        <Card className="lg:col-span-2 border-border/50 bg-card/50 backdrop-blur">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">Cumulative P&L (30 Days)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              {loadingPnl ? <Skeleton className="w-full h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={pnlData}>
                    <defs>
                      <linearGradient id="colorPnl" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `£${v}`} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "8px" }}
                      itemStyle={{ color: "hsl(var(--foreground))" }}
                      formatter={(v: number) => [formatCurrency(v), "P&L"]}
                    />
                    <Area type="monotone" dataKey="cumulativePnl" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorPnl)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Strategy Performance */}
        <Card className="border-border/50 bg-card/50 backdrop-blur">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">Strategy Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              {loadingPerf ? <Skeleton className="w-full h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={perfData} layout="vertical" margin={{ top: 0, right: 0, left: 40, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                    <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="strategyName" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "8px" }}
                      formatter={(v: number) => [formatCurrency(v), "Profit"]}
                    />
                    <Bar dataKey="totalProfit" fill="hsl(var(--chart-1))" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      
      {/* Recent Activity — race level */}
      <Card className="border-border/50 bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingBets ? <Skeleton className="w-full h-32" /> : (
            <div className="divide-y divide-border/30">
              {(recentBets as unknown as RecentRace[])?.map(race => (
                <div key={race.marketId} className="flex items-center justify-between py-3 gap-4">
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{race.eventName}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {race.marketName} · {race.runnersBackedCount} runners · {new Date(race.placedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                    {race.winnerName && (
                      <div className="text-xs text-chart-1 mt-0.5">🏆 {race.winnerName}</div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    {race.settled ? (
                      <div className={`font-mono font-bold text-sm ${(race.netProfit ?? 0) >= 0 ? "text-chart-1" : "text-chart-4"}`}>
                        {(race.netProfit ?? 0) >= 0 ? "+" : ""}{formatCurrency(race.netProfit ?? 0)}
                      </div>
                    ) : (
                      <div className="text-xs text-chart-2 font-semibold">Pending</div>
                    )}
                    <div className="text-xs text-muted-foreground">{formatCurrency(race.totalStaked)} staked</div>
                  </div>
                </div>
              ))}
              {!recentBets?.length && (
                <div className="text-center py-8 text-muted-foreground text-sm">No recent races found</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ title, value, formatter = String, loading }: { title: string, value: any, formatter?: (v: any) => string, loading: boolean }) {
  const isPositive = typeof value === 'number' && value > 0 && title.includes('P&L');
  const isNegative = typeof value === 'number' && value < 0 && title.includes('P&L');
  
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardContent className="p-6">
        <div className="text-sm font-medium text-muted-foreground mb-2">{title}</div>
        {loading ? <Skeleton className="h-8 w-24" /> : (
          <div className={`text-2xl font-bold font-mono tracking-tight ${isPositive ? 'text-chart-1' : isNegative ? 'text-chart-4' : ''}`}>
            {value !== undefined ? formatter(value) : '-'}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
