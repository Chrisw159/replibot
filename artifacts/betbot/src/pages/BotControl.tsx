import { useGetBotConfig, useUpdateBotConfig, useGetBotStatus, useStartBot, useStopBot, useGetBotLogs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import { getGetBotConfigQueryKey, getGetBotStatusQueryKey, getGetBotLogsQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Play, Square, AlertTriangle, Activity, Settings2 } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";

export default function BotControl() {
  const { data: config, isLoading: loadingConfig } = useGetBotConfig();
  const { data: status, isLoading: loadingStatus } = useGetBotStatus({ query: { refetchInterval: 5000, queryKey: getGetBotStatusQueryKey() } });
  const { data: logs, isLoading: loadingLogs } = useGetBotLogs({ limit: 50 }, { query: { refetchInterval: 5000, queryKey: getGetBotLogsQueryKey({ limit: 50 }) } });
  
  const startBot = useStartBot();
  const stopBot = useStopBot();
  const updateConfig = useUpdateBotConfig();
  
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleStart = () => {
    startBot.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Bot started successfully" });
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
      }
    });
  };

  const handleStop = () => {
    stopBot.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Bot stopped successfully" });
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
      }
    });
  };

  const handleTogglePaperTrading = (checked: boolean) => {
    updateConfig.mutate({ data: { paperTradingMode: checked } }, {
      onSuccess: () => {
        toast({ title: `Paper trading ${checked ? 'enabled' : 'disabled'}` });
        queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
      }
    });
  };

  const handleUpdateLimit = (e: React.FocusEvent<HTMLInputElement>, field: string) => {
    const val = parseFloat(e.target.value);
    if (isNaN(val)) return;
    
    updateConfig.mutate({ data: { [field]: val } }, {
      onSuccess: () => {
        toast({ title: "Configuration updated" });
        queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
      }
    });
  };

  const isRunning = status?.isRunning || config?.isRunning;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Bot Engine</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Control Panel */}
        <Card className="lg:col-span-1 border-border/50 bg-card/50 backdrop-blur flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              Engine Status
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col">
            <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-6">
              <div className={`w-32 h-32 rounded-full flex items-center justify-center border-4 ${isRunning ? 'border-chart-1 text-chart-1 shadow-[0_0_30px_rgba(var(--chart-1),0.2)]' : 'border-muted text-muted-foreground'}`}>
                {isRunning ? <Play className="w-12 h-12 ml-2" /> : <Square className="w-12 h-12" />}
              </div>
              
              <div className="text-center space-y-1">
                <div className="text-xl font-bold">{isRunning ? 'SYSTEM ACTIVE' : 'SYSTEM HALTED'}</div>
                <div className="text-sm text-muted-foreground">
                  {status?.startedAt ? `Uptime since ${formatDate(status.startedAt)}` : 'Ready to start'}
                </div>
              </div>

              <div className="w-full flex gap-3">
                <Button 
                  className={`flex-1 h-12 text-lg font-bold ${!isRunning ? 'bg-chart-1 hover:bg-chart-1/90 text-chart-1-foreground' : 'bg-muted text-muted-foreground opacity-50 cursor-not-allowed'}`}
                  onClick={handleStart}
                  disabled={isRunning || startBot.isPending}
                >
                  START
                </Button>
                <Button 
                  variant="destructive" 
                  className={`flex-1 h-12 text-lg font-bold ${isRunning ? 'bg-chart-4 hover:bg-chart-4/90' : 'opacity-50 cursor-not-allowed'}`}
                  onClick={handleStop}
                  disabled={!isRunning || stopBot.isPending}
                >
                  STOP
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-6 pt-6 border-t border-border/50">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Bets Today</div>
                <div className="text-2xl font-mono">{status?.betsPlacedToday || 0}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Session P&L</div>
                <div className={`text-2xl font-mono ${status?.profitToday && status.profitToday > 0 ? 'text-chart-1' : status?.lossToday && status.lossToday > 0 ? 'text-chart-4' : ''}`}>
                  {formatCurrency((status?.profitToday || 0) - (status?.lossToday || 0))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Settings & Logs */}
        <div className="lg:col-span-2 space-y-6 flex flex-col">
          <Card className="border-border/50 bg-card/50">
            <CardHeader className="pb-4 border-b border-border/50">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Settings2 className="w-4 h-4 text-primary" />
                Runtime Parameters
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="space-y-6">
                  <div className="flex items-center justify-between p-3 rounded bg-muted/30 border border-border/50">
                    <div className="space-y-0.5">
                      <Label className="text-base">Paper Trading</Label>
                      <div className="text-sm text-muted-foreground">Simulate bets without real money</div>
                    </div>
                    <Switch 
                      checked={config?.paperTradingMode || false} 
                      onCheckedChange={handleTogglePaperTrading}
                    />
                  </div>
                  
                  <div className="space-y-3">
                    <Label className="text-sm text-muted-foreground flex items-center gap-2">
                      <AlertTriangle className="w-3 h-3 text-chart-2" />
                      Daily Loss Limit (£)
                    </Label>
                    <Input 
                      type="number" 
                      defaultValue={config?.dailyLossLimit} 
                      onBlur={(e) => handleUpdateLimit(e, 'dailyLossLimit')}
                      className="font-mono bg-card/50 border-border/50 text-lg"
                    />
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="space-y-3">
                    <Label className="text-sm text-muted-foreground">Poll Interval (seconds)</Label>
                    <Input 
                      type="number" 
                      defaultValue={config?.checkIntervalSeconds} 
                      onBlur={(e) => handleUpdateLimit(e, 'checkIntervalSeconds')}
                      className="font-mono bg-card/50 border-border/50 text-lg"
                    />
                  </div>
                  
                  <div className="space-y-3">
                    <Label className="text-sm text-muted-foreground">Max Concurrent Bets</Label>
                    <Input 
                      type="number" 
                      defaultValue={config?.maxConcurrentBets} 
                      onBlur={(e) => handleUpdateLimit(e, 'maxConcurrentBets')}
                      className="font-mono bg-card/50 border-border/50 text-lg"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="flex-1 border-border/50 bg-card/50 flex flex-col min-h-[300px]">
            <CardHeader className="pb-3 border-b border-border/50">
              <CardTitle className="text-sm font-medium text-muted-foreground">System Console</CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex-1 relative">
              <div className="absolute inset-0 overflow-y-auto p-4 font-mono text-xs space-y-2 bg-[#0A0D14] text-gray-300">
                {loadingLogs ? <Skeleton className="w-full h-full opacity-10" /> : (
                  logs?.map(log => (
                    <div key={log.id} className="flex gap-3">
                      <span className="text-gray-500 flex-shrink-0">[{formatDate(log.createdAt).split(', ')[1]}]</span>
                      <span className={`font-bold flex-shrink-0 w-12 ${
                        log.level.toUpperCase() === 'ERROR' ? 'text-red-500' : 
                        log.level.toUpperCase() === 'WARN' ? 'text-yellow-500' : 
                        log.level.toUpperCase() === 'INFO' ? 'text-blue-400' : 'text-gray-400'
                      }`}>
                        {log.level}
                      </span>
                      <span className="break-words">{log.message}</span>
                    </div>
                  ))
                )}
                {!logs?.length && !loadingLogs && (
                  <div className="text-gray-600">Waiting for system logs...</div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
