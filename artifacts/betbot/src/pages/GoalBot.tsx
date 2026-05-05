import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Square, Zap, Activity, Eye, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface GoalBotStatus {
  isRunning: boolean;
  watchedMarkets: number;
}

interface GoalSignal {
  id: number;
  eventName: string;
  marketName: string;
  homeTeam: string | null;
  awayTeam: string | null;
  signalType: string;
  triggerDescription: string;
  oddsMovePct: number | null;
  oddsBeforeMove: number | null;
  oddsAfterMove: number | null;
  affectedSelection: string | null;
  marketSuspended: boolean;
  confirmed: boolean;
  secondsIntoMatch: number | null;
  totalMatched: number | null;
  createdAt: string;
}

function formatMinutes(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function SignalTypeBadge({ type, confirmed, suspended }: { type: string; confirmed: boolean; suspended: boolean }) {
  if (type === "GOAL_DETECTED" || confirmed) {
    return <Badge className="bg-green-500/20 text-green-400 border-green-500/30 gap-1"><CheckCircle2 className="w-3 h-3" />Goal Detected</Badge>;
  }
  if (suspended) {
    return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 gap-1"><AlertTriangle className="w-3 h-3" />Suspended</Badge>;
  }
  return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 gap-1"><Zap className="w-3 h-3" />Odds Spike</Badge>;
}

export default function GoalBot() {
  const [status, setStatus] = useState<GoalBotStatus | null>(null);
  const [signals, setSignals] = useState<GoalSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const { toast } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/goalbot/status");
      if (res.ok) setStatus(await res.json());
    } catch { /* silent */ }
  }, []);

  const fetchSignals = useCallback(async () => {
    try {
      const res = await fetch("/api/goalbot/signals?limit=100");
      if (res.ok) setSignals(await res.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    Promise.all([fetchStatus(), fetchSignals()]).finally(() => setLoading(false));
    const statusInterval = setInterval(fetchStatus, 3000);
    const signalsInterval = setInterval(fetchSignals, 3000);
    return () => { clearInterval(statusInterval); clearInterval(signalsInterval); };
  }, [fetchStatus, fetchSignals]);

  const handleStart = async () => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/goalbot/start", { method: "POST" });
      if (res.ok) {
        toast({ title: "Goal detector started" });
        await fetchStatus();
      }
    } finally { setActionLoading(false); }
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/goalbot/stop", { method: "POST" });
      if (res.ok) {
        toast({ title: "Goal detector stopped" });
        await fetchStatus();
      }
    } finally { setActionLoading(false); }
  };

  const isRunning = status?.isRunning ?? false;
  const goalCount = signals.filter(s => s.signalType === "GOAL_DETECTED" || s.confirmed).length;
  const spikeCount = signals.filter(s => s.signalType === "ODDS_SPIKE" && !s.confirmed).length;
  const watchCount = status?.watchedMarkets ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Goal Bot</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Monitors live football markets for goal signals via Betfair in-play odds
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isRunning ? (
            <Button variant="destructive" onClick={handleStop} disabled={actionLoading}>
              <Square className="w-4 h-4 mr-2" />
              Stop Detector
            </Button>
          ) : (
            <Button onClick={handleStart} disabled={actionLoading}>
              <Play className="w-4 h-4 mr-2" />
              Start Detector
            </Button>
          )}
        </div>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${isRunning ? "bg-green-400 animate-pulse" : "bg-muted-foreground"}`} />
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <p className="font-semibold">{isRunning ? "Running" : "Stopped"}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Eye className="w-5 h-5 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">Watching</p>
                <p className="font-semibold">{watchCount} match{watchCount !== 1 ? "es" : ""}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
              <div>
                <p className="text-xs text-muted-foreground">Goals Detected</p>
                <p className="font-semibold">{goalCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5 text-blue-400" />
              <div>
                <p className="text-xs text-muted-foreground">Odds Spikes</p>
                <p className="font-semibold">{spikeCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* How it works */}
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="w-4 h-4" />
            How the signal detector works
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            <span className="text-foreground font-medium">Every 2.5 seconds</span>, the detector polls all live in-play football Match Odds markets on Betfair.
          </p>
          <p>
            It watches for two signals: <span className="text-foreground font-medium">market suspension</span> (Betfair suspends markets the instant a goal is scored) and{" "}
            <span className="text-foreground font-medium">sharp price drops</span> (a team's odds collapsing ≥25% means they likely just scored).
          </p>
          <p>
            A <span className="text-green-400 font-medium">Goal Detected</span> signal fires when a suspension is combined with a price move — high confidence. A{" "}
            <span className="text-blue-400 font-medium">pure Odds Spike</span> is a sharp move without suspension — possible early signal.
          </p>
          <p className="text-yellow-500/80">
            This is the validation phase — all signals are logged here. Once the detector is reliable, Polymarket execution will be added on top.
          </p>
        </CardContent>
      </Card>

      {/* Signals feed */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Signal Feed
            <span className="ml-auto text-xs font-normal text-muted-foreground">Last 24 hours · auto-refreshes</span>
          </CardTitle>
          <CardDescription>
            {loading ? "Loading…" : signals.length === 0
              ? isRunning
                ? "Waiting for live matches — signals will appear here when goals are detected"
                : "Start the detector to begin monitoring live matches"
              : `${signals.length} signal${signals.length !== 1 ? "s" : ""} captured`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {signals.length === 0 && !loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-3">
              <Activity className="w-10 h-10 opacity-20" />
              <p className="text-sm">No signals yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {signals.map(signal => (
                <div
                  key={signal.id}
                  className="flex flex-col sm:flex-row sm:items-start gap-3 p-3 rounded-lg border bg-card/50 text-sm"
                >
                  <div className="flex items-center gap-2 sm:flex-col sm:items-start sm:w-32 flex-shrink-0">
                    <SignalTypeBadge type={signal.signalType} confirmed={signal.confirmed} suspended={signal.marketSuspended} />
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />{formatTime(signal.createdAt)}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{signal.eventName}</p>
                    <p className="text-muted-foreground text-xs">{signal.marketName}</p>
                    <p className="text-xs mt-1 text-foreground/80">{signal.triggerDescription}</p>
                  </div>

                  <div className="flex sm:flex-col gap-3 sm:gap-1 sm:text-right text-xs flex-shrink-0">
                    {signal.secondsIntoMatch != null && (
                      <span className="text-muted-foreground">
                        ⏱ {formatMinutes(signal.secondsIntoMatch)}
                      </span>
                    )}
                    {signal.oddsMovePct != null && (
                      <span className="text-red-400 font-mono">
                        −{signal.oddsMovePct.toFixed(1)}%
                      </span>
                    )}
                    {signal.oddsBeforeMove != null && signal.oddsAfterMove != null && (
                      <span className="text-muted-foreground font-mono">
                        {signal.oddsBeforeMove.toFixed(2)} → {signal.oddsAfterMove.toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
