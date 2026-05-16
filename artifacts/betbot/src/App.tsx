import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/Layout";

import Settings from "@/pages/Settings";
import DutchingBot from "@/pages/DutchingBot";
import DutchingBotRace from "@/pages/DutchingBotRace";
import PaperBackFav from "@/pages/PaperBackFav";
import PaperLayShortFav from "@/pages/PaperLayShortFav";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={DutchingBot} />
        <Route path="/dutchingbot/race/:marketId" component={DutchingBotRace} />
        <Route path="/paper/back-fav" component={PaperBackFav} />
        <Route path="/paper/lay-short-fav" component={PaperLayShortFav} />
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
