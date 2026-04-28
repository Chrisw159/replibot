import { useState } from "react";
import { useListStrategies, useDeleteStrategy } from "@workspace/api-client-react";
import type { Strategy } from "@workspace/api-client-react";
import { formatCurrency, formatNumber } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Edit2, Trash2, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListStrategiesQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { StrategyDialog } from "@/components/StrategyDialog";

export default function Strategies() {
  const { data: strategies, isLoading } = useListStrategies();
  const deleteStrategy = useDeleteStrategy();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingStrategy, setEditingStrategy] = useState<Strategy | null>(null);

  const handleNew = () => {
    setEditingStrategy(null);
    setDialogOpen(true);
  };

  const handleEdit = (strategy: Strategy) => {
    setEditingStrategy(strategy);
    setDialogOpen(true);
  };

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to delete this strategy?")) {
      deleteStrategy.mutate({ id }, {
        onSuccess: () => {
          toast({ title: "Strategy deleted" });
          queryClient.invalidateQueries({ queryKey: getListStrategiesQueryKey() });
        }
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">AI Strategies</h1>
        <Button className="gap-2" onClick={handleNew}>
          <Plus className="w-4 h-4" />
          New Strategy
        </Button>
      </div>

      {!isLoading && strategies?.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
          <div className="text-5xl">🤖</div>
          <div>
            <p className="text-xl font-semibold">No strategies yet</p>
            <p className="text-muted-foreground mt-1">Create a strategy to tell the AI what to bet on and how much.</p>
          </div>
          <Button className="gap-2 mt-2" onClick={handleNew}>
            <Plus className="w-4 h-4" />
            Create your first strategy
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {isLoading ? (
          Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-64 w-full rounded-xl" />)
        ) : strategies?.map(strategy => (
          <Card key={strategy.id} className="border-border/50 bg-card/50">
            <CardHeader className="pb-3 border-b border-border/50">
              <div className="flex justify-between items-start">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-xl">{strategy.name}</CardTitle>
                    <Badge variant={strategy.isActive ? "default" : "secondary"} className={strategy.isActive ? "bg-chart-1 text-chart-1-foreground hover:bg-chart-1/90" : ""}>
                      {strategy.isActive ? "Active" : "Inactive"}
                    </Badge>
                    <Badge variant="outline" className="font-mono">
                      {strategy.betType}
                    </Badge>
                  </div>
                  <div className="text-sm text-muted-foreground">{strategy.description || "No description"}</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    onClick={() => handleEdit(strategy)}
                  >
                    <Edit2 className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDelete(strategy.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Min/Max Odds</div>
                  <div className="font-mono text-sm">{formatNumber(strategy.minOdds)} – {formatNumber(strategy.maxOdds)}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Stake</div>
                  <div className="font-mono text-sm">{formatCurrency(strategy.stakeAmount)}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Max Stake</div>
                  <div className="font-mono text-sm">{formatCurrency(strategy.maxStakeAmount)}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Model</div>
                  <div className="font-mono text-sm truncate" title={strategy.aiModel}>{strategy.aiModel}</div>
                </div>
              </div>

              <div className="p-3 bg-muted/30 rounded border border-border/50">
                <div className="text-xs text-muted-foreground mb-1">AI Prompt</div>
                <div className="text-sm font-mono text-foreground/80 line-clamp-2">
                  {strategy.aiPrompt || "No prompt configured"}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <StrategyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        strategy={editingStrategy}
      />
    </div>
  );
}
