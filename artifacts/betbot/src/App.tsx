import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/Layout";

// Pages
import Dashboard from "@/pages/Dashboard";
import Markets from "@/pages/Markets";
import Strategies from "@/pages/Strategies";
import Bets from "@/pages/Bets";
import BotControl from "@/pages/BotControl";
import Settings from "@/pages/Settings";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/markets" component={Markets} />
        <Route path="/strategies" component={Strategies} />
        <Route path="/bets" component={Bets} />
        <Route path="/bot" component={BotControl} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
