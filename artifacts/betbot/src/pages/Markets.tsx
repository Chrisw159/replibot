import { useListMarkets } from "@workspace/api-client-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";

export default function Markets() {
  const { data: markets, isLoading } = useListMarkets();
  const [search, setSearch] = useState("");

  const filteredMarkets = markets?.filter(m => 
    m.eventName.toLowerCase().includes(search.toLowerCase()) || 
    m.marketName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <h1 className="text-3xl font-bold tracking-tight">Live Markets</h1>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            placeholder="Search markets..." 
            className="pl-9 bg-card/50 border-border/50"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {isLoading ? (
          Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)
        ) : filteredMarkets?.map(market => (
          <Card key={market.marketId} className="border-border/50 bg-card/50 hover:bg-card/80 transition-colors cursor-pointer">
            <CardContent className="p-5">
              <div className="flex justify-between items-start mb-3">
                <div className="space-y-1">
                  <div className="flex gap-2 items-center">
                    <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">
                      {market.eventTypeName}
                    </Badge>
                    {market.inPlay && (
                      <Badge variant="outline" className="bg-chart-1/10 text-chart-1 border-chart-1/20">
                        In Play
                      </Badge>
                    )}
                  </div>
                  <h3 className="font-bold text-lg line-clamp-1">{market.eventName}</h3>
                  <div className="text-sm text-muted-foreground">{market.marketName}</div>
                </div>
              </div>
              <div className="flex justify-between items-end mt-4 pt-4 border-t border-border/50">
                <div className="text-xs text-muted-foreground space-y-1">
                  <div>Start: {formatDate(market.marketStartTime)}</div>
                  <div>Vol: {formatCurrency(market.totalMatched)}</div>
                </div>
                <div className={`text-xs font-bold px-2 py-1 rounded ${market.status === 'OPEN' ? 'bg-chart-1/20 text-chart-1' : 'bg-muted text-muted-foreground'}`}>
                  {market.status}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {filteredMarkets?.length === 0 && (
          <div className="col-span-full py-12 text-center text-muted-foreground">
            No markets found matching "{search}"
          </div>
        )}
      </div>
    </div>
  );
}
