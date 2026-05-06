import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { ArrowLeft, Trophy, Clock } from "lucide-react";

interface RunnerBet {
  id: number;
  selectionId: number;
  selectionName: string;
  layOdds: number;
  layStake: number;
  raceNetIfWins: number;
  actualProfit: number | null;
  status: string;
  placedAt: string;
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

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

export default function BookieBotRace() {
  const [, params] = useRoute("/bookiebot/race/:marketId");
  const marketId = params?.marketId ?? "";

  const { data: bets, isLoading } = useQuery<RunnerBet[]>({
    queryKey: ["bookie-race", marketId],
    queryFn: () => apiFetch(`/bookie/race/${marketId}`),
    enabled: !!marketId,
    refetchInterval: 30_000,
  });

  const { data: races } = useQuery<BookieRace[]>({
    queryKey: ["bookie-races"],
    queryFn: () => apiFetch("/bookie/races"),
  });

  const race    = races?.find(r => r.marketId === marketId);
  const settled = race?.settled ?? false;
  const raceNet = race?.netProfit ?? 0;

  // For a LAY bet: status="LOST" means horse won the race (we paid liability)
  const raceWinner = bets?.find(b => b.status === "LOST");

  // Sort by lay stake descending (biggest stake = most market money = favourite)
  const sorted = bets ? [...bets].sort((a, b) => b.layStake - a.layStake) : [];

  const raceTime = race ? new Date(race.placedAt) : null;

  return (
    <div className="space-y-5 -mt-2">
      {/* Back nav */}
      <div>
        <Link href="/bookiebot">
          <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Bookie Bot
          </button>
        </Link>
      </div>

      {/* Race header */}
      <div className="rounded-xl overflow-hidden border border-white/10 bg-gradient-to-br from-[#001f3f] via-[#00294d] to-[#003a6e] shadow-xl">
        <div className="bg-[#0072bb] px-5 py-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-widest text-white/80">
            Bookie Bot · Volume-Proportional LAY
          </span>
          {raceTime && (
            <span className="text-xs text-white/70 flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              {raceTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {" · "}
              {raceTime.toLocaleDateString([], { day: "numeric", month: "short" })}
            </span>
          )}
        </div>

        <div className="px-5 py-4 flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-2xl font-bold text-white">{race?.eventName ?? "Loading…"}</div>
            <div className="text-sm text-white/50 mt-0.5">{race?.marketName}</div>
          </div>
          <div className="flex flex-wrap gap-6 text-right">
            <div>
              <div className="text-[10px] text-white/40 uppercase tracking-wide">Runners laid</div>
              <div className="text-xl font-bold text-white">{bets?.length ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10px] text-white/40 uppercase tracking-wide">Race net</div>
              <div className={`text-xl font-bold ${
                !settled ? "text-white/40" :
                raceNet > 0 ? "text-emerald-300" :
                raceNet < 0 ? "text-red-300" : "text-white"
              }`}>
                {settled
                  ? `${raceNet >= 0 ? "+" : ""}£${raceNet.toFixed(2)}`
                  : "Pending"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Winner banner — only shown when settled */}
      {settled && raceWinner && (
        <div className={`rounded-xl border px-5 py-4 flex items-center gap-3 ${
          raceNet >= 0
            ? "border-emerald-500/40 bg-emerald-500/10"
            : "border-red-500/30 bg-red-500/8"
        }`}>
          <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
            raceNet >= 0 ? "bg-emerald-500" : "bg-red-500"
          }`}>
            <Trophy className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Race Winner</div>
            <div className="text-base font-bold">{raceWinner.selectionName}</div>
            <div className="text-xs text-muted-foreground">@ {raceWinner.layOdds.toFixed(2)} odds</div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-xs text-muted-foreground mb-0.5">Race net P&L</div>
            <div className={`text-2xl font-bold tabular-nums ${raceNet >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {raceNet >= 0 ? "+" : ""}£{raceNet.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {settled && !raceWinner && (
        <div className="rounded-xl border border-muted px-5 py-4 text-sm text-muted-foreground">
          Race settled — winner not in our lay list.
          Race net: <span className={raceNet >= 0 ? "text-emerald-400 font-bold" : "text-red-400 font-bold"}>
            {raceNet >= 0 ? "+" : ""}£{raceNet.toFixed(2)}
          </span>
        </div>
      )}

      {/* Runner list */}
      <div className="space-y-2">
        <div className="text-xs text-muted-foreground uppercase tracking-wide px-1">
          Runners — sorted by lay stake (biggest = most public money)
        </div>

        {isLoading && (
          <div className="text-sm text-muted-foreground text-center py-10">Loading…</div>
        )}

        {sorted.map(bet => {
          // For LAY: LOST = horse won, WON = horse lost
          const isRaceWinner = bet.status === "LOST";
          const net = bet.raceNetIfWins;
          const isProfit = net >= 0;

          return (
            <div
              key={bet.id}
              className={`rounded-xl border px-4 py-3 flex items-center gap-4 transition-all ${
                isRaceWinner
                  ? raceNet >= 0
                    ? "border-emerald-500/40 bg-emerald-500/5"
                    : "border-red-500/40 bg-red-500/5"
                  : "border-border/50 bg-card/40"
              }`}
            >
              {/* Trophy / rank */}
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${
                isRaceWinner
                  ? raceNet >= 0 ? "bg-emerald-500 text-white" : "bg-red-500 text-white"
                  : "bg-muted text-muted-foreground"
              }`}>
                {isRaceWinner ? <Trophy className="w-3.5 h-3.5" /> : ""}
              </div>

              {/* Name */}
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">{bet.selectionName}</div>
                <div className="text-xs text-muted-foreground">
                  Lay stake £{bet.layStake.toFixed(2)} @ {bet.layOdds.toFixed(2)}
                  {isRaceWinner && (
                    <span className={`ml-2 font-medium ${raceNet >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      — WON THE RACE
                    </span>
                  )}
                </div>
              </div>

              {/* Race net if this horse wins */}
              <div className="text-right flex-shrink-0">
                {settled && isRaceWinner ? (
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Race net</div>
                    <div className={`text-lg font-bold tabular-nums ${raceNet >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {raceNet >= 0 ? "+" : ""}£{raceNet.toFixed(2)}
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">If wins</div>
                    <div className={`text-lg font-bold tabular-nums ${isProfit ? "text-emerald-400" : "text-red-400"}`}>
                      {net >= 0 ? "+" : ""}£{Math.abs(net).toFixed(2)}
                    </div>
                    <div className={`text-[10px] ${isProfit ? "text-emerald-500/60" : "text-red-500/60"}`}>
                      race net
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
