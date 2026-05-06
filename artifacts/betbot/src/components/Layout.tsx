import { Link, useLocation } from "wouter";
import { useGetBotStatus, useGetBotConfig, getGetBotStatusQueryKey } from "@workspace/api-client-react";
import { 
  Activity, 
  BarChart2, 
  Settings, 
  Target, 
  List, 
  TrendingUp,
  Power,
  PowerOff,
  Zap,
  Scale,
  Layers,
} from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: botStatus } = useGetBotStatus({ query: { refetchInterval: 5000, queryKey: getGetBotStatusQueryKey() } });
  const { data: config } = useGetBotConfig();

  const isRunning = botStatus?.isRunning;
  const isPaperTrading = botStatus?.paperTradingMode || config?.paperTradingMode;

  const navItems = [
    { href: "/", label: "Dashboard", icon: BarChart2 },
    { href: "/markets", label: "Markets", icon: Activity },
    { href: "/strategies", label: "Strategies", icon: Target },
    { href: "/bets", label: "Bets", icon: List },
    { href: "/bot", label: "Bot Control", icon: TrendingUp },
    { href: "/goalbot", label: "Goal Bot", icon: Zap },
    { href: "/bookiebot", label: "Bookie Bot", icon: Scale },
    { href: "/dutchingbot", label: "Dutching Bot", icon: Layers },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background text-foreground">
      {/* Sidebar */}
      <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-sidebar-border bg-sidebar flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-sidebar-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground font-bold">
              RB
            </div>
            <span className="font-bold text-lg tracking-tight">REPLIBOT</span>
          </div>
          {isPaperTrading && (
            <div className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-chart-2/20 text-chart-2 border border-chart-2/30">
              Paper
            </div>
          )}
        </div>
        
        <div className="p-4 flex-1 overflow-y-auto">
          <nav className="space-y-1">
            {navItems.map((item) => {
              const active = location === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    active 
                      ? "bg-sidebar-primary/10 text-sidebar-primary" 
                      : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-sidebar-border">
          <div className="flex items-center justify-between p-3 rounded-md bg-card border border-card-border">
            <div className="flex items-center gap-2">
              {isRunning ? (
                <Power className="w-4 h-4 text-chart-1" />
              ) : (
                <PowerOff className="w-4 h-4 text-muted-foreground" />
              )}
              <span className="text-sm font-medium">
                {isRunning ? "Bot Active" : "Bot Stopped"}
              </span>
            </div>
            <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-chart-1 animate-pulse" : "bg-muted-foreground"}`} />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
